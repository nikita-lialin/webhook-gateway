import type { Pool } from '../../db/index.js';
import type { DeliveryAttemptRow, EventRow, EventStatus } from '../../db/types.js';

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

export interface EventListFilter {
  status?: EventStatus;
  endpointId?: string;
  from?: string;
  to?: string;
}

export interface EventCursor {
  /** ISO-время с микросекундами: тип timestamptz точнее, чем Date в JS. */
  createdAt: string;
  id: string;
}

export type EventSummary = Omit<EventRow, 'payload' | 'headers'>;

export interface EventPage {
  items: EventSummary[];
  nextCursor: EventCursor | null;
}

const SUMMARY_COLUMNS =
  'id, endpoint_id, idempotency_key, status, attempts_count, next_attempt_at, created_at, updated_at';

/** Keyset-пагинация по (created_at DESC, id DESC); индекс events_created_at_id_idx. */
export async function listEvents(
  pool: Pool,
  filter: EventListFilter,
  limit: number,
  cursor: EventCursor | null,
): Promise<EventPage> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: (n: number) => string, value: unknown): void => {
    params.push(value);
    where.push(sql(params.length));
  };
  if (filter.status) add((n) => `status = $${n}`, filter.status);
  if (filter.endpointId) add((n) => `endpoint_id = $${n}::uuid`, filter.endpointId);
  if (filter.from) add((n) => `created_at >= $${n}::timestamptz`, filter.from);
  if (filter.to) add((n) => `created_at < $${n}::timestamptz`, filter.to);
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const result = await pool.query<EventSummary & { cursor_created_at: string }>(
    `SELECT ${SUMMARY_COLUMNS},
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
     FROM events
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  const last = rows[rows.length - 1];
  return {
    items: rows.map((row) => {
      const summary: Partial<typeof row> = { ...row };
      delete summary.cursor_created_at;
      return summary as EventSummary;
    }),
    nextCursor: hasMore && last ? { createdAt: last.cursor_created_at, id: last.id } : null,
  };
}

export async function findEvent(pool: Pool, id: string): Promise<EventRow | null> {
  const r = await pool.query<EventRow>('SELECT * FROM events WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

export async function listAttempts(pool: Pool, eventId: string): Promise<DeliveryAttemptRow[]> {
  const r = await pool.query<DeliveryAttemptRow>(
    'SELECT * FROM delivery_attempts WHERE event_id = $1 ORDER BY attempt_number',
    [eventId],
  );
  return r.rows;
}
