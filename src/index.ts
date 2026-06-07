import express from 'express';
import { config } from './config';
import { getPool } from './db/pool';
import { lineWebhookMiddleware } from './webhook/middleware';
import { handleWebhookEvents } from './webhook/handler';

const app = express();

// Health check — must respond before any JSON parsing middleware
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', ts: new Date().toISOString() });
});

// Webhook route: raw body MUST be captured before any global JSON parser (SRS §3.1.1)
app.post(
  '/webhook',
  ...lineWebhookMiddleware(config.line.channelSecret),
  async (req, res) => {
    // Respond to LINE within 1 second (SRS §6.2.3)
    res.status(200).json({});

    try {
      await handleWebhookEvents(req.body, getPool());
    } catch (err) {
      console.error('[webhook] DB write error:', (err as Error).message);
    }
  }
);

const server = app.listen(config.port, () => {
  console.log(`[server] Listening on port ${config.port}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

export { app };
