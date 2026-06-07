import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

async function migrate(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const sql = fs.readFileSync(
      path.join(__dirname, '../../migrations/001_initial.sql'),
      'utf-8'
    );

    // Run DDL (CREATE TABLE / INDEX) only — skip ALTER SYSTEM on managed DB
    const ddlOnly = sql
      .split('\n')
      .filter(line => !line.startsWith('ALTER SYSTEM') && !line.startsWith('SELECT pg_reload'))
      .join('\n');

    await pool.query(ddlOnly);
    console.log('[migrate] Schema applied successfully.');
  } finally {
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('[migrate] Fatal:', err.message);
  process.exit(1);
});
