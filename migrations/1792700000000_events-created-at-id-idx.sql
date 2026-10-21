-- Up Migration

-- Под keyset-пагинацию GET /events: ORDER BY created_at DESC, id DESC.
CREATE INDEX events_created_at_id_idx ON events (created_at DESC, id DESC);

-- Down Migration

DROP INDEX events_created_at_id_idx;
