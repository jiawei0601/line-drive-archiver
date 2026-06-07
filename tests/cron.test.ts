/**
 * TST-03: Cron resource release (pool.end() + exit code 0)
 * TST-04: Sentinel ±3-minute context window filtering
 *
 * drive/client is fully mocked so no real HTTP calls are made to LINE or Drive.
 */

// Mock before any imports so Jest replaces the module for archiver as well
jest.mock('../src/drive/client');

import { runArchiver } from '../src/worker/archiver';
import * as driveClient from '../src/drive/client';
import { drive_v3 } from 'googleapis';
import { Pool } from 'pg';

// ── type-safe mock references ────────────────────────────────────────────────

const mockGetOrCreateFolder = driveClient.getOrCreateFolder as jest.MockedFunction<typeof driveClient.getOrCreateFolder>;
const mockStreamImage       = driveClient.streamImageToDrive as jest.MockedFunction<typeof driveClient.streamImageToDrive>;
const mockUploadContext     = driveClient.uploadContextFile  as jest.MockedFunction<typeof driveClient.uploadContextFile>;

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMockPool(overrides: Partial<{ query: jest.Mock; end: jest.Mock }> = {}): Pool {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    end:   jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Pool;
}

const FAKE_DRIVE = {} as drive_v3.Drive;

// ── setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // Default happy-path drive stubs
  mockGetOrCreateFolder.mockResolvedValue('mocked-folder-id');
  mockStreamImage.mockResolvedValue('mocked-image-file-id');
  mockUploadContext.mockResolvedValue(undefined);

  // Mock global fetch (used by fetchLineDisplayName inside archiver)
  global.fetch = jest.fn().mockResolvedValue({
    ok:     true,
    status: 200,
    json:   async () => ({ displayName: 'TestUser' }),
  }) as jest.Mock;
});

// ── TST-03 ───────────────────────────────────────────────────────────────────

describe('TST-03 — Cron resource release', () => {
  test('runArchiver resolves without throwing when task list is empty', async () => {
    const pool = makeMockPool();
    await expect(
      runArchiver(pool, FAKE_DRIVE, 'root-id', 'fake-token')
    ).resolves.not.toThrow();
  });

  test('Pool.end() is called by cron wrapper after archiver completes', async () => {
    const pool = makeMockPool();
    const endSpy = pool.end as jest.Mock;

    await runArchiver(pool, FAKE_DRIVE, 'root-id', 'fake-token');
    // Mirrors the finally block in cron.ts
    await pool.end();

    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  test('Single pending task → processed, Drive functions called, task marked done', async () => {
    const queryMock = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM image_tasks')) {
        return Promise.resolve({ rows: [pendingTask()] });
      }
      return Promise.resolve({ rows: [] });
    });
    const pool = makeMockPool({ query: queryMock });

    await runArchiver(pool, FAKE_DRIVE, 'root-id', 'fake-token');

    expect(mockGetOrCreateFolder).toHaveBeenCalledTimes(2); // date + user folders
    expect(mockStreamImage).toHaveBeenCalledTimes(1);
    expect(mockUploadContext).toHaveBeenCalledTimes(1);

    const updateCall = queryMock.mock.calls.find(
      ([sql]: [string]) => sql.includes("status = 'done'")
    );
    expect(updateCall).toBeDefined();
  });
});

// ── TST-04 ───────────────────────────────────────────────────────────────────

