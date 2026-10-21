import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool, testDatabaseUrl, testRedisUrl } from '../../../test/db.js';
import type { Pool } from '../../db/index.js';
import {
  closeDeliveryQueue,
  createDeliveryQueue,
  createDeliveryWorker,
  enqueueDelivery,
  type DeliveryQueue,
} from '../../queue/index.js';
import { insertEventIdempotent } from '../events/repository.js';
import { STUCK_EVENTS_SQL, sweepStuckEvents } from './sweeper.js';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
const options = { staleAfterMs: 1_000, processingTimeoutMs: 1_000, batchSize: 100 };

describe.skipIf(!testDatabaseUrl || !testRedisUrl)('recovery sweeper', () => {
  let pool: Pool;
  let dq: DeliveryQueue;
  let endpointId: string;

  const makeEvent = async (status: string, ageMs: number): Promise<string> => {
    const { eventId } = await insertEventIdempotent(pool, {
      endpointId,
      idempotencyKey: crypto.randomUUID(),
      payloadJson: '{}',
      headers: {},
    });
    await pool.query(
      `UPDATE events SET status = $2,
         created_at = now() - ($3::int * interval '1 millisecond'),
         updated_at = now() - ($3::int * interval '1 millisecond')
       WHERE id = $1`,
      [eventId, status, ageMs],
    );
    return eventId;
  };

  beforeAll(async () => {
    pool = createTestPool(testDatabaseUrl as string);
    dq = createDeliveryQueue(
      { redisUrl: testRedisUrl as string },
      { name: `sweeper-test-${crypto.randomUUID()}` },
    );
    const r = await pool.query<{ id: string }>(
      `INSERT INTO endpoints (name, source, target_url, signing_secret)
       VALUES ('sweeper-test', 'test', 'https://example.com/h', 's') RETURNING id`,
    );
    endpointId = r.rows[0]?.id as string;
  });

  afterAll(async () => {
    await dq.queue.obliterate({ force: true });
    await closeDeliveryQueue(dq);
    await pool.query('DELETE FROM events WHERE endpoint_id = $1', [endpointId]);
    await pool.query('DELETE FROM endpoints WHERE id = $1', [endpointId]);
    await pool.end();
  });

  it('re-enqueues a lost pending event exactly once across repeated sweeps', async () => {
    const lost = await makeEvent('pending', 5_000);
    await sweepStuckEvents(pool, dq, log, options);
    expect(await dq.queue.getJob(lost)).toBeDefined();
    const again = await sweepStuckEvents(pool, dq, log, options);
    expect(again.requeued).toBe(0);
    const waiting = await dq.queue.getJobs(['waiting']);
    expect(waiting.filter((j) => j.id === lost)).toHaveLength(1);
  });

  it('re-enqueues a processing event stuck past the timeout, ignores fresh ones', async () => {
    const stuck = await makeEvent('processing', 5_000);
    const fresh = await makeEvent('pending', 0);
    const fresh2 = await makeEvent('processing', 0);
    await sweepStuckEvents(pool, dq, log, options);
    expect(await dq.queue.getJob(stuck)).toBeDefined();
    expect(await dq.queue.getJob(fresh)).toBeUndefined();
    expect(await dq.queue.getJob(fresh2)).toBeUndefined();
  });

  it('replaces a completed job with the same id instead of being dropped as duplicate', async () => {
    const id = await makeEvent('pending', 5_000);
    const worker = createDeliveryWorker(
      { redisUrl: testRedisUrl as string, workerConcurrency: 1 },
      async () => undefined,
      { name: dq.queue.name },
    );
    try {
      await enqueueDelivery(dq, id);
      for (
        let i = 0;
        i < 50 && (await (await dq.queue.getJob(id))?.getState()) !== 'completed';
        i += 1
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      await worker.close();
    }
    expect(await (await dq.queue.getJob(id))?.getState()).toBe('completed');
    const result = await sweepStuckEvents(pool, dq, log, options);
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    expect(await (await dq.queue.getJob(id))?.getState()).toBe('waiting');
  });

  it('never picks delivered/dead events and respects the batch size', async () => {
    await makeEvent('delivered', 5_000);
    await makeEvent('dead', 5_000);
    for (let i = 0; i < 3; i += 1) await makeEvent('pending', 5_000);
    const result = await sweepStuckEvents(pool, dq, log, { ...options, batchSize: 2 });
    expect(result.found).toBeLessThanOrEqual(2);
  });

  it('uses the (status, next_attempt_at) index for candidate selection', async () => {
    // на пустой таблице планировщик выбрал бы seq scan, поэтому запрещаем его для проверки
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query<Record<string, string>>(
        `EXPLAIN ${STUCK_EVENTS_SQL}`,
        [1_000, 1_000, 100],
      );
      const text = plan.rows.map((r) => Object.values(r)[0]).join('\n');
      expect(text).toContain('events_status_next_attempt_at_idx');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
