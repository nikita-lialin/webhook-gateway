import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';

describe('GET /health', () => {
  it('returns 200 and status ok', async () => {
    const app = buildApp({ logLevel: 'fatal' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
