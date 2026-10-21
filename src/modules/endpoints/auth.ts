import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const ADMIN_KEY_HEADER = 'x-admin-api-key';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Сравнение через `timingSafeEqual`; хеширование выравнивает длины, поэтому длина ключа не утекает по времени. */
export function isValidAdminKey(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = digest(provided);
  const b = digest(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAdminAuth(adminApiKey: string) {
  return async function adminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!isValidAdminKey(request.headers[ADMIN_KEY_HEADER], adminApiKey)) {
      request.log.warn('admin auth failed');
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'Missing or invalid admin API key' } });
    }
  };
}
