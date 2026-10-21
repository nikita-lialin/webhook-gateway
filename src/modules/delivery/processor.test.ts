import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool, testDatabaseUrl } from '../../../test/db.js';
import type { Pool } from '../../db/index.js';
import type { DeliveryAttemptRow, EventRow } from '../../db/types.js';
import { insertEventIdempotent } from '../events/repository.js';
import { createDeliveryProcessor } from './processor.js';
import { RetryableDeliveryError } from './retry.js';

describe.skipIf(!testDatabaseUrl)('delivery processor', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  const endpoints: string[] = [];
  let flakyHits = 0;
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const dead: unknown[] = [];

  const makeEvent = async (path: string): Promise<string> => {
    const e = await pool.query<{ id: string }>(
      `INSERT INTO endpoints (name, source, target_url, signing_secret)
       VALUES ('proc-test', 'test', $1, 's') RETURNING id`,
      [base + path],
    );
    const endpointId = e.rows[0]?.id as string;
    endpoints.push(endpointId);
    const { eventId } = await insertEventIdempotent(pool, {
      endpointId,
      idempotencyKey: crypto.randomUUID(),
      payloadJson: '{"a":1}',
      headers: {},
    });
    return eventId;
  };

  beforeAll(async () => {
    pool = createTestPool(testDatabaseUrl as string);
    server = createServer((req, res) => {
      if (req.url?.startsWith('/flaky')) {
        flakyHits += 1;
        res.writeHead(flakyHits <= 2 ? 500 : 200).end('r');
        return;
      }
      const status = { '/ok': 200, '/bad': 500, '/gone': 404 }[req.url ?? ''] ?? 500;
      res.writeHead(status).end('r');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM events WHERE endpoint_id = ANY($1::uuid[])', [endpoints]);
    await pool.query('DELETE FROM endpoints WHERE id = ANY($1::uuid[])', [endpoints]);
    await pool.end();
    await new Promise((r) => server.close(r));
  });

  const state = async (eventId: string) => {
    const ev = await pool.query<EventRow>('SELECT * FROM events WHERE id = $1', [eventId]);
    const at = await pool.query<DeliveryAttemptRow>(
      'SELECT * FROM delivery_attempts WHERE event_id = $1',
      [eventId],
    );
    return { event: ev.rows[0], attempts: at.rows };
  };

  const run = (eventId: string, maxRetryAttempts = 3) =>
    createDeliveryProcessor(pool, log, {
      deliveryTimeoutMs: 1_000,
      maxRetryAttempts,
      baseDelayMs: 10,
      maxDelayMs: 50,
      onDead: async (letter) => void dead.push(letter),
    })({ data: { eventId } });

  it('marks delivered and logs the attempt on 2xx', async () => {
    const id = await makeEvent('/ok');
    await run(id);
    const { event, attempts } = await state(id);
    expect(event).toMatchObject({ status: 'delivered', attempts_count: 1 });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt_number: 1, response_status: 200 });
  });

  it('returns to pending with next_attempt_at after a retryable failure', async () => {
    const id = await makeEvent('/bad');
    await expect(run(id)).rejects.toBeInstanceOf(RetryableDeliveryError);
    const { event, attempts } = await state(id);
    expect(event).toMatchObject({ status: 'pending', attempts_count: 1 });
    expect(event?.next_attempt_at).toBeInstanceOf(Date);
    expect(attempts[0]).toMatchObject({ response_status: 500, response_body: 'r' });
  });

  it('fails immediately on a non-retryable 4xx', async () => {
    const id = await makeEvent('/gone');
    await expect(run(id)).rejects.toBeInstanceOf(UnrecoverableError);
    const { event } = await state(id);
    expect(event).toMatchObject({ status: 'failed', attempts_count: 1, next_attempt_at: null });
  });

  it('marks dead and sends to DLQ after exactly MAX attempts of a receiver that always 500s', async () => {
    const id = await makeEvent('/bad');
    dead.length = 0;
    await expect(run(id, 3)).rejects.toBeInstanceOf(RetryableDeliveryError);
    await expect(run(id, 3)).rejects.toBeInstanceOf(RetryableDeliveryError);
    expect(dead).toHaveLength(0);
    await expect(run(id, 3)).rejects.toBeInstanceOf(UnrecoverableError);
    const { event, attempts } = await state(id);
    expect(event).toMatchObject({ status: 'dead', attempts_count: 3, next_attempt_at: null });
    expect(attempts).toHaveLength(3);
    expect(dead).toEqual([
      { eventId: id, endpointId: event?.endpoint_id, attempts: 3, reason: 'HTTP 500' },
    ]);
    await run(id, 3);
    expect((await state(id)).attempts).toHaveLength(3);
  });

  it('keeps failed (not dead) for a non-retryable 4xx', async () => {
    const id = await makeEvent('/gone');
    dead.length = 0;
    await expect(run(id)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(dead).toHaveLength(0);
  });

  it('delivers on the third attempt after two 500s', async () => {
    flakyHits = 0;
    const id = await makeEvent('/flaky');
    await expect(run(id)).rejects.toBeInstanceOf(RetryableDeliveryError);
    await expect(run(id)).rejects.toBeInstanceOf(RetryableDeliveryError);
    await run(id);
    const { event, attempts } = await state(id);
    expect(event).toMatchObject({ status: 'delivered', attempts_count: 3, next_attempt_at: null });
    expect(attempts.map((a) => a.attempt_number).sort()).toEqual([1, 2, 3]);
  });
});
