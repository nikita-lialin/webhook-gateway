import type { Pool } from '../../db/index.js';
import { claimEventForProcessing } from '../events/repository.js';

export interface ProcessorLogger {
  info(obj: object, msg: string): void;
}

/** Обработчик задачи: пока только захватывает событие. Отправка — шаг 11. */
export function createDeliveryProcessor(pool: Pool, log: ProcessorLogger) {
  return async (job: { data: { eventId: string } }): Promise<void> => {
    const { eventId } = job.data;
    const event = await claimEventForProcessing(pool, eventId);
    if (!event) {
      log.info({ eventId }, 'event skipped: not found or already finished');
      return;
    }
    log.info({ eventId, attempts: event.attempts_count }, 'event claimed for processing');
  };
}
