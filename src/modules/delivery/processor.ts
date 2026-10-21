import { UnrecoverableError } from 'bullmq';
import type { Pool } from '../../db/index.js';
import { claimEventForProcessing } from '../events/repository.js';
import { dispatch, type DispatchResult } from './dispatcher.js';
import { findEndpointById, recordAttempt } from './repository.js';
import {
  computeBackoffDelay,
  isRetryable,
  RetryableDeliveryError,
  type BackoffOptions,
} from './retry.js';

export interface ProcessorLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface DeadLetter {
  eventId: string;
  endpointId: string;
  attempts: number;
  reason: string;
}

const ENDPOINT_MISSING: DispatchResult = {
  responseStatus: null,
  responseBody: null,
  error: 'endpoint not found',
  durationMs: 0,
  ok: false,
  retryAfterMs: null,
};

/**
 * Обработчик задачи: захват события, HTTP-отправка, запись попытки. 2xx → `delivered`.
 * Повторяемая неудача с оставшимися попытками → `pending` + `next_attempt_at`, бросается
 * `RetryableDeliveryError` (BullMQ повторит задачу по backoff-стратегии воркера). Неповторяемая
 * → `failed` и `UnrecoverableError`. Повторяемая неудача на последней попытке
 * (`attemptNumber >= maxRetryAttempts`) → `dead`, запись в лог и в DLQ через `onDead`; сбой DLQ не
 * отменяет перевод (источник истины — PostgreSQL). Исключение при сбое БД тоже уходит в BullMQ.
 */
export function createDeliveryProcessor(
  pool: Pool,
  log: ProcessorLogger,
  options: {
    deliveryTimeoutMs: number;
    maxRetryAttempts: number;
    onDead?: (letter: DeadLetter) => Promise<void>;
  } & BackoffOptions,
) {
  return async (job: { data: { eventId: string } }): Promise<void> => {
    const { eventId } = job.data;
    const event = await claimEventForProcessing(pool, eventId);
    if (!event) {
      log.info({ eventId }, 'event skipped: not found or already finished');
      return;
    }
    const attemptNumber = event.attempts_count + 1;
    const endpoint = await findEndpointById(pool, event.endpoint_id);
    const result = endpoint
      ? await dispatch(event, endpoint, { timeoutMs: options.deliveryTimeoutMs })
      : ENDPOINT_MISSING;
    const retryable = !result.ok && isRetryable(result);
    // Лимит и backoff считаются по текущему циклу: после replay отсчёт идёт заново, нумерация попыток — сквозная.
    const cycleAttempt = attemptNumber - event.cycle_attempts_offset;
    const retry = retryable && cycleAttempt < options.maxRetryAttempts;
    const dead = retryable && !retry;
    const delayMs = retry ? computeBackoffDelay(cycleAttempt, options, result.retryAfterMs) : null;
    const status = result.ok ? 'delivered' : retry ? 'pending' : dead ? 'dead' : 'failed';
    const nextAttemptAt = delayMs === null ? null : new Date(Date.now() + delayMs);
    await recordAttempt(pool, eventId, attemptNumber, result, status, nextAttemptAt);
    log[result.ok ? 'info' : 'warn'](
      {
        eventId,
        attempt: attemptNumber,
        status,
        responseStatus: result.responseStatus,
        error: result.error,
        durationMs: result.durationMs,
        nextAttemptAt,
      },
      'delivery attempt finished',
    );
    if (dead) {
      const reason = result.error ?? `HTTP ${result.responseStatus}`;
      log.error(
        { eventId, endpointId: event.endpoint_id, attempts: attemptNumber, lastError: reason },
        'event moved to dead letter queue',
      );
      try {
        await options.onDead?.({
          eventId,
          endpointId: event.endpoint_id,
          attempts: attemptNumber,
          reason,
        });
      } catch (err) {
        log.error({ err, eventId }, 'failed to enqueue event to DLQ');
      }
    }
    if (delayMs !== null) {
      throw new RetryableDeliveryError(result.error ?? `HTTP ${result.responseStatus}`, delayMs);
    }
    if (!result.ok) {
      throw new UnrecoverableError(result.error ?? `HTTP ${result.responseStatus}`);
    }
  };
}
