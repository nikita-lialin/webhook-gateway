import { afterAll, describe, expect, it } from 'vitest';
import { testRedisUrl } from '../../test/db.js';
import {
  closeDeliveryQueue,
  createDeliveryQueue,
  enqueueDelivery,
  enqueueReplay,
} from './index.js';

describe.skipIf(!testRedisUrl)('enqueueReplay', () => {
  const dq = createDeliveryQueue(
    { redisUrl: testRedisUrl as string, maxRetryAttempts: 3 },
    { name: `replay-test-${crypto.randomUUID()}` },
  );
  afterAll(async () => {
    await dq.queue.obliterate({ force: true });
    await closeDeliveryQueue(dq);
  });

  it('adds a job with a fresh id even when the original job already exists', async () => {
    const eventId = crypto.randomUUID();
    await enqueueDelivery(dq, eventId);
    await enqueueReplay(dq, eventId, 1);
    await enqueueReplay(dq, eventId, 2);
    expect(await dq.queue.getJob(`${eventId}:replay:1`)).toBeDefined();
    expect(await dq.queue.getJob(`${eventId}:replay:2`)).toBeDefined();
    expect(await dq.queue.getJobCounts('waiting')).toMatchObject({ waiting: 3 });
  });
});
