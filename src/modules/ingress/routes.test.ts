import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { computeSignature } from './signature.js';
import { createDeliveryQueue, type DeliveryQueue } from '../../queue/index.js';
import { createTestPool, testDatabaseUrl, testRedisUrl } from '../../../test/db.js';
import type { Pool } from '../../db/index.js';

const LIMIT = 1024;
const SECRET = 'w'.repeat(32);
const json = { 'content-type': 'application/json' };

const signed = (payload: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)) => ({
  ...json,
  'x-webhook-timestamp': String(ts),
  'x-webhook-signature': computeSignature(Buffer.from(payload), String(ts), secret),
});

describe.skipIf(!testDatabaseUrl)('POST /webhooks/:endpointId', () => {
  let app: FastifyInstance;
  let cleanupPool: Pool;
  let queue: DeliveryQueue;
  let activeId: string;
  let inactiveId: string;

  beforeAll(async () => {
    queue = createDeliveryQueue(
      { redisUrl: testRedisUrl ?? 'redis://127.0.0.1:1' },
      { name: `webhook-delivery-test-${process.pid}`, timeoutMs: 500 },
    );
    app = buildApp(
      {
        logLevel: 'fatal',
        adminApiKey: 'k'.repeat(32),
        bodyLimitBytes: LIMIT,
        webhookSecret: SECRET,
      },
      { pool: createTestPool(testDatabaseUrl as string), queue },
    );
    cleanupPool = createTestPool(testDatabaseUrl as string);
    await app.ready();
    const insert = async (active: boolean) =>
      (
        await cleanupPool.query<{ id: string }>(
          `INSERT INTO endpoints (name, source, target_url, signing_secret, is_active)
           VALUES ('ingress-test', 'test', 'https://example.com/h', 's', $1) RETURNING id`,
          [active],
        )
      ).rows[0]?.id as string;
    activeId = await insert(true);
    inactiveId = await insert(false);
  });

  afterAll(async () => {
    await cleanupPool.query('DELETE FROM events WHERE endpoint_id = ANY($1::uuid[])', [
      [activeId, inactiveId],
    ]);
    await cleanupPool.query('DELETE FROM endpoints WHERE id = ANY($1::uuid[])', [
      [activeId, inactiveId],
    ]);
    await cleanupPool.end();
    await app.close();
  });

  const post = (id: string, payload: string, headers?: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: `/webhooks/${id}`,
      headers: headers ?? signed(payload),
      payload,
    });

  it('accepts valid JSON with 202 and an eventId', async () => {
    const res = await post(activeId, '{"a":1}');
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ eventId: expect.any(String) });
  });

  it('still returns 202 when Redis is unavailable', async () => {
    const down = createDeliveryQueue({ redisUrl: 'redis://127.0.0.1:1' }, { timeoutMs: 300 });
    const app2 = buildApp(
      {
        logLevel: 'fatal',
        adminApiKey: 'k'.repeat(32),
        bodyLimitBytes: LIMIT,
        webhookSecret: SECRET,
      },
      { pool: createTestPool(testDatabaseUrl as string), queue: down },
    );
    const payload = '{"redis":"down"}';
    const res = await app2.inject({
      method: 'POST',
      url: `/webhooks/${activeId}`,
      headers: signed(payload),
      payload,
    });
    expect(res.statusCode).toBe(202);
    await app2.close();
  });

  it.skipIf(!testRedisUrl)('enqueues exactly one job with the eventId', async () => {
    await queue.queue.obliterate({ force: true });
    const payload = '{"queued":1}';
    const res = await post(activeId, payload);
    expect(res.statusCode).toBe(202);
    const { eventId } = res.json<{ eventId: string }>();
    await post(activeId, payload); // дубликат: 200, задача не добавляется
    const jobs = await queue.queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(eventId);
    expect(jobs[0]?.data).toEqual({ eventId });
  });

  describe('idempotency', () => {
    const countEvents = async (key: string) =>
      (
        await cleanupPool.query<{ n: string }>(
          'SELECT count(*) AS n FROM events WHERE endpoint_id = $1 AND idempotency_key = $2',
          [activeId, key],
        )
      ).rows[0]?.n;

    it('returns 200 duplicate with the same eventId on repeat, without a new row', async () => {
      const body = '{"dup":1}';
      const headers = { ...signed(body), 'idempotency-key': 'key-repeat' };
      const first = await post(activeId, body, headers);
      const second = await post(activeId, body, headers);
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ eventId: first.json().eventId, duplicate: true });
      expect(await countEvents('key-repeat')).toBe('1');
    });

    it('falls back to the SHA-256 of the raw body without the header', async () => {
      const body = '{"hash":"me"}';
      const first = await post(activeId, body);
      const second = await post(activeId, body);
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(200);
      expect(second.json().eventId).toBe(first.json().eventId);
    });

    it('creates exactly one row for 3 concurrent requests with one key', async () => {
      const body = '{"race":1}';
      const headers = { ...signed(body), 'idempotency-key': 'key-race' };
      const results = await Promise.all([1, 2, 3].map(() => post(activeId, body, headers)));
      expect(results.filter((r) => r.statusCode === 202)).toHaveLength(1);
      expect(new Set(results.map((r) => r.json().eventId)).size).toBe(1);
      expect(await countEvents('key-race')).toBe('1');
    });

    it('rejects an empty or oversized Idempotency-Key with 400', async () => {
      const body = '{"k":1}';
      for (const key of [' ', 'k'.repeat(256)]) {
        const res = await post(activeId, body, { ...signed(body), 'idempotency-key': key });
        expect(res.statusCode).toBe(400);
      }
    });
  });

  it('stores only whitelisted headers', async () => {
    const body = '{"h":1}';
    const res = await post(activeId, body, {
      ...signed(body),
      authorization: 'Bearer secret',
      cookie: 'sid=1',
      'user-agent': 'tester',
    });
    const { rows } = await cleanupPool.query<{ headers: Record<string, string> }>(
      'SELECT headers FROM events WHERE id = $1',
      [res.json().eventId],
    );
    const stored = rows[0]?.headers ?? {};
    expect(stored['user-agent']).toBe('tester');
    for (const k of ['x-webhook-signature', 'authorization', 'cookie']) {
      expect(stored).not.toHaveProperty(k);
    }
  });

  it('returns 413 when the body exceeds the limit', async () => {
    const res = await post(activeId, JSON.stringify({ x: 'a'.repeat(LIMIT) }));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('returns 415 for non-JSON content-type', async () => {
    const res = await post(activeId, 'hello', { 'content-type': 'text/plain' });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ error: { code: 'unsupported_media_type' } });
  });

  it('returns 415 when there is no content-type', async () => {
    const res = await app.inject({ method: 'POST', url: `/webhooks/${activeId}` });
    expect(res.statusCode).toBe(415);
  });

  it('returns 400 for malformed or empty JSON', async () => {
    for (const body of ['{"a":', '']) {
      const res = await post(activeId, body);
      expect(res.statusCode, body).toBe(400);
      expect(res.json()).toHaveProperty('error.message');
    }
  });

  it('returns 404 for unknown and inactive endpoints', async () => {
    const unknown = '00000000-0000-4000-8000-000000000002';
    expect((await post(unknown, '{}')).statusCode).toBe(404);
    expect((await post(inactiveId, '{}')).statusCode).toBe(404);
  });

  it('returns 400 for a non-UUID endpointId', async () => {
    const res = await post('abc', '{}');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation_error' } });
  });

  describe('signature', () => {
    const body = '{"a":1}';
    const expectUnauthorized = (res: { statusCode: number; json: () => unknown }) => {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'unauthorized', message: 'Invalid signature' } });
    };

    it('returns 401 without signature headers', async () => {
      expectUnauthorized(await post(activeId, body, json));
    });

    it('returns 401 for a wrong signature, secret or tampered body', async () => {
      expectUnauthorized(await post(activeId, body, signed(body, 'x'.repeat(32))));
      expectUnauthorized(await post(activeId, '{"a":2}', signed(body)));
    });

    it('returns 401 for a stale timestamp with an otherwise valid signature', async () => {
      const old = Math.floor(Date.now() / 1000) - 600;
      expectUnauthorized(await post(activeId, body, signed(body, SECRET, old)));
    });
  });
});
