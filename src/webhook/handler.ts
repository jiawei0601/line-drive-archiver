import { Pool } from 'pg';

interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}

interface LineEvent {
  type: string;
  timestamp: number;
  source: { type: string; userId?: string; groupId?: string };
  message?: { id: string; type: string; text?: string };
  replyToken?: string;
}

/**
 * Dual-track ledger: text → chat_history sentinel, image → image_tasks queue.
 * Returns immediately after DB writes; downstream worker handles async archiving.
 */
export async function handleWebhookEvents(
  body: LineWebhookBody,
  pool: Pool
): Promise<void> {
  for (const event of body.events) {
    if (event.type !== 'message' || !event.message) continue;

    const userId = event.source.userId ?? 'unknown';
    const groupId = event.source.groupId ?? null;

    if (event.message.type === 'text' && event.message.text) {
      await pool.query(
        `INSERT INTO chat_history
           (message_id, user_id, group_id, text_content, line_timestamp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (message_id) DO NOTHING`,
        [event.message.id, userId, groupId, event.message.text, event.timestamp]
      );
    } else if (event.message.type === 'image') {
      await pool.query(
        `INSERT INTO image_tasks
           (message_id, user_id, group_id, line_timestamp, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (message_id) DO NOTHING`,
        [event.message.id, userId, groupId, event.timestamp]
      );
    }
  }
}
