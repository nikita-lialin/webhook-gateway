import pg from 'pg';
import type { Config } from '../config/index.js';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

const CONNECTION_TIMEOUT_MS = 5_000;

export function createPool(
  config: Pick<Config, 'databaseUrl' | 'dbPoolMax' | 'dbStatementTimeoutMs'>,
): Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    statement_timeout: config.dbStatementTimeoutMs,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });
}

/** Выполняет `fn` в транзакции: COMMIT при успехе, ROLLBACK и проброс ошибки при сбое. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Соединение, вероятно, оборвано: пул должен его выбросить, а не переиспользовать.
      broken = rollbackErr instanceof Error ? rollbackErr : new Error('rollback failed');
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

/** `true`, если БД отвечает на простейший запрос. Ошибки не пробрасываются: это проверка состояния. */
export async function isDatabaseHealthy(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
