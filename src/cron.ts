/**
 * CRN-MOD: Short-lived Railway Cron worker entry point.
 *
 * Railway Cron constraints (SRS §3.4.1):
 * - Process MUST exit with code 0 after completion.
 * - Any unclosed connection pool will cause Railway to skip subsequent runs.
 * - UTC timezone: 0 19 * * * = Taipei time 03:00.
 */
import { getPool, closePool } from './db/pool';
import { createDriveClient } from './drive/client';
import { runArchiver } from './worker/archiver';

async function main(): Promise<void> {
  console.log('[cron] Photo backup worker started.');

  const pool = getPool();
  const drive = createDriveClient(
    JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS!)
  );
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID!;
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

  try {
    await runArchiver(pool, drive, rootFolderId, accessToken);
    console.log('[cron] Archiving complete.');
  } catch (err) {
    console.error('[cron] Fatal error:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    // MUST close pool before exit — unclosed pool causes Railway to skip next run (SRS §3.4.1)
    await closePool();
    console.log('[cron] Connection pool closed. Exiting.');
    process.exit(process.exitCode ?? 0);
  }
}

main();
