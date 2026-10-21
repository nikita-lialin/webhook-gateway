import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config/index.js';
import type { Pool } from './db/index.js';
import { closeDeliveryQueue, type DeliveryQueue } from './queue/index.js';
import { registerEndpointRoutes } from './modules/endpoints/routes.js';
import { registerEventRoutes } from './modules/events/routes.js';
import { registerHealthRoutes } from './modules/health/routes.js';
import { registerErrorHandler } from './modules/http/errors.js';
import { registerIngressRoutes } from './modules/ingress/routes.js';

export interface AppDeps {
  /** Пул принадлежит приложению: закрывается в хуке onClose. */
  readonly pool: Pool;
  /** Очередь принадлежит приложению: закрывается в хуке onClose. */
  readonly queue: DeliveryQueue;
}

export function buildApp(
  config: Pick<Config, 'logLevel' | 'adminApiKey' | 'bodyLimitBytes' | 'webhookSecret'>,
  deps: AppDeps,
): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });

  deps.pool.on('error', (err) => {
    app.log.error({ err }, 'idle postgres client error');
  });
  app.addHook('onClose', async () => {
    await deps.pool.end();
    try {
      await closeDeliveryQueue(deps.queue);
    } catch (err) {
      // bullmq падает при close, если соединение с Redis так и не было установлено.
      app.log.warn({ err }, 'failed to close delivery queue cleanly');
    }
  });

  registerErrorHandler(app);
  registerHealthRoutes(app, deps.pool, deps.queue);
  registerEndpointRoutes(app, { pool: deps.pool, adminApiKey: config.adminApiKey });
  registerEventRoutes(app, {
    pool: deps.pool,
    queue: deps.queue,
    adminApiKey: config.adminApiKey,
  });
  registerIngressRoutes(app, {
    pool: deps.pool,
    queue: deps.queue,
    bodyLimitBytes: config.bodyLimitBytes,
    webhookSecret: config.webhookSecret,
  });
  return app;
}
