import Fastify from 'fastify';
import { ConfigError, loadConfig, type Config } from './config/index.js';
import { createPool } from './db/index.js';
import { createDeliveryWorker } from './queue/index.js';
import { createDeliveryProcessor } from './modules/delivery/processor.js';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  const log = Fastify({ logger: true }).log;
  if (err instanceof ConfigError) {
    log.fatal({ issues: err.issues }, 'invalid configuration');
  } else {
    log.fatal({ err }, 'failed to load configuration');
  }
  process.exit(1);
}

// Fastify используется только как фабрика pino-логгера (тот же JSON-формат, что у app).
const log = Fastify({ logger: { level: config.logLevel } }).log;
const pool = createPool(config);
const worker = createDeliveryWorker(config, createDeliveryProcessor(pool, log));

worker.on('error', (err) => log.error({ err }, 'worker error'));
worker.on('failed', (job, err) => log.error({ err, jobId: job?.id }, 'job failed'));
log.info({ concurrency: config.workerConcurrency }, 'worker started');

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  try {
    await worker.close();
    await pool.end();
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
