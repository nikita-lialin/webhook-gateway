import Fastify from 'fastify';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config/index.js';
import { createPool } from './db/index.js';
import { createDeliveryQueue, createRateLimitRedis } from './queue/index.js';

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
const app = buildApp(config, {
  pool: createPool(config),
  queue: createDeliveryQueue(config),
  rateLimitRedis: createRateLimitRedis(config),
});

let shuttingDown = false;

/** Остановка: новые соединения не принимаются, активные запросы дорабатывают, затем закрываются пул и очередь. */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const killer = setTimeout(() => {
    app.log.error({ timeoutMs: config.shutdownTimeoutMs }, 'shutdown timed out; forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  killer.unref();
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
// Состояние процесса после этих событий неопределённо: логируем и завершаемся (оркестратор перезапустит).
process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'unhandledRejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  app.log.fatal({ err }, 'uncaughtException');
  process.exit(1);
});

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
