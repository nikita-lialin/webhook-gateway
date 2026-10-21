import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';

type TrustProxyFn = (address: string, hop: number) => boolean;
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
  /** Redis для счётчиков rate limit; принадлежит приложению. Без него лимитер выключен (тесты). */
  readonly rateLimitRedis?: Redis;
}

/** Fastify не принимает число хопов напрямую: доверяем первым `n` прокси справа в X-Forwarded-For. */
function toTrustProxy(
  value: boolean | number | string | undefined,
): boolean | string | TrustProxyFn {
  if (typeof value === 'number') return (_address, hop) => hop <= value;
  return value ?? false;
}

export function buildApp(
  config: Pick<Config, 'logLevel' | 'adminApiKey' | 'bodyLimitBytes' | 'webhookSecret'> &
    Partial<
      Pick<Config, 'trustProxy' | 'rateLimitWindowMs' | 'rateLimitIpMax' | 'rateLimitEndpointMax'>
    >,
  deps: AppDeps,
): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: toTrustProxy(config.trustProxy),
  });

  deps.pool.on('error', (err) => {
    app.log.error({ err }, 'idle postgres client error');
  });
  const limiterRedis = deps.rateLimitRedis;
  limiterRedis?.on('error', (err) => {
    app.log.warn({ err }, 'rate limit redis error; limiter fails open');
  });
  app.addHook('onClose', async () => {
    if (limiterRedis) limiterRedis.disconnect();
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
    rateLimit: limiterRedis && {
      redis: limiterRedis,
      windowMs: config.rateLimitWindowMs ?? 60_000,
      ipMax: config.rateLimitIpMax ?? 300,
      endpointMax: config.rateLimitEndpointMax ?? 100,
    },
  });
  return app;
}
