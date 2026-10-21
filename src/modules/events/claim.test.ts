import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool, testDatabaseUrl } from '../../../test/db.js';
import type { Pool } from '../../db/index.js';
import { claimEventForProcessing, insertEventIdempotent } from './repository.js';

describe.skipIf(!testDatabaseUrl)('claimEventForProcessing', () => {
  let pool: Pool;
  let endpointId: string;

  const makeEvent = async (status: string): Promise<string> => {
    const { eventId } = await insertEventIdempotent(pool, {
      endpointId,
      idempotencyKey: crypto.randomUUID(),
      payloadJson: '{}',
      headers: {},
    });
    await pool.query('UPDATE events SET status = $2 WHERE id = $1', [eventId, status]);
    return eventId;
  };

  beforeAll(async () => {
    pool = createTestPool(testDatabaseUrl as string);
    const r = await pool.query<{ id: string }>(
      `INSERT INTO endpoints (name, source, target_url, signing_secret)
       VALUES ('claim-test', 'test', 'https://example.com/h', 's') RETURNING id`,
    );
    endpointId = r.rows[0]?.id as string;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM events WHERE endpoint_id = $1', [endpointId]);
    await pool.query('DELETE FROM endpoints WHERE id = $1', [endpointId]);
    await pool.end();
  });

  it('moves pending/failed events to processing', async () => {
    for (const status of ['pending', 'failed']) {
      const claimed = await claimEventForProcessing(pool, await makeEvent(status));
      expect(claimed?.status).toBe('processing');
    }
  });

  it('skips delivered, dead and missing events', async () => {
    for (const status of ['delivered', 'dead']) {
      const id = await makeEvent(status);
      expect(await claimEventForProcessing(pool, id)).toBeNull();
      const row = await pool.query<{ status: string }>('SELECT status FROM events WHERE id = $1', [
        id,
      ]);
      expect(row.rows[0]?.status).toBe(status);
    }
    expect(await claimEventForProcessing(pool, crypto.randomUUID())).toBeNull();
  });
});
