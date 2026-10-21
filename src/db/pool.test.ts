import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool, testDatabaseUrl } from '../../test/db.js';
import { withTransaction, type Pool } from './pool.js';

describe.skipIf(!testDatabaseUrl)('withTransaction', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createTestPool(testDatabaseUrl as string);
    await pool.query('CREATE TABLE IF NOT EXISTS tx_probe (id int PRIMARY KEY)');
    await pool.query('TRUNCATE tx_probe');
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS tx_probe');
    await pool.end();
  });

  it('commits on success', async () => {
    await withTransaction(pool, (c) => c.query('INSERT INTO tx_probe VALUES (1)'));
    const { rows } = await pool.query('SELECT id FROM tx_probe WHERE id = 1');
    expect(rows).toHaveLength(1);
  });

  it('rolls back and rethrows on error', async () => {
    await expect(
      withTransaction(pool, async (c) => {
        await c.query('INSERT INTO tx_probe VALUES (2)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await pool.query('SELECT id FROM tx_probe WHERE id = 2');
    expect(rows).toHaveLength(0);
  });
});
