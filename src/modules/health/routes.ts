import type { FastifyInstance } from 'fastify';
import { isDatabaseHealthy, type Pool } from '../../db/index.js';

export function registerHealthRoutes(app: FastifyInstance, pool: Pool): void {
  app.get('/health', async (_request, reply) => {
    const database = (await isDatabaseHealthy(pool)) ? 'connected' : 'disconnected';
    const ok = database === 'connected';
    return reply.code(ok ? 200 : 503).send({
      status: ok ? 'ok' : 'degraded',
      services: { database },
    });
  });
}
