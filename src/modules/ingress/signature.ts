import { createHmac, timingSafeEqual } from 'node:crypto';

export const TIMESTAMP_TOLERANCE_SECONDS = 300;

const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/i;
const TIMESTAMP_RE = /^\d{1,15}$/;

export type SignatureFailure =
  | 'missing_timestamp'
  | 'missing_signature'
  | 'malformed_timestamp'
  | 'malformed_signature'
  | 'timestamp_out_of_window'
  | 'signature_mismatch';

export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

/** Значение заголовка `X-Webhook-Signature` для строки `<timestamp>.<rawBody>`. */
export function computeSignature(rawBody: Buffer, timestamp: string, secret: string): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
  return `sha256=${digest}`;
}

/** Чистая проверка подписи; `now` — текущее время в мс (внедряется ради детерминированных тестов). */
export function verifySignature(
  rawBody: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
  now: number,
): SignatureResult {
  if (!timestamp) return { ok: false, reason: 'missing_timestamp' };
  if (!signature) return { ok: false, reason: 'missing_signature' };
  if (!TIMESTAMP_RE.test(timestamp)) return { ok: false, reason: 'malformed_timestamp' };

  const skewSeconds = Math.abs(now / 1000 - Number(timestamp));
  if (skewSeconds > TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_window' };
  }

  const match = SIGNATURE_RE.exec(signature);
  if (!match?.[1]) return { ok: false, reason: 'malformed_signature' };

  const received = Buffer.from(match[1], 'hex');
  const expected = Buffer.from(
    computeSignature(rawBody, timestamp, secret).slice('sha256='.length),
    'hex',
  );
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}