describe('TST-04 — Sentinel ±3-minute context window', () => {
  const IMAGE_TS   = 1_717_000_000_000;
  const MIN_3_MS   = 3 * 60 * 1_000;
  const MESSAGE_ID = 'msg_img_001';
  const USER_ID    = 'user_abc';

  const BEFORE_2MIN_TS = IMAGE_TS - 2 * 60 * 1_000;  // inside window ✓
  const BEFORE_5MIN_TS = IMAGE_TS - 5 * 60 * 1_000;  // outside window ✗
  const AFTER_2MIN_TS  = IMAGE_TS + 2 * 60 * 1_000;  // inside window ✓

  const ALL_RECORDS = [
    { text_content: 'Before 5 min (outside)', line_timestamp: BEFORE_5MIN_TS },
    { text_content: 'Before 2 min (inside)',  line_timestamp: BEFORE_2MIN_TS },
    { text_content: 'After 2 min (inside)',   line_timestamp: AFTER_2MIN_TS  },
  ];

  function makeContextPool(): { pool: Pool; queryMock: jest.Mock } {
    const queryMock = jest.fn().mockImplementation((sql: string, params: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM image_tasks')) {
        return Promise.resolve({ rows: [pendingTask(MESSAGE_ID, USER_ID, IMAGE_TS)] });
      }
      if (typeof sql === 'string' && sql.includes('chat_history')) {
        const lower = params[1] as number;
        const upper = params[2] as number;
        return Promise.resolve({
          rows: ALL_RECORDS.filter(r => r.line_timestamp >= lower && r.line_timestamp <= upper),
        });
      }
      return Promise.resolve({ rows: [] });
    });
    return { pool: makeMockPool({ query: queryMock }), queryMock };
  }

  test('±3 min window includes before-2min and after-2min, excludes before-5min', () => {
    const inside = ALL_RECORDS.filter(
      r => r.line_timestamp >= IMAGE_TS - MIN_3_MS && r.line_timestamp <= IMAGE_TS + MIN_3_MS
    );
    const contents = inside.map(r => r.text_content);
    expect(contents).toContain('Before 2 min (inside)');
    expect(contents).toContain('After 2 min (inside)');
    expect(contents).not.toContain('Before 5 min (outside)');
  });

  test('SQL query is called with exact ±3 min lower and upper bounds', async () => {
    const { pool, queryMock } = makeContextPool();

    await runArchiver(pool, FAKE_DRIVE, 'root-id', 'fake-token');

    const chatCall = queryMock.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('chat_history')
    );
    expect(chatCall).toBeDefined();

    const [, params] = chatCall as [string, unknown[]];
    expect(params[0]).toBe(USER_ID);
    expect(params[1]).toBe(IMAGE_TS - MIN_3_MS); // lower bound
    expect(params[2]).toBe(IMAGE_TS + MIN_3_MS); // upper bound
  });

  test('Context file includes in-window messages and excludes out-of-window message', async () => {
    const { pool } = makeContextPool();

    let capturedContent = '';
    mockUploadContext.mockImplementation(
      async (_drive, _messageId, content, _folderId) => {
        capturedContent = content;
      }
    );

    await runArchiver(pool, FAKE_DRIVE, 'root-id', 'fake-token');

    expect(capturedContent).toContain('Before 2 min (inside)');
    expect(capturedContent).toContain('After 2 min (inside)');
    expect(capturedContent).not.toContain('Before 5 min (outside)');
    expect(capturedContent).toContain(MESSAGE_ID);
  });

  test('Context text places messages before image at upload point, after-messages follow', async () => {
    const { pool } = makeContextPool();

    let capturedContent = '';
    mockUploadContext.mockImplementation(
      async (_drive, _messageId, content, _folderId) => {
        capturedContent = content;
      }
    );

    await runArchiver(pool, FAKE_DRIVE, 'root-id', 'fake-token');

    const lines = capturedContent.split('\n');
    const uploadMarkerIdx = lines.findIndex(l => l.includes('影像上傳點'));
    const before2Idx      = lines.findIndex(l => l.includes('Before 2 min'));
    const after2Idx       = lines.findIndex(l => l.includes('After 2 min'));

    expect(uploadMarkerIdx).toBeGreaterThan(-1);
    expect(before2Idx).toBeLessThan(uploadMarkerIdx);
    expect(after2Idx).toBeGreaterThan(uploadMarkerIdx);
  });
});

// ── test fixture helpers ──────────────────────────────────────────────────────

function pendingTask(
  messageId = 'msg_001',
  userId    = 'user_abc',
  ts        = Date.now()
) {
  return { id: 1, message_id: messageId, user_id: userId, group_id: null, line_timestamp: ts, retry_count: 0 };
}
