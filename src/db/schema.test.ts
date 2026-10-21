import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool, testDatabaseUrl } from '../../test/db.js';
import type { PoolClient } from './pool.js';
import { withTransaction, type Pool } from './pool.js';

const MIGRATION = 'migrations/1792600000000_init-schema.sql';
const SCHEMA = 'schema_probe';

/** Миграция гоняется в отдельной схеме внутри транзакции, которая откатывается, — рабочие таблицы не трогаем. */
class Rollback extends Error {}

async function inProbeSchema(pool: Pool, fn: (c: PoolClient) => Promise<void>): Promise<void> {
  await withTransaction(pool, async (c) => {
    await c.query(`CREATE SCHEMA ${SCHEMA}`);
    await c.query(`SET LOCAL search_path TO ${SCHEMA}`);
    await fn(c);
    throw new Rollback();
  }).catch((err: unknown) => {
    if (!(err instanceof Rollback)) throw err;
  });
}

describe.skipIf(!testDatabaseUrl)('схема данных (init-schema)', () => {
  let pool: Pool;
  let up: string;
  let down: string;

  beforeAll(async () => {
    pool = createTestPool(testDatabaseUrl as string);
    const sql = await readFile(MIGRATION, 'utf8');
    const [head, tail] = sql.split('-- Down Migration');
    up = (head ?? '').replace('-- Up Migration', '');
    down = tail ?? '';
  });

  afterAll(async () => {
    await pool.end();
  });

  const tables = async (c: PoolClient): Promise<string[]> =>
    (
      await c.query<{ tablename: string }>(
        'SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename',
        [SCHEMA],
      )
    ).rows.map((r) => r.tablename);

  const insertEndpoint = async (c: PoolClient): Promise<string> =>
    (
      await c.query<{ id: string }>(
        `INSERT INTO endpoints (name, source, target_url, signing_secret)
         VALUES ('n', 's', 'http://t', 'secret') RETURNING id`,
      )
    ).rows[0]?.id as string;

  const insertEvent = async (
    c: PoolClient,
    endpointId: string,
    key = 'k1',
    status = 'pending',
  ): Promise<string> =>
    (
      await c.query<{ id: string }>(
        `INSERT INTO events (endpoint_id, idempotency_key, payload, status)
         VALUES ($1, $2, '{}', $3) RETURNING id`,
        [endpointId, key, status],
      )
    ).rows[0]?.id as string;

  describe('up / down', () => {
    it('up создаёт три таблицы, down откатывает чисто, повторный up работает', async () => {
      await inProbeSchema(pool, async (c) => {
        await c.query(up);
        expect(await tables(c)).toEqual(['delivery_attempts', 'endpoints', 'events']);
        await c.query(down);
        expect(await tables(c)).toEqual([]);
        await c.query(up);
        expect(await tables(c)).toEqual(['delivery_attempts', 'endpoints', 'events']);
      });
    });
  });

  describe('ограничения', () => {
    // каждый тест — в своей откатываемой транзакции; после ожидаемой ошибки продолжаем только через SAVEPOINT
    const run = (fn: (c: PoolClient) => Promise<void>): Promise<void> =>
      inProbeSchema(pool, async (c) => {
        await c.query(up);
        await fn(c);
      });

    it('значения по умолчанию', async () => {
      await run(async (c) => {
        const endpointId = await insertEndpoint(c);
        const eventId = await insertEvent(c, endpointId);
        const { rows } = await c.query<{
          is_active: boolean;
          status: string;
          attempts_count: number;
          headers: unknown;
        }>(
          'SELECT e.is_active, v.status, v.attempts_count, v.headers FROM endpoints e, events v WHERE v.id = $1',
          [eventId],
        );
        expect(rows[0]).toEqual({
          is_active: true,
          status: 'pending',
          attempts_count: 0,
          headers: {},
        });
      });
    });

    it('идемпотентность: дубль (endpoint_id, key) отклоняется, тот же key у другого эндпоинта — нет', async () => {
      await run(async (c) => {
        const a = await insertEndpoint(c);
        const b = await insertEndpoint(c);
        await insertEvent(c, a, 'dup');
        await insertEvent(c, b, 'dup');
        await expect(insertEvent(c, a, 'dup')).rejects.toMatchObject({ code: '23505' });
      });
    });

    it('CHECK на status', async () => {
      await run(async (c) => {
        const a = await insertEndpoint(c);
        for (const status of ['pending', 'processing', 'delivered', 'failed', 'dead']) {
          await insertEvent(c, a, `ok-${status}`, status);
        }
        await expect(insertEvent(c, a, 'bad', 'unknown')).rejects.toMatchObject({ code: '23514' });
      });
    });

    it('журнал попыток: уникальный (event_id, attempt_number) и attempt_number >= 1', async () => {
      await run(async (c) => {
        const eventId = await insertEvent(c, await insertEndpoint(c));
        const attempt = (n: number): Promise<unknown> =>
          c.query('INSERT INTO delivery_attempts (event_id, attempt_number) VALUES ($1, $2)', [
            eventId,
            n,
          ]);
        await attempt(1);
        await attempt(2);
        await c.query('SAVEPOINT s1');
        await expect(attempt(1)).rejects.toMatchObject({ code: '23505' });
        await c.query('ROLLBACK TO s1');
        await expect(attempt(0)).rejects.toMatchObject({ code: '23514' });
      });
    });

    it('ON DELETE: эндпоинт с событиями не удаляется, удаление события каскадом чистит журнал', async () => {
      await run(async (c) => {
        const endpointId = await insertEndpoint(c);
        const eventId = await insertEvent(c, endpointId);
        await c.query('INSERT INTO delivery_attempts (event_id, attempt_number) VALUES ($1, 1)', [
          eventId,
        ]);

        await c.query('SAVEPOINT s');
        await expect(
          c.query('DELETE FROM endpoints WHERE id = $1', [endpointId]),
        ).rejects.toMatchObject({
          code: '23503',
        });
        await c.query('ROLLBACK TO s');

        await c.query('DELETE FROM events WHERE id = $1', [eventId]);
        const { rows } = await c.query('SELECT 1 FROM delivery_attempts WHERE event_id = $1', [
          eventId,
        ]);
        expect(rows).toHaveLength(0);
      });
    });

    it('внешние ключи отклоняют несуществующих родителей', async () => {
      await run(async (c) => {
        await expect(
          c.query(
            `INSERT INTO events (endpoint_id, idempotency_key, payload)
             VALUES (gen_random_uuid(), 'k', '{}')`,
          ),
        ).rejects.toMatchObject({ code: '23503' });
      });
    });
  });
});
