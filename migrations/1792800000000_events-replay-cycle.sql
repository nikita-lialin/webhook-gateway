-- Up Migration

-- attempts_count и delivery_attempts.attempt_number остаются сквозными (история не теряется, уникальность
-- (event_id, attempt_number) не нарушается). Replay начинает новый цикл: cycle_attempts_offset фиксирует,
-- сколько попыток было до него, а лимит повторов считается от этой точки.
ALTER TABLE events
  ADD COLUMN replay_count          integer NOT NULL DEFAULT 0,
  ADD COLUMN cycle_attempts_offset integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT events_replay_count_check CHECK (replay_count >= 0),
  ADD CONSTRAINT events_cycle_attempts_offset_check
    CHECK (cycle_attempts_offset >= 0 AND cycle_attempts_offset <= attempts_count);

-- Down Migration

ALTER TABLE events
  DROP CONSTRAINT events_cycle_attempts_offset_check,
  DROP CONSTRAINT events_replay_count_check,
  DROP COLUMN cycle_attempts_offset,
  DROP COLUMN replay_count;
