import type { EndpointRow, EventRow } from '../../db/types.js';
import { computeSignature } from '../ingress/signature.js';
import { parseRetryAfter } from './retry.js';

export const MAX_RESPONSE_BODY_BYTES = 4096;
const MAX_ERROR_LENGTH = 500;

export interface DispatchResult {
  /** HTTP-статус ответа; `null`, если ответа нет (таймаут, обрыв, сетевая ошибка). */
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number;
  /** 2xx. Редиректы и прочее — неуспех. */
  ok: boolean;
  /** Разобранный `Retry-After` ответа (мс); `null`, если заголовка нет. */
  retryAfterMs: number | null;
}

/** Читает не больше `limit` байт потоком и отменяет остаток, не загружая тело целиком. */
export async function readBodyLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.length > limit - total ? value.subarray(0, limit - total) : value;
      chunks.push(part);
      total += part.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function describeError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return `timeout after ${timeoutMs} ms`;
    }
    const cause = err.cause;
    const code =
      cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined;
    return `${err.name}: ${err.message}${code ? ` (${code})` : ''}`.slice(0, MAX_ERROR_LENGTH);
  }
  return 'unknown delivery error';
}

/**
 * Одна HTTP-отправка события получателю. Не бросает: любой сбой возвращается в `error`,
 * чтобы вызывающий записал попытку. Подпись и timestamp — те же, что у входящих (`<ts>.<body>`).
 */
export async function dispatch(
  event: Pick<EventRow, 'id' | 'payload'>,
  endpoint: Pick<EndpointRow, 'target_url' | 'signing_secret'>,
  options: { timeoutMs: number },
): Promise<DispatchResult> {
  const started = Date.now();
  const body = Buffer.from(JSON.stringify(event.payload), 'utf8');
  const timestamp = String(Math.floor(started / 1000));
  try {
    const res = await fetch(endpoint.target_url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        'content-type': 'application/json',
        'x-webhook-id': event.id,
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': computeSignature(body, timestamp, endpoint.signing_secret),
      },
      body,
    });
    const responseBody = await readBodyLimited(res, MAX_RESPONSE_BODY_BYTES);
    return {
      responseStatus: res.status,
      responseBody,
      error: null,
      durationMs: Date.now() - started,
      ok: res.status >= 200 && res.status < 300,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    };
  } catch (err) {
    return {
      responseStatus: null,
      responseBody: null,
      error: describeError(err, options.timeoutMs),
      durationMs: Date.now() - started,
      ok: false,
      retryAfterMs: null,
    };
  }
}
