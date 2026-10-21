import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { createTestPool, testDatabaseUrl } from '../../../test/db.js';
import type { Pool } from '../../db/index.js';
import type { EventRow } from '../../db/types.js';
import { createDeliveryQueue } from '../../queue/index.js';
import { createDeliveryProcessor } from '../delivery/processor.js';

const KEY = 'k'.repeat(32);
const auth = { 'x-admin-api-key': KEY };

describe.skipIf(!testDatabaseUrl)('manual replay POST /events/:id/replay', () => {
  let app: FastifyInstance;
  let pool: Pool;
  let server: Server;
  let base: string;
  let receiverStatus = 500;
  const endpoints: string[] = [];
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

  async function endpoint(isActive = true): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO endpoints (name, source, target_url, signing_secret, is_active)
       VALUES ('replay-test', 'test', $1, 's', $2) RETURNING id`,
      [`${base}/hook`, isActive],
    );
    const id = r.rows[0]?.id as string;
    endpoints.push(id);
    return id;
  }

  async function event(endpointId: string, status: string, attempts = 0): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO events (endpoint_id, idempotency_key, payload, status, attempts_count)
       VALUES ($1, $2, '{"a":1}', $3, $4) RETURNING id`,
      [endpointId, crypto.randomUUID(), status, attempts],
    );
    return r.rows[0]?.id as string;
  }

  const replay = (id: string) =>
    app.inject({ method: 'POST', url: `/events/${id}/replay`, headers: auth });

  const row = async (id: string) =>
    (await pool.query<EventRow>('SELECT * FROM events WHERE id = $1', [id])).rows[0] as EventRow;

  const process = (eventId: string, maxRetryAttempts = 2) =>
    createDeliveryProcessor(pool, log, {
      deliveryTimeoutMs: 1_000,
      maxRetryAttempts,
      baseDelayMs: 10,
      maxDelayMs: 50,
    })({ data: { eventId } });

  beforeAll(async () => {
    pool = createTestPool(testDatabaseUrl as string);
    server = createServer((_req, res) => void res.writeHead(receiverStatus).end('r'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
    await app.ready();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM events WHERE endpoint_id = ANY($1::uuid[])', [endpoints]);
    await pool.query('DELETE FROM endpoints WHERE id = ANY($1::uuid[])', [endpoints]);
    await pool.end();
    await app.close();
    await new Promise((r) => server.close(r));
  });

  it('requires the admin key and a valid id; unknown event → 404', async () => {
    const id = crypto.randomUUID();
    expect((await app.inject({ method: 'POST', url: `/events/${id}/replay` })).statusCode).toBe(
      401,
    );
    expect((await replay('nope')).statusCode).toBe(400);
    expect((await replay(id)).statusCode).toBe(404);
  });

  it('rejects pending and processing with 409 and leaves them untouched', async () => {
    const ep = await endpoint();
    for (const status of ['pending', 'processing']) {
      const id = await event(ep, status);
      expect((await replay(id)).statusCode, status).toBe(409);
      expect(await row(id)).toMatchObject({ status, replay_count: 0 });
    }
  });

  it('rejects replay for a disabled endpoint with 409', async () => {
    const id = await event(await endpoint(false), 'dead', 3);
    const res = await replay(id);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/disabled/);
    expect(await row(id)).toMatchObject({ status: 'dead', replay_count: 0 });
  });

  it.each(['failed', 'dead', 'delivered'])(
    'resets %s to pending and starts a new cycle',
    async (status) => {
      const id = await event(await endpoint(), status, 3);
      const res = await replay(id);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ eventId: id, status: 'pending', replay: 1 });
      expect(await row(id)).toMatchObject({
        status: 'pending',
        attempts_count: 3,
        cycle_attempts_offset: 3,
        replay_count: 1,
        next_attempt_at: null,
      });
    },
  );

  it('lets only one of concurrent replays through', async () => {
    const id = await event(await endpoint(), 'dead', 1);
    const codes = (await Promise.all([replay(id), replay(id), replay(id)]))
      .map((r) => r.statusCode)
      .sort();
    expect(codes).toEqual([202, 409, 409]);
    expect((await row(id)).replay_count).toBe(1);
  });

  it('dead → replay → receiver answers 200 → delivered, numbering continues, history kept', async () => {
    const ep = await endpoint();
    const id = await event(ep, 'pending');
    receiverStatus = 500;
    await expect(process(id)).rejects.toThrow();
    await expect(process(id)).rejects.toThrow();
    expect(await row(id)).toMatchObject({ status: 'dead', attempts_count: 2 });

    receiverStatus = 200;
    expect((await replay(id)).statusCode).toBe(202);
    await process(id);

    expect(await row(id)).toMatchObject({ status: 'delivered', attempts_count: 3 });
    const attempts = await pool.query<{ attempt_number: number; response_status: number }>(
      'SELECT attempt_number, response_status FROM delivery_attempts WHERE event_id = $1 ORDER BY attempt_number',
      [id],
    );
    expect(attempts.rows).toEqual([
      { attempt_number: 1, response_status: 500 },
      { attempt_number: 2, response_status: 500 },
      { attempt_number: 3, response_status: 200 },
    ]);
  });

  it('gives a replayed event a full retry budget again', async () => {
    const id = await event(await endpoint(), 'pending');
    receiverStatus = 500;
    await expect(process(id)).rejects.toThrow();
    await expect(process(id)).rejects.toThrow();
    expect((await row(id)).status).toBe('dead');
    await replay(id);
    await expect(process(id)).rejects.toThrow();
    expect((await row(id)).status).toBe('pending');
    await expect(process(id)).rejects.toThrow();
    expect(await row(id)).toMatchObject({ status: 'dead', attempts_count: 4 });
  });
});
