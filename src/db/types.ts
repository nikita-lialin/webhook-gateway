/** Типы строк таблиц PostgreSQL. Схема меняется только миграциями — типы обновляются вместе с ними. */

export const EVENT_STATUSES = ['pending', 'processing', 'delivered', 'failed', 'dead'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface EndpointRow {
  id: string;
  name: string;
  source: string;
  target_url: string;
  signing_secret: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface EventRow {
  id: string;
  endpoint_id: string;
  idempotency_key: string;
  payload: unknown;
  headers: Record<string, string | string[]>;
  status: EventStatus;
  attempts_count: number;
  /** Сколько раз событие переотправляли вручную (replay). */
  replay_count: number;
  /** Значение `attempts_count` на начало текущего цикла доставки; попытки цикла = attempts_count − offset. */
  cycle_attempts_offset: number;
  next_attempt_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DeliveryAttemptRow {
  /** bigint: драйвер pg отдаёт его строкой. */
  id: string;
  event_id: string;
  attempt_number: number;
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number | null;
  created_at: Date;
}
