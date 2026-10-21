import type { Pool } from '../../db/index.js';
import { withTransaction } from '../../db/index.js';
import type { EndpointRow, EventStatus } from '../../db/types.js';
import type { DispatchResult } from './dispatcher.js';

export async function findEndpointById(pool: Pool, id: string): Promise<EndpointRow | null> {
  const r = await pool.query<EndpointRow>('SELECT * FROM endpoints WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

/**
 * Пишет попытку и меняет статус события в одной транзакции. `attemptNumber` — номер этой попытки;
 * `attempts_count` становится равным ему.
 */
export async function recordAttempt(
  pool: Pool,
  eventId: string,
  attemptNumber: number,
  result: DispatchResult,
  newStatus: EventStatus,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO delivery_attempts
         (event_id, attempt_number, response_status, response_body, error, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        eventId,
        attemptNumber,
        result.responseStatus,
        result.responseBody,
        result.error,
        result.durationMs,
      ],
    );
    await client.query(
      'UPDATE events SET status = $2, attempts_count = $3, updated_at = now() WHERE id = $1',
      [eventId, newStatus, attemptNumber],
    );
  });
}
