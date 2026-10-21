import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config/index.js';
import type { Pool } from './db/index.js';
import { registerEndpointRoutes } from './modules/endpoints/routes.js';
import { registerHealthRoutes } from './modules/health/routes.js';

export interface AppDeps {
  /** Пул принадлежит приложению: закрывается в хуке onClose. */
  readonly pool: Pool;
}

export function buildApp(
  config: Pick<Config, 'logLevel' | 'adminApiKey'>,
  deps: AppDeps,
): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });

  deps.pool.on('error', (err) => {
    app.log.error({ err }, 'idle postgres client error');
  });
  app.addHook('onClose', async () => {
    await deps.pool.end();
  });

  registerHealthRoutes(app, deps.pool);
  registerEndpointRoutes(app, { pool: deps.pool, adminApiKey: config.adminApiKey });
  return app;
}
