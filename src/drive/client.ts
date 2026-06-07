import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';
import https from 'https';

export function createDriveClient(credentials: object): drive_v3.Drive {
  const auth = new google.auth.GoogleAuth({
    credentials,
    // Full CRUD scope required (SRS §3.3.1)
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

/**
 * Idempotent folder creation: checks for existing folder first, then uses
 * pre-generated ID so concurrent retries resolve to the same folder (SRS §3.3.2).
 */
export async function getOrCreateFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId: string
): Promise<string> {
  // Check whether folder already exists before attempting creation
  const existing = await drive.files.list({
    q: `'${parentId}' in parents and name = '${escapeDriveQuery(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
  });

  if (existing.data.files?.length) {
    return existing.data.files[0].id!;
  }

  // Pre-generate ID for idempotent creation under concurrent retries (SRS §3.3.2)
  const idsRes = await drive.files.generateIds({ count: 1, space: 'drive' });
  const fileId = idsRes.data.ids![0];

  try {
    await drive.files.create({
      requestBody: {
        id: fileId,
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id',
    });
    return fileId;
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    // 409 Conflict means another concurrent request already created it (SRS §3.3.2)
    if (code === 409) return fileId;
    throw err;
  }
}

/**
 * Downloads image from LINE API and pipes the stream directly to Google Drive —
 * no full buffer in memory to prevent OOM under concurrent uploads (SRS §6.3.2).
 */
export async function streamImageToDrive(
  drive: drive_v3.Drive,
  messageId: string,
  accessToken: string,
  folderId: string
): Promise<string> {
  const imageStream = await fetchLineContent(messageId, accessToken);

  const res = await drive.files.create({
    requestBody: {
      name: `${messageId}.jpg`,
      parents: [folderId],
      mimeType: 'image/jpeg',
    },
    media: {
      mimeType: 'image/jpeg',
      body: imageStream,
    },
    fields: 'id',
  });
  return res.data.id!;
}

/**
 * Uploads formatted context text to Google Drive as text/plain (SRS §6.3.2).
 */
export async function uploadContextFile(
  drive: drive_v3.Drive,
  messageId: string,
  content: string,
  folderId: string
): Promise<void> {
  await drive.files.create({
    requestBody: {
      name: `${messageId}_context.txt`,
      parents: [folderId],
      mimeType: 'text/plain',
    },
    media: {
      mimeType: 'text/plain',
      body: Readable.from([content]),
    },
    fields: 'id',
  });
}

function fetchLineContent(messageId: string, accessToken: string): Promise<Readable> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api-data.line.me',
      path: `/v2/bot/message/${messageId}/content`,
      headers: { Authorization: `Bearer ${accessToken}` },
    };

    https.get(options, (res) => {
      if (res.statusCode === 404) {
        reject(Object.assign(new Error('NOT_FOUND'), { code: 404 }));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`LINE_HTTP_${res.statusCode}`));
        return;
      }
      resolve(res);
    }).on('error', reject);
  });
}

function escapeDriveQuery(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
