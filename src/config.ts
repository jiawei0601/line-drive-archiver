function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  line: {
    channelSecret: require_env('LINE_CHANNEL_SECRET'),
    channelAccessToken: require_env('LINE_CHANNEL_ACCESS_TOKEN'),
  },
  db: {
    url: require_env('DATABASE_URL'),
    maxConnections: 20,
  },
  drive: {
    rootFolderId: require_env('GOOGLE_DRIVE_ROOT_FOLDER_ID'),
    credentials: JSON.parse(require_env('GOOGLE_SERVICE_ACCOUNT_CREDENTIALS')),
  },
};
