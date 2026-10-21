import type { Pool } from '../../db/index.js';
import type { EventRow } from '../../db/types.js';

export interface NewEvent {
  endpointId: string;
  idempotencyKey: string;
  /** Уже сериализованный JSON: в jsonb уходит как есть. */
  payloadJson: string;
  headers: Record<string, string>;
}

export interface SavedEvent {
  eventId: string;
  duplicate: boolean;
}

/**
 * Идемпотентная вставка: гонку решает уникальный индекс (endpoint_id, idempotency_key),
 * а не проверка в коде. При конфликте RETURNING пуст — читаем id уже существующего события.
 */
export async function insertEventIdempotent(pool: Pool, input: NewEvent): Promise<SavedEvent> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO events (endpoint_id, idempotency_key, payload, headers)
     VALUES ($1, $2, $3::jsonb, $4::jsonb)
     ON CONFLICT (endpoint_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [input.endpointId, input.idempotencyKey, input.payloadJson, JSON.stringify(input.headers)],
  );
  const created = inserted.rows[0];
  if (created) return { eventId: created.id, duplicate: false };

  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM events WHERE endpoint_id = $1 AND idempotency_key = $2',
    [input.endpointId, input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('event vanished after idempotency conflict');
  return { eventId: row.id, duplicate: true };
}

const CLAIMABLE_STATUSES = ['pending', 'failed', 'processing'] as const;

/**
 * Атомарно переводит событие в `processing` и возвращает его. `null`, если события нет или оно уже
 * `delivered`/`dead`. `processing` допустим: так подхватывается задача, оборвавшаяся вместе с воркером.
 */
export async function claimEventForProcessing(
  pool: Pool,
  eventId: string,
): Promise<EventRow | null> {
  const result = await pool.query<EventRow>(
    `UPDATE events SET status = 'processing', updated_at = now()
     WHERE id = $1 AND status = ANY($2::text[])
     RETURNING *`,
    [eventId, CLAIMABLE_STATUSES],
  );
  return result.rows[0] ?? null;
}
