import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifySignature } from '../ingress/signature.js';
import { dispatch, MAX_RESPONSE_BODY_BYTES } from './dispatcher.js';

const SECRET = 'test-signing-secret';
const event = { id: 'evt-1', payload: { hello: 'world' } };

describe('dispatch', () => {
  let server: Server;
  let base: string;
  let received: { headers: IncomingMessage['headers']; body: Buffer } | undefined;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received = { headers: req.headers, body: Buffer.concat(chunks) };
        switch (req.url) {
          case '/ok':
            res.writeHead(200).end('fine');
            break;
          case '/500':
            res.writeHead(500).end('boom');
            break;
          case '/redirect':
            res.writeHead(302, { location: '/ok' }).end();
            break;
          case '/slow':
            setTimeout(() => res.writeHead(200).end('late'), 2_000).unref();
            break;
          case '/reset':
            req.socket.destroy();
            break;
          case '/big':
            res.writeHead(200).end('x'.repeat(100_000));
            break;
          default:
            res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const run = (path: string, timeoutMs = 1_000) =>
    dispatch(event, { target_url: base + path, signing_secret: SECRET }, { timeoutMs });

  it('delivers on 2xx with verifiable signature and webhook headers', async () => {
    const r = await run('/ok');
    expect(r).toMatchObject({ ok: true, responseStatus: 200, responseBody: 'fine', error: null });
    const h = received?.headers ?? {};
    expect(h['x-webhook-id']).toBe('evt-1');
    expect(JSON.parse(received?.body.toString() ?? '')).toEqual(event.payload);
    const verdict = verifySignature(
      received?.body as Buffer,
      h['x-webhook-timestamp'] as string,
      h['x-webhook-signature'] as string,
      SECRET,
      Date.now(),
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('treats 500 as failure and keeps the response', async () => {
    expect(await run('/500')).toMatchObject({
      ok: false,
      responseStatus: 500,
      responseBody: 'boom',
    });
  });

  it('does not follow redirects', async () => {
    expect(await run('/redirect')).toMatchObject({ ok: false, responseStatus: 302 });
  });

  it('aborts on timeout', async () => {
    const r = await run('/slow', 100);
    expect(r).toMatchObject({ ok: false, responseStatus: null });
    expect(r.error).toMatch(/timeout/);
  });

  it('reports a dropped connection', async () => {
    const r = await run('/reset');
    expect(r).toMatchObject({ ok: false, responseStatus: null });
    expect(r.error).toBeTruthy();
  });

  it('truncates the response body to 4 KB', async () => {
    const r = await run('/big');
    expect(r.ok).toBe(true);
    expect(r.responseBody?.length).toBe(MAX_RESPONSE_BODY_BYTES);
  });
});
