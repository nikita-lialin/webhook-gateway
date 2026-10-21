import { ConfigError, loadWebhookSecret } from '../config/index.js';
import { computeSignature } from '../modules/ingress/signature.js';

const [endpointId, body, baseUrl = 'http://localhost:3000'] = process.argv.slice(2);

if (!endpointId || body === undefined) {
  process.stderr.write("usage: npm run sign -- <endpointId> '<json body>' [baseUrl]\n");
  process.exit(2);
}

try {
  const secret = loadWebhookSecret();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${baseUrl}/webhooks/${endpointId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature': computeSignature(Buffer.from(body, 'utf8'), timestamp, secret),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  process.stdout.write(`${res.status} ${await res.text()}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
  process.exit(1);
}
