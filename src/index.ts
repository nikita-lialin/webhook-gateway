import Fastify from 'fastify';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config/index.js';
import { createPool } from './db/index.js';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  // Конфиг не загрузился, уровень логов неизвестен: пишем через pino с дефолтным уровнем.
  const log = Fastify({ logger: true }).log;
  if (err instanceof ConfigError) {
    log.fatal({ issues: err.issues }, 'invalid configuration');
  } else {
    log.fatal({ err }, 'failed to load configuration');
  }
  process.exit(1);
}
const app = buildApp(config, { pool: createPool(config) });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
