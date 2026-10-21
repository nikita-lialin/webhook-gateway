-- Up Migration

CREATE TABLE endpoints (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text        NOT NULL,
  source         text        NOT NULL,
  target_url     text        NOT NULL,
  signing_secret text        NOT NULL,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Эндпоинты не удаляются, только выключаются (is_active), поэтому RESTRICT.
CREATE TABLE events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id     uuid        NOT NULL REFERENCES endpoints (id) ON DELETE RESTRICT,
  idempotency_key text        NOT NULL,
  payload         jsonb       NOT NULL,
  headers         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status          text        NOT NULL DEFAULT 'pending',
  attempts_count  integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_status_check
    CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'dead')),
  CONSTRAINT events_attempts_count_check CHECK (attempts_count >= 0)
);

CREATE UNIQUE INDEX events_endpoint_id_idempotency_key_uq ON events (endpoint_id, idempotency_key);
CREATE INDEX events_status_next_attempt_at_idx ON events (status, next_attempt_at);

-- Журнал принадлежит событию: событий не удаляем, CASCADE — только для целостности.
CREATE TABLE delivery_attempts (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id        uuid        NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  attempt_number  integer     NOT NULL,
  response_status integer,
  response_body   text,
  error           text,
  duration_ms     integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_attempts_attempt_number_check CHECK (attempt_number >= 1),
  CONSTRAINT delivery_attempts_duration_ms_check CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE INDEX delivery_attempts_event_id_idx ON delivery_attempts (event_id);
CREATE UNIQUE INDEX delivery_attempts_event_id_attempt_number_uq
  ON delivery_attempts (event_id, attempt_number);

-- Down Migration

DROP TABLE delivery_attempts;
DROP TABLE events;
DROP TABLE endpoints;
