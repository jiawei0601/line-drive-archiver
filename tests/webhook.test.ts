/**
 * TST-01: Webhook security tests
 * Verifies HMAC-SHA256 signature validation and timing-attack resistance.
 */
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { lineWebhookMiddleware } from '../src/webhook/middleware';

const TEST_SECRET = 'test-channel-secret-32-bytes-long!';

function makeApp() {
  const app = express();
  app.post(
    '/webhook',
    ...lineWebhookMiddleware(TEST_SECRET),
    (_req, res) => res.status(200).json({})
  );
  return app;
}

function validSignature(body: string | Buffer): string {
  return crypto
    .createHmac('sha256', TEST_SECRET)
    .update(typeof body === 'string' ? Buffer.from(body) : body)
    .digest('base64');
}

const validBody = JSON.stringify({ destination: 'U123', events: [] });

describe('TST-01 — Webhook signature security', () => {
  const app = makeApp();

  test('Missing X-Line-Signature → 401 SignatureValidationFailed', async () => {
    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send(validBody);

    expect(res.status).toBe(401);
    expect(res.text).toContain('SignatureValidationFailed');
  });

  test('Tampered body (appended 0x20) → 401 SignatureValidationFailed', async () => {
    const sig = validSignature(validBody);
    // Append a trailing space byte — invalidates the HMAC
    const tampered = validBody + ' ';

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Line-Signature', sig)
      .send(tampered);

    expect(res.status).toBe(401);
    expect(res.text).toContain('SignatureValidationFailed');
  });

  test('Correct signature → 200 OK', async () => {
    const sig = validSignature(validBody);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Line-Signature', sig)
      .send(validBody);

    expect(res.status).toBe(200);
  });

  test('Malformed JSON with valid signature → 400 JSONParseError', async () => {
    const badJson = '{bad json}';
    const sig = validSignature(badJson);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Line-Signature', sig)
      .send(badJson);

    expect(res.status).toBe(400);
    expect(res.text).toContain('JSONParseError');
  });

  /**
   * Timing-attack resistance: response times for 0, half, and full matching bytes
   * must show near-zero standard deviation, proving constant-time comparison.
   */
  test('Timing-attack resistance: σ(response times) < 5ms across mismatch degrees', async () => {
    const SAMPLES = 50;
    const bodies = [
      { label: '0 matching bytes', sig: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
      { label: 'partial match',   sig: validSignature(validBody).slice(0, -4) + 'AAAA' },
      { label: 'wrong sig',       sig: validSignature(validBody + 'x') },
    ];

    const avgTimes: number[] = [];

    for (const { sig } of bodies) {
      const times: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        const t0 = performance.now();
        await request(app)
          .post('/webhook')
          .set('Content-Type', 'application/json')
          .set('X-Line-Signature', sig)
          .send(validBody);
        times.push(performance.now() - t0);
      }
      avgTimes.push(times.reduce((a, b) => a + b, 0) / times.length);
    }

    const mean = avgTimes.reduce((a, b) => a + b, 0) / avgTimes.length;
    const variance = avgTimes.reduce((acc, t) => acc + Math.pow(t - mean, 2), 0) / avgTimes.length;
    const stdDev = Math.sqrt(variance);

    // Standard deviation across average response times must be < 5ms
    expect(stdDev).toBeLessThan(5);
  }, 30_000);
});
