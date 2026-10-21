import type { Pool } from '../../db/index.js';
import { claimEventForProcessing } from '../events/repository.js';
import { dispatch, type DispatchResult } from './dispatcher.js';
import { findEndpointById, recordAttempt } from './repository.js';

export interface ProcessorLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

const ENDPOINT_MISSING: DispatchResult = {
  responseStatus: null,
  responseBody: null,
  error: 'endpoint not found',
  durationMs: 0,
  ok: false,
};

/**
 * Обработчик задачи: захват события, HTTP-отправка, запись попытки. 2xx → `delivered`, иначе `failed`
 * (повторы и backoff — шаг 12). Исключение только при сбое БД: BullMQ пометит задачу failed.
 */
export function createDeliveryProcessor(
  pool: Pool,
  log: ProcessorLogger,
  options: { deliveryTimeoutMs: number },
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
    const status = result.ok ? 'delivered' : 'failed';
    await recordAttempt(pool, eventId, attemptNumber, result, status);
    log[result.ok ? 'info' : 'warn'](
      {
        eventId,
        attempt: attemptNumber,
        status,
        responseStatus: result.responseStatus,
        error: result.error,
        durationMs: result.durationMs,
      },
      'delivery attempt finished',
    );
  };
}
