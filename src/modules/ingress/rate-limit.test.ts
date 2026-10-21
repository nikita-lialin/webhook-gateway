import type { FastifyInstance } from 'fastify';
import { setTimeout } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { createDeliveryQueue, createRateLimitRedis } from '../../queue/index.js';
import { createTestPool, testRedisUrl } from '../../../test/db.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const json = { 'content-type': 'application/json' };

// Без офлайн-очереди команды до готовности соединения отбрасываются (fail-open), поэтому ждём ready.
async function build(
  redisUrl: string,
  ipMax: number,
  endpointMax: number,
  waitReady = true,
): Promise<FastifyInstance> {
  const redis = createRateLimitRedis({ redisUrl }, 200);
  if (waitReady) {
    for (let i = 0; i < 50 && redis.status !== 'ready'; i++) await setTimeout(50);
  }
  // Пул ленивый и не используется: неподписанный запрос отклоняется до обращения к БД.
  return buildApp(
    {
      logLevel: 'fatal',
      adminApiKey: 'k'.repeat(32),
      bodyLimitBytes: 1024,
      webhookSecret: 'w'.repeat(32),
      rateLimitWindowMs: 60_000,
      rateLimitIpMax: ipMax,
      rateLimitEndpointMax: endpointMax,
    },
    {
      pool: createTestPool('postgres://x:x@127.0.0.1:1/x'),
      queue: createDeliveryQueue({ redisUrl }, { name: `rl-test-${process.pid}`, timeoutMs: 200 }),
      rateLimitRedis: redis,
    },
  );
}

const post = (app: FastifyInstance, id: string) =>
  app.inject({ method: 'POST', url: `/webhooks/${id}`, headers: json, payload: '{}' });

describe('ingress rate limit', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.skipIf(!testRedisUrl)('превышение лимита на эндпоинт → 429 с Retry-After', async () => {
    app = await build(testRedisUrl as string, 1000, 2);
    const id = crypto.randomUUID();
    expect((await post(app, id)).statusCode).toBe(401);
    expect((await post(app, id)).statusCode).toBe(401);
    const res = await post(app, id);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.json()).toMatchObject({ error: { code: 'rate_limited' } });
    // другой эндпоинт с того же IP лимитом эндпоинта не затронут
    expect((await post(app, crypto.randomUUID())).statusCode).toBe(401);
  });

  it.skipIf(!testRedisUrl)('превышение лимита по IP → 429', async () => {
    app = await build(testRedisUrl as string, 1, 1000);
    // Счётчик IP живёт в Redis в рамках окна, поэтому лимит мог быть исчерпан ещё до первого запроса.
    await post(app, ID_A);
    expect((await post(app, ID_B)).statusCode).toBe(429);
  });

  it('Redis недоступен → fail-open, запросы не блокируются', async () => {
    app = await build('redis://127.0.0.1:1', 1, 1, false);
    for (let i = 0; i < 4; i++) {
      expect((await post(app, ID_A)).statusCode).toBe(401);
    }
  });
});
