import type { FastifyInstance } from 'fastify';
import { isDatabaseHealthy, type Pool } from '../../db/index.js';
import { isRedisHealthy, type DeliveryQueue } from '../../queue/index.js';

export function registerHealthRoutes(app: FastifyInstance, pool: Pool, queue: DeliveryQueue): void {
  app.get('/health', async (_request, reply) => {
    const database = (await isDatabaseHealthy(pool)) ? 'connected' : 'disconnected';
    const redis = (await isRedisHealthy(queue)) ? 'connected' : 'disconnected';
    const ok = database === 'connected' && redis === 'connected';
    return reply.code(ok ? 200 : 503).send({
      status: ok ? 'ok' : 'degraded',
      services: { database, redis },
    });
  });
}
