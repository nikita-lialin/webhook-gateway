import { readdir } from 'node:fs/promises';
import { loadConfig } from '../config/index.js';
import { createPool } from './pool.js';

const MIGRATIONS_DIR = 'migrations';
const MIGRATIONS_TABLE = 'pgmigrations';

/** Печатает в stdout (JSON) применённые и ожидающие миграции. */
async function main(): Promise<void> {
  const pool = createPool(loadConfig());
  try {
    const table = await pool.query<{ exists: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS exists',
      [MIGRATIONS_TABLE],
    );
    const applied = table.rows[0]?.exists
      ? (await pool.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`)).rows.map(
          (r) => r.name,
        )
      : [];
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => /\.(sql|js|cjs|mjs|ts)$/.test(f))
      .map((f) => f.replace(/\.(sql|js|cjs|mjs|ts)$/, ''))
      .sort();
    const pending = files.filter((f) => !applied.includes(f));
    process.stdout.write(`${JSON.stringify({ applied, pending }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`migrate:status failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
