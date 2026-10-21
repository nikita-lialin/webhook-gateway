import { loadTestDatabaseUrl } from '../src/config/index.js';
import { createPool, type Pool } from '../src/db/index.js';

/** URL тестовой БД или `undefined`, если integration-тесты не настроены. */
export const testDatabaseUrl = loadTestDatabaseUrl();

export function createTestPool(url: string): Pool {
  return createPool({ databaseUrl: url, dbPoolMax: 3, dbStatementTimeoutMs: 5_000 });
}
