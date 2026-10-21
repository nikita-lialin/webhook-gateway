import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { computeSignature } from './signature.js';
import { createTestPool, testDatabaseUrl } from '../../../test/db.js';
import type { Pool } from '../../db/index.js';

const LIMIT = 1024;
const SECRET = 'w'.repeat(32);
const json = { 'content-type': 'application/json' };

const signed = (payload: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)) => ({
  ...json,
  'x-webhook-timestamp': String(ts),
  'x-webhook-signature': computeSignature(Buffer.from(payload), String(ts), secret),
});

describe.skipIf(!testDatabaseUrl)('POST /webhooks/:endpointId', () => {
  let app: FastifyInstance;
  let cleanupPool: Pool;
  let activeId: string;
  let inactiveId: string;

  beforeAll(async () => {
    app = buildApp(
      { logLevel: 'fatal', adminApiKey: 'k'.repeat(32), bodyLimitBytes: LIMIT, webhookSecret: SECRET },
      { pool: createTestPool(testDatabaseUrl as string) },
    );
    cleanupPool = createTestPool(testDatabaseUrl as string);
    await app.ready();
    const insert = async (active: boolean) =>
      (
        await cleanupPool.query<{ id: string }>(
          `INSERT INTO endpoints (name, source, target_url, signing_secret, is_active)
           VALUES ('ingress-test', 'test', 'https://example.com/h', 's', $1) RETURNING id`,
          [active],
        )
      ).rows[0]?.id as string;
    activeId = await insert(true);
    inactiveId = await insert(false);
  });

  afterAll(async () => {
    await cleanupPool.query('DELETE FROM endpoints WHERE id = ANY($1::uuid[])', [
      [activeId, inactiveId],
    ]);
    await cleanupPool.end();
    await app.close();
  });

  const post = (id: string, payload: string, headers?: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: `/webhooks/${id}`,
      headers: headers ?? signed(payload),
      payload,
    });

  it('accepts valid JSON with 202', async () => {
    const res = await post(activeId, '{"a":1}');
    expect(res.statusCode).toBe(202);
  });

  it('returns 413 when the body exceeds the limit', async () => {
    const res = await post(activeId, JSON.stringify({ x: 'a'.repeat(LIMIT) }));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('returns 415 for non-JSON content-type', async () => {
    const res = await post(activeId, 'hello', { 'content-type': 'text/plain' });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ error: { code: 'unsupported_media_type' } });
  });

  it('returns 415 when there is no content-type', async () => {
    const res = await app.inject({ method: 'POST', url: `/webhooks/${activeId}` });
    expect(res.statusCode).toBe(415);
  });

  it('returns 400 for malformed or empty JSON', async () => {
    for (const body of ['{"a":', '']) {
      const res = await post(activeId, body);
      expect(res.statusCode, body).toBe(400);
      expect(res.json()).toHaveProperty('error.message');
    }
  });

  it('returns 404 for unknown and inactive endpoints', async () => {
    const unknown = '00000000-0000-4000-8000-000000000002';
    expect((await post(unknown, '{}')).statusCode).toBe(404);
    expect((await post(inactiveId, '{}')).statusCode).toBe(404);
  });

  it('returns 400 for a non-UUID endpointId', async () => {
    const res = await post('abc', '{}');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation_error' } });
  });

  describe('signature', () => {
    const body = '{"a":1}';
    const expectUnauthorized = (res: { statusCode: number; json: () => unknown }) => {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'unauthorized', message: 'Invalid signature' } });
    };

    it('returns 401 without signature headers', async () => {
      expectUnauthorized(await post(activeId, body, json));
    });

    it('returns 401 for a wrong signature, secret or tampered body', async () => {
      expectUnauthorized(await post(activeId, body, signed(body, 'x'.repeat(32))));
      expectUnauthorized(await post(activeId, '{"a":2}', signed(body)));
    });

    it('returns 401 for a stale timestamp with an otherwise valid signature', async () => {
      const old = Math.floor(Date.now() / 1000) - 600;
      expectUnauthorized(await post(activeId, body, signed(body, SECRET, old)));
    });
  });
});
