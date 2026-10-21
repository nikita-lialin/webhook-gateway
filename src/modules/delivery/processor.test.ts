import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool, testDatabaseUrl } from '../../../test/db.js';
import type { Pool } from '../../db/index.js';
import type { DeliveryAttemptRow, EventRow } from '../../db/types.js';
import { insertEventIdempotent } from '../events/repository.js';
import { createDeliveryProcessor } from './processor.js';

describe.skipIf(!testDatabaseUrl)('delivery processor', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  const endpoints: string[] = [];
  const log = { info: () => undefined, warn: () => undefined };

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
      res.writeHead(req.url === '/ok' ? 200 : 500).end('r');
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

  const run = (eventId: string) =>
    createDeliveryProcessor(pool, log, { deliveryTimeoutMs: 1_000 })({ data: { eventId } });

  it('marks delivered and logs the attempt on 2xx', async () => {
    const id = await makeEvent('/ok');
    await run(id);
    const { event, attempts } = await state(id);
    expect(event).toMatchObject({ status: 'delivered', attempts_count: 1 });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt_number: 1, response_status: 200 });
  });

  it('marks failed and logs the attempt on 500', async () => {
    const id = await makeEvent('/bad');
    await run(id);
    const { event, attempts } = await state(id);
    expect(event).toMatchObject({ status: 'failed', attempts_count: 1 });
    expect(attempts[0]).toMatchObject({ response_status: 500, response_body: 'r' });
  });
});
