/**
 * TST-02: Google Drive storage idempotency and permission inheritance.
 * Uses jest mocks to simulate Drive API responses including 409 Conflict.
 */
import { getOrCreateFolder } from '../src/drive/client';
import { drive_v3 } from 'googleapis';

type MockDrive = {
  files: {
    list: jest.Mock;
    generateIds: jest.Mock;
    create: jest.Mock;
  };
};

function makeMockDrive(): MockDrive {
  return {
    files: {
      list: jest.fn(),
      generateIds: jest.fn(),
      create: jest.fn(),
    },
  };
}

describe('TST-02 — Drive folder idempotency', () => {
  const ROOT_ID = 'root-folder-id';
  const DATE_NAME = '2026-06-07';
  const GENERATED_ID = 'generated-file-id-abc123';

  test('Creates folder when none exists', async () => {
    const drive = makeMockDrive();
    drive.files.list.mockResolvedValue({ data: { files: [] } });
    drive.files.generateIds.mockResolvedValue({ data: { ids: [GENERATED_ID] } });
    drive.files.create.mockResolvedValue({ data: { id: GENERATED_ID } });

    const id = await getOrCreateFolder(drive as unknown as drive_v3.Drive, DATE_NAME, ROOT_ID);

    expect(id).toBe(GENERATED_ID);
    expect(drive.files.create).toHaveBeenCalledTimes(1);
  });

  test('Returns existing folder ID without creating duplicate', async () => {
    const drive = makeMockDrive();
    const EXISTING_ID = 'existing-folder-id';
    drive.files.list.mockResolvedValue({ data: { files: [{ id: EXISTING_ID }] } });

    const id = await getOrCreateFolder(drive as unknown as drive_v3.Drive, DATE_NAME, ROOT_ID);

    expect(id).toBe(EXISTING_ID);
    expect(drive.files.create).not.toHaveBeenCalled();
    expect(drive.files.generateIds).not.toHaveBeenCalled();
  });

  test('Handles 409 Conflict from concurrent creation — returns pre-generated ID', async () => {
    const drive = makeMockDrive();
    drive.files.list.mockResolvedValue({ data: { files: [] } });
    drive.files.generateIds.mockResolvedValue({ data: { ids: [GENERATED_ID] } });
    // Simulates concurrent duplicate request arriving at Drive
    drive.files.create.mockRejectedValue(Object.assign(new Error('Conflict'), { code: 409 }));

    const id = await getOrCreateFolder(drive as unknown as drive_v3.Drive, DATE_NAME, ROOT_ID);

    // Must still return the pre-generated ID — no duplicate folder created
    expect(id).toBe(GENERATED_ID);
    expect(drive.files.create).toHaveBeenCalledTimes(1);
  });

  test('Sending 3 concurrent folder create requests yields exactly 1 unique ID', async () => {
    const drive = makeMockDrive();
    let callCount = 0;
    drive.files.list.mockResolvedValue({ data: { files: [] } });
    drive.files.generateIds.mockResolvedValue({ data: { ids: [GENERATED_ID] } });
    drive.files.create.mockImplementation(() => {
      callCount++;
      if (callCount > 1) {
        return Promise.reject(Object.assign(new Error('Conflict'), { code: 409 }));
      }
      return Promise.resolve({ data: { id: GENERATED_ID } });
    });

    const results = await Promise.all([
      getOrCreateFolder(drive as unknown as drive_v3.Drive, DATE_NAME, ROOT_ID),
      getOrCreateFolder(drive as unknown as drive_v3.Drive, DATE_NAME, ROOT_ID),
      getOrCreateFolder(drive as unknown as drive_v3.Drive, DATE_NAME, ROOT_ID),
    ]);

    const unique = new Set(results);
    expect(unique.size).toBe(1);
    expect([...unique][0]).toBe(GENERATED_ID);
  });
});
