import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { createTestPool, testDatabaseUrl } from '../../../test/db.js';
import type { Pool } from '../../db/index.js';
import { isValidAdminKey } from './auth.js';

const KEY = 'k'.repeat(32);
const auth = { 'x-admin-api-key': KEY };

describe('isValidAdminKey', () => {
  it('accepts only the exact key', () => {
    expect(isValidAdminKey(KEY, KEY)).toBe(true);
    expect(isValidAdminKey('k'.repeat(31), KEY)).toBe(false);
    expect(isValidAdminKey(`${KEY}x`, KEY)).toBe(false);
    expect(isValidAdminKey('', KEY)).toBe(false);
    expect(isValidAdminKey(undefined, KEY)).toBe(false);
    expect(isValidAdminKey([KEY], KEY)).toBe(false);
  });
});

describe.skipIf(!testDatabaseUrl)('admin API /endpoints', () => {
  let app: FastifyInstance;
  let cleanupPool: Pool;
  const created: string[] = [];

  beforeAll(async () => {
    app = buildApp(
      { logLevel: 'fatal', adminApiKey: KEY },
      { pool: createTestPool(testDatabaseUrl as string) },
    );
    cleanupPool = createTestPool(testDatabaseUrl as string);
    await app.ready();
  });

  afterAll(async () => {
    await cleanupPool.query('DELETE FROM endpoints WHERE id = ANY($1::uuid[])', [created]);
    await cleanupPool.end();
    await app.close();
  });

  async function create(overrides: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/endpoints',
      headers: auth,
      payload: {
        name: 'n',
        source: 'stripe',
        target_url: 'https://example.com/hook',
        ...overrides,
      },
    });
    if (res.statusCode === 201) created.push(res.json<{ id: string }>().id);
    return res;
  }

  it('returns 401 without or with a wrong key on every route', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (const [method, url] of [
      ['POST', '/endpoints'],
      ['GET', '/endpoints'],
      ['GET', `/endpoints/${id}`],
      ['PATCH', `/endpoints/${id}`],
    ] as const) {
      const none = await app.inject({ method, url });
      expect(none.statusCode, `${method} ${url}`).toBe(401);
      const wrong = await app.inject({
        method,
        url,
        headers: { 'x-admin-api-key': 'x'.repeat(32) },
      });
      expect(wrong.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('creates an endpoint and returns signing_secret exactly once', async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; signing_secret: string; is_active: boolean }>();
    expect(body.signing_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.is_active).toBe(true);

    const got = await app.inject({ method: 'GET', url: `/endpoints/${body.id}`, headers: auth });
    expect(got.statusCode).toBe(200);
    expect(got.json()).not.toHaveProperty('signing_secret');
    expect(got.body).not.toContain(body.signing_secret);

    const list = await app.inject({ method: 'GET', url: '/endpoints', headers: auth });
    expect(list.statusCode).toBe(200);
    const items = list.json<{ items: { id: string }[] }>().items;
    expect(items.some((e) => e.id === body.id)).toBe(true);
    expect(list.body).not.toContain(body.signing_secret);
  });

  it('rejects invalid target_url and bad bodies with 400', async () => {
    for (const target_url of [
      'ftp://example.com',
      'javascript:alert(1)',
      'not a url',
      'file:///etc/passwd',
    ]) {
      expect((await create({ target_url })).statusCode, target_url).toBe(400);
    }
    expect((await create({ name: '' })).statusCode).toBe(400);
    expect((await create({ extra: 1 })).statusCode).toBe(400);
  });

  it('deactivates and changes target_url via PATCH', async () => {
    const { id } = (await create()).json<{ id: string }>();
    const off = await app.inject({
      method: 'PATCH',
      url: `/endpoints/${id}`,
      headers: auth,
      payload: { is_active: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({
      id,
      is_active: false,
      target_url: 'https://example.com/hook',
    });
    expect(off.json()).not.toHaveProperty('signing_secret');

    const moved = await app.inject({
      method: 'PATCH',
      url: `/endpoints/${id}`,
      headers: auth,
      payload: { target_url: 'http://example.org/new' },
    });
    expect(moved.json()).toMatchObject({ is_active: false, target_url: 'http://example.org/new' });

    const bad = await app.inject({
      method: 'PATCH',
      url: `/endpoints/${id}`,
      headers: auth,
      payload: { target_url: 'ftp://x' },
    });
    expect(bad.statusCode).toBe(400);
    const empty = await app.inject({
      method: 'PATCH',
      url: `/endpoints/${id}`,
      headers: auth,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  it('returns 404 for unknown id and 400 for a non-UUID id', async () => {
    const unknown = '00000000-0000-4000-8000-000000000001';
    expect(
      (await app.inject({ method: 'GET', url: `/endpoints/${unknown}`, headers: auth })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/endpoints/${unknown}`,
          headers: auth,
          payload: { is_active: false },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/endpoints/abc', headers: auth })).statusCode,
    ).toBe(400);
  });
});
