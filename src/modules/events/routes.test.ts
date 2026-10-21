import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { createTestPool, testDatabaseUrl } from '../../../test/db.js';
import type { Pool } from '../../db/index.js';
import { createDeliveryQueue } from '../../queue/index.js';
import { decodeCursor, encodeCursor } from './routes.js';

const KEY = 'k'.repeat(32);
const auth = { 'x-admin-api-key': KEY };

describe('cursor codec', () => {
  it('round-trips and rejects garbage', () => {
    const c = { createdAt: '2026-01-01T00:00:00.123456Z', id: crypto.randomUUID() };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(Buffer.from('{"c":"x","i":"y"}').toString('base64url'))).toBeNull();
  });
});

describe.skipIf(!testDatabaseUrl)('logs API /events', () => {
  let app: FastifyInstance;
  let pool: Pool;
  let endpointA: string;
  let endpointB: string;
  const ids: string[] = [];

  async function endpoint(name: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO endpoints (name, source, target_url, signing_secret)
       VALUES ($1, 'test', 'https://example.com/h', 'topsecret') RETURNING id`,
      [name],
    );
    return r.rows[0]?.id as string;
  }

  async function event(endpointId: string, status: string, createdAt: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO events (endpoint_id, idempotency_key, payload, headers, status, created_at)
       VALUES ($1, $2, '{"a":1}', '{"x-h":"v"}', $3, $4::timestamptz) RETURNING id`,
      [endpointId, crypto.randomUUID(), status, createdAt],
    );
    const id = r.rows[0]?.id as string;
    ids.push(id);
    return id;
  }

  beforeAll(async () => {
    pool = createTestPool(testDatabaseUrl as string);
    app = buildApp(
      {
        logLevel: 'fatal',
        adminApiKey: KEY,
        bodyLimitBytes: 1_048_576,
        webhookSecret: 's'.repeat(32),
      },
      {
        pool: createTestPool(testDatabaseUrl as string),
        queue: createDeliveryQueue({ redisUrl: 'redis://127.0.0.1:1' }),
      },
    );
    endpointA = await endpoint('logs-a');
    endpointB = await endpoint('logs-b');
    await app.ready();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM events WHERE endpoint_id = ANY($1::uuid[])', [
      [endpointA, endpointB],
    ]);
    await pool.query('DELETE FROM endpoints WHERE id = ANY($1::uuid[])', [[endpointA, endpointB]]);
    await pool.end();
    await app.close();
  });

  const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });

  it('requires the admin key', async () => {
    const id = crypto.randomUUID();
    for (const url of ['/events', `/events/${id}`, `/events/${id}/attempts`]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });

  it('paginates across events sharing the same created_at without gaps or duplicates', async () => {
    const same = '2026-03-01T10:00:00.123456Z';
    const created = [
      await event(endpointA, 'pending', same),
      await event(endpointA, 'pending', same),
      await event(endpointA, 'pending', same),
      await event(endpointA, 'pending', same),
      await event(endpointA, 'pending', '2026-03-01T09:00:00Z'),
    ];
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(
        `/events?endpointId=${endpointA}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: { id: string }[]; next_cursor: string | null }>();
      seen.push(...body.items.map((i) => i.id));
      cursor = body.next_cursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...created].sort());
    expect(seen[4]).toBe(created[4]);
  });

  it('filters by status, endpointId and date range', async () => {
    await event(endpointB, 'dead', '2026-04-01T00:00:00Z');
    await event(endpointB, 'delivered', '2026-04-02T00:00:00Z');
    await event(endpointB, 'delivered', '2026-04-03T00:00:00Z');
    const q = async (qs: string) =>
      (await get(`/events?endpointId=${endpointB}&${qs}`)).json<{
        items: { status: string }[];
      }>().items;
    expect(await q('status=dead')).toHaveLength(1);
    expect(await q('status=delivered')).toHaveLength(2);
    expect(await q('from=2026-04-02T00:00:00Z&to=2026-04-03T00:00:00Z')).toHaveLength(1);
    expect(await q('')).toHaveLength(3);
  });

  it('validates parameters', async () => {
    for (const qs of [
      'limit=0',
      'limit=201',
      'status=bogus',
      'endpointId=x',
      'from=yesterday',
      'cursor=zzz',
      'foo=1',
    ]) {
      expect((await get(`/events?${qs}`)).statusCode, qs).toBe(400);
    }
    expect((await get('/events/not-a-uuid')).statusCode).toBe(400);
  });

  it('returns detail with payload and headers, attempts in order, and no secrets', async () => {
    const id = await event(endpointA, 'failed', '2026-05-01T00:00:00Z');
    await pool.query(
      `INSERT INTO delivery_attempts (event_id, attempt_number, response_status) VALUES ($1,2,500),($1,1,502)`,
      [id],
    );
    const detail = await get(`/events/${id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id, payload: { a: 1 }, headers: { 'x-h': 'v' } });
    const attempts = (await get(`/events/${id}/attempts`)).json<{
      items: { attempt_number: number }[];
    }>();
    expect(attempts.items.map((a) => a.attempt_number)).toEqual([1, 2]);
    const list = await get(`/events?endpointId=${endpointA}`);
    for (const body of [detail.body, list.body, JSON.stringify(attempts)]) {
      expect(body).not.toContain('topsecret');
      expect(body).not.toContain('signing_secret');
    }
    const missing = crypto.randomUUID();
    expect((await get(`/events/${missing}`)).statusCode).toBe(404);
    expect((await get(`/events/${missing}/attempts`)).statusCode).toBe(404);
  });
});
