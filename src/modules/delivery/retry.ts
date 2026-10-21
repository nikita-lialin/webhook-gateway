import type { DispatchResult } from './dispatcher.js';

export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
}

const RETRYABLE_STATUSES = new Set([408, 429]);

/**
 * Стоит ли повторять неуспешную попытку: нет ответа (таймаут, сеть), 5xx, 408 и 429 — да;
 * остальные 4xx и 3xx (редиректы не выполняются) — нет.
 */
export function isRetryable(result: Pick<DispatchResult, 'responseStatus'>): boolean {
  const status = result.responseStatus;
  if (status === null) return true;
  return status >= 500 || RETRYABLE_STATUSES.has(status);
}

/**
 * Задержка перед попыткой n+1 после n-й неудачи: full jitter поверх min(max, base × 2^(n−1)).
 * `retryAfterMs` (429) задаёт нижнюю границу, но результат не выше потолка. `random` ∈ [0, 1).
 */
export function computeBackoffDelay(
  failedAttempt: number,
  options: BackoffOptions,
  retryAfterMs: number | null = null,
  random: () => number = Math.random,
): number {
  const exponential = options.baseDelayMs * 2 ** (failedAttempt - 1);
  const ceiling = Math.min(options.maxDelayMs, exponential);
  const jittered = Math.floor(random() * ceiling);
  return Math.min(options.maxDelayMs, Math.max(jittered, retryAfterMs ?? 0));
}

/** `Retry-After`: секунды или HTTP-дата. Некорректное значение и прошедшая дата → `null`/0. */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

/** Повторяемая неудача: BullMQ перезапустит задачу через `delayMs` (читает backoff-стратегия воркера). */
export class RetryableDeliveryError extends Error {
  constructor(
    message: string,
    readonly delayMs: number,
  ) {
    super(message);
    this.name = 'RetryableDeliveryError';
  }
}

/** Стратегия BullMQ `type: 'custom'`: задержка уже посчитана процессором и лежит в ошибке. */
export function backoffStrategy(options: BackoffOptions) {
  return (attemptsMade: number, _type?: string, err?: Error): number =>
    err instanceof RetryableDeliveryError
      ? err.delayMs
      : computeBackoffDelay(attemptsMade, options);
}
