import { Pool } from 'pg';
import { drive_v3 } from 'googleapis';
import { getOrCreateFolder, streamImageToDrive, uploadContextFile } from '../drive/client';

const CONTEXT_WINDOW_MS = 3 * 60 * 1000; // ±3 minutes in milliseconds

interface ImageTask {
  id: number;
  message_id: string;
  user_id: string;
  group_id: string | null;
  line_timestamp: number;
  retry_count: number;
}

interface ChatRecord {
  text_content: string;
  line_timestamp: number;
}

/**
 * Main entry: processes all pending image tasks, archives to Google Drive,
 * records sentinel context text file alongside each image (SRS §6.3.2).
 */
export async function runArchiver(
  pool: Pool,
  drive: drive_v3.Drive,
  rootFolderId: string,
  accessToken: string
): Promise<void> {
  const tasks = await fetchPendingTasks(pool);
  console.log(`[archiver] Processing ${tasks.length} pending task(s).`);

  for (const task of tasks) {
    await processTask(pool, drive, rootFolderId, accessToken, task);
  }
}

async function processTask(
  pool: Pool,
  drive: drive_v3.Drive,
  rootFolderId: string,
  accessToken: string,
  task: ImageTask
): Promise<void> {
  try {
    const displayName = await fetchLineDisplayName(task.user_id, accessToken, task.group_id);
    const uploadDate = msToDateString(task.line_timestamp);

    // Idempotent two-level folder: root / YYYY-MM-DD / displayName (SRS §6.3.2)
    const dateFolderId = await withRetry(() =>
      getOrCreateFolder(drive, uploadDate, rootFolderId)
    );
    const userFolderId = await withRetry(() =>
      getOrCreateFolder(drive, displayName, dateFolderId)
    );

    // Stream image directly from LINE to Drive — no RAM buffer (SRS §6.3.2)
    await withRetry(() =>
      streamImageToDrive(drive, task.message_id, accessToken, userFolderId)
    );

    // Retrieve sentinel context (±3 min) and upload as companion text file
    const context = await fetchContextWindow(pool, task);
    const contextText = formatContextText(task.message_id, uploadDate, displayName, context, task.line_timestamp);
    await withRetry(() =>
      uploadContextFile(drive, task.message_id, contextText, userFolderId)
    );

    await markTaskDone(pool, task.id);
    console.log(`[archiver] Done: ${task.message_id}`);
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;

    if (code === 404 || (err as Error).message === 'NOT_FOUND') {
      if (task.group_id) {
        // In group context: 404 means the user left the group or the content expired.
        // NOT a permanent block — mark as failed and stop retrying to avoid wasted quota.
        await pool.query(
          `UPDATE image_tasks SET status = 'failed', updated_at = NOW() WHERE id = $1`,
          [task.id]
        );
        console.warn(`[archiver] 404 in group context for task ${task.message_id} (user left or content expired), marked as failed.`);
      } else {
        // In DM context: 404 means the user blocked the bot — stop retrying permanently.
        await pool.query(
          `UPDATE image_tasks SET status = 'blocked', updated_at = NOW() WHERE id = $1`,
          [task.id]
        );
        console.warn(`[archiver] Blocked user for task ${task.message_id}, marked as blocked.`);
      }
      return;
    }

    await pool.query(
      `UPDATE image_tasks
         SET status = 'pending', retry_count = retry_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [task.id]
    );
    console.error(`[archiver] Error on task ${task.message_id}:`, (err as Error).message);
  }
}

async function fetchPendingTasks(pool: Pool): Promise<ImageTask[]> {
  const res = await pool.query<ImageTask>(
    `SELECT id, message_id, user_id, group_id, line_timestamp, retry_count
     FROM image_tasks
     WHERE status = 'pending'
     ORDER BY line_timestamp ASC`
  );
  return res.rows;
}

/**
 * Retrieves chat messages within ±3 minutes of the image upload timestamp (SRS §6.3.2).
 */
async function fetchContextWindow(pool: Pool, task: ImageTask): Promise<ChatRecord[]> {
  const lower = task.line_timestamp - CONTEXT_WINDOW_MS;
  const upper = task.line_timestamp + CONTEXT_WINDOW_MS;

  const res = await pool.query<ChatRecord>(
    `SELECT text_content, line_timestamp
     FROM chat_history
     WHERE user_id = $1
       AND line_timestamp >= $2
       AND line_timestamp <= $3
     ORDER BY line_timestamp ASC`,
    [task.user_id, lower, upper]
  );
  return res.rows;
}

/**
 * Formats the sentinel context file, interleaving text messages around the image
 * upload point in chronological order (SRS §6.3.2).
 */
function formatContextText(
  messageId: string,
  uploadDate: string,
  displayName: string,
  records: ChatRecord[],
  imageTimestamp: number
): string {
  const lines: string[] = [
    '=== 哨兵對話上下文備份系統 ===',
    `照片 ID: ${messageId}`,
    `上傳時間: ${uploadDate}`,
    `上傳者暱稱: ${displayName}`,
    '',
  ];

  for (const record of records) {
    if (record.line_timestamp <= imageTimestamp) {
      lines.push(`使用者: (傳送文字) ${record.text_content}`);
    }
  }

  lines.push(`使用者: (此處為影像上傳點 ${messageId}.jpg)`);

  for (const record of records) {
    if (record.line_timestamp > imageTimestamp) {
      lines.push(`使用者: (傳送文字) ${record.text_content}`);
    }
  }

  return lines.join('\n');
}

async function markTaskDone(pool: Pool, taskId: number): Promise<void> {
  await pool.query(
    `UPDATE image_tasks SET status = 'done', updated_at = NOW() WHERE id = $1`,
    [taskId]
  );
}

/**
 * Fetches display name using the correct endpoint based on context:
 * - Group message → /group/{groupId}/member/{userId}  (no friend relationship needed)
 * - Direct message → /profile/{userId}                (requires friend)
 */
async function fetchLineDisplayName(
  userId: string,
  accessToken: string,
  groupId?: string | null
): Promise<string> {
  const url = groupId
    ? `https://api.line.me/v2/bot/group/${groupId}/member/${userId}`
    : `https://api.line.me/v2/bot/profile/${userId}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 404) throw Object.assign(new Error('NOT_FOUND'), { code: 404 });
  if (!res.ok) throw new Error(`LINE_PROFILE_HTTP_${res.status}`);
  const data = (await res.json()) as { displayName: string };
  return data.displayName;
}

/**
 * Exponential backoff with random jitter for LINE API 429 responses (SRS §4.2.1).
 * delay = 2^n + random(0, 1) seconds
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 4): Promise<T> {
  let lastErr!: Error;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err as Error;
      const code = (err as { code?: number; status?: number }).code
        ?? (err as { status?: number }).status;
      if (code === 429) {
        const delay = (Math.pow(2, attempt) + Math.random()) * 1000;
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function msToDateString(ms: number): string {
  return new Date(ms).toISOString().split('T')[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
