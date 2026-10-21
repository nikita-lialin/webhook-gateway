import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { createPool } from '../../db/index.js';
import { createTestPool, testDatabaseUrl } from '../../../test/db.js';

describe('GET /health', () => {
  it('returns 503 and disconnected when the database is down', async () => {
    const pool = createPool({
      databaseUrl: 'postgres://gateway:gateway@127.0.0.1:1/gateway',
      dbPoolMax: 1,
      dbStatementTimeoutMs: 1_000,
    });
    const app = buildApp({ logLevel: 'fatal', adminApiKey: 'k'.repeat(32) }, { pool });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', services: { database: 'disconnected' } });
    await app.close();
  });

  it.skipIf(!testDatabaseUrl)('returns 200 and connected when the database is up', async () => {
    const app = buildApp(
      { logLevel: 'fatal', adminApiKey: 'k'.repeat(32) },
      { pool: createTestPool(testDatabaseUrl as string) },
    );
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', services: { database: 'connected' } });
    await app.close();
  });

  it('closes the pool on app.close()', async () => {
    const pool = createPool({
      databaseUrl: 'postgres://gateway:gateway@127.0.0.1:1/gateway',
      dbPoolMax: 1,
      dbStatementTimeoutMs: 1_000,
    });
    const app = buildApp({ logLevel: 'fatal', adminApiKey: 'k'.repeat(32) }, { pool });
    await app.ready();
    await app.close();
    expect(pool.ended).toBe(true);
  });
});
