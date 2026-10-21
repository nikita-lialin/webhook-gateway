import type { Pool } from '../../db/index.js';
import { withTransaction } from '../../db/index.js';
import { requeueIfLost, type DeliveryQueue } from '../../queue/index.js';

export interface SweeperLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface SweeperOptions {
  /** Сколько `pending` без задачи ждём, прежде чем считать событие потерянным, мс. */
  staleAfterMs: number;
  /** Сколько `processing` считается нормальным (с запасом над таймаутом доставки), мс. */
  processingTimeoutMs: number;
  batchSize: number;
}

export interface SweepResult {
  found: number;
  requeued: number;
}

/**
 * Кандидаты: `pending` (без `next_attempt_at` — не дошёл до очереди; с ним — повтор не сработал) и
 * `processing`, застрявшие дольше таймаута. Условия разложены по OR-веткам без функций над колонками,
 * чтобы планировщик шёл по индексу (status, next_attempt_at). `SKIP LOCKED` — параллельные sweeper'ы
 * не берут одни и те же строки.
 */
export const STUCK_EVENTS_SQL = `
  SELECT id FROM events
  WHERE (status = 'pending' AND next_attempt_at < now() - ($1::int * interval '1 millisecond'))
     OR (status = 'pending' AND next_attempt_at IS NULL
         AND created_at < now() - ($1::int * interval '1 millisecond'))
     OR (status = 'processing' AND updated_at < now() - ($2::int * interval '1 millisecond'))
  LIMIT $3
  FOR UPDATE SKIP LOCKED`;

/**
 * Один проход: ставит в очередь события, для которых в Redis нет живой задачи. Двойную доставку
 * исключают jobId = eventId (живую задачу не трогаем) и атомарный захват события воркером.
 * Недоступный Redis обрывает проход: события остаются в БД до следующего тика.
 */
export async function sweepStuckEvents(
  pool: Pool,
  dq: DeliveryQueue,
  log: SweeperLogger,
  options: SweeperOptions,
): Promise<SweepResult> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(STUCK_EVENTS_SQL, [
      options.staleAfterMs,
      options.processingTimeoutMs,
      options.batchSize,
    ]);
    let requeued = 0;
    for (const { id } of rows) {
      try {
        if (await requeueIfLost(dq, id)) {
          requeued += 1;
          log.warn({ eventId: id }, 'stuck event re-enqueued');
        }
      } catch (err) {
        log.error({ err, eventId: id }, 'sweeper aborted: queue unavailable');
        break;
      }
    }
    if (rows.length > 0) log.info({ found: rows.length, requeued }, 'recovery sweep finished');
    return { found: rows.length, requeued };
  });
}
