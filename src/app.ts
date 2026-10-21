import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config/index.js';
import { registerHealthRoutes } from './modules/health/routes.js';

export function buildApp(config: Pick<Config, 'logLevel'>): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });
  registerHealthRoutes(app);
  return app;
}
