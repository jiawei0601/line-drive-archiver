import crypto from 'crypto';
import express from 'express';

export class SignatureValidationFailed extends Error {
  constructor() { super('SignatureValidationFailed'); }
}

export class JSONParseError extends Error {
  constructor() { super('JSONParseError'); }
}

/**
 * Verifies LINE webhook signature using HMAC-SHA256 + constant-time comparison
 * to prevent timing attacks (SRS §3.2.1).
 *
 * MUST be placed before any global JSON parser middleware (SRS §3.1.1).
 */
function verifyLineSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  try {
    // timingSafeEqual prevents timing-based side-channel attacks (SRS §3.2.1)
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    // Throws when buffers have different byte lengths — signature is invalid
    return false;
  }
}

export function lineWebhookMiddleware(channelSecret: string) {
  return [
    // Capture raw byte stream before any JSON parsing (SRS §3.1.1)
    express.raw({ type: '*/*', limit: '10mb' }),

    (req: express.Request, res: express.Response, next: express.NextFunction): void => {
      const signature = req.headers['x-line-signature'] as string | undefined;

      if (!signature) {
        res.status(401).json({ error: 'SignatureValidationFailed' });
        return;
      }

      const rawBody = req.body as Buffer;

      if (!verifyLineSignature(rawBody, signature, channelSecret)) {
        res.status(401).json({ error: 'SignatureValidationFailed' });
        return;
      }

      try {
        req.body = JSON.parse(rawBody.toString('utf-8'));
      } catch {
        res.status(400).json({ error: 'JSONParseError' });
        return;
      }

      next();
    },
  ];
}
