import { describe, expect, it } from 'vitest';
import { computeSignature, verifySignature } from './signature.js';

const SECRET = 's'.repeat(32);
const NOW = 1_700_000_000_000;
const TS = String(NOW / 1000);
const body = Buffer.from('{"event":"paid"}');
const valid = computeSignature(body, TS, SECRET);

describe('verifySignature', () => {
  it('accepts a valid signature', () => {
    expect(verifySignature(body, TS, valid, SECRET, NOW)).toEqual({ ok: true });
  });

  it('rejects a body with one changed byte', () => {
    const tampered = Buffer.from(body);
    tampered[2] = (tampered[2] ?? 0) ^ 1;
    expect(verifySignature(tampered, TS, valid, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a wrong secret', () => {
    expect(verifySignature(body, TS, valid, 'x'.repeat(32), NOW).ok).toBe(false);
  });

  it('rejects a signature of a different length without throwing', () => {
    for (const sig of [valid.slice(0, -2), `${valid}00`, 'sha256=', 'sha256=zz']) {
      expect(verifySignature(body, TS, sig, SECRET, NOW).ok, sig).toBe(false);
    }
  });

  it('rejects missing headers', () => {
    expect(verifySignature(body, undefined, valid, SECRET, NOW).ok).toBe(false);
    expect(verifySignature(body, TS, undefined, SECRET, NOW).ok).toBe(false);
  });

  it('rejects an expired timestamp', () => {
    const ts = String(NOW / 1000 - 301);
    expect(verifySignature(body, ts, computeSignature(body, ts, SECRET), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'timestamp_out_of_window',
    });
  });

  it('rejects a timestamp from the future', () => {
    const ts = String(NOW / 1000 + 301);
    expect(verifySignature(body, ts, computeSignature(body, ts, SECRET), SECRET, NOW).ok).toBe(
      false,
    );
  });

  it('accepts timestamps at the edge of the window', () => {
    for (const delta of [-300, 300]) {
      const ts = String(NOW / 1000 + delta);
      expect(verifySignature(body, ts, computeSignature(body, ts, SECRET), SECRET, NOW).ok).toBe(
        true,
      );
    }
  });

  it('rejects a non-numeric timestamp', () => {
    expect(verifySignature(body, 'abc', valid, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'malformed_timestamp',
    });
  });
});
