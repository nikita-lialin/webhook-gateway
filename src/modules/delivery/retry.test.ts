import { describe, expect, it } from 'vitest';
import {
  backoffStrategy,
  computeBackoffDelay,
  isRetryable,
  parseRetryAfter,
  RetryableDeliveryError,
} from './retry.js';

const opts = { baseDelayMs: 1_000, maxDelayMs: 10_000 };
const max = () => 0.999999;

describe('isRetryable', () => {
  it.each([null, 500, 502, 503, 599, 408, 429])('retries %s', (responseStatus) => {
    expect(isRetryable({ responseStatus })).toBe(true);
  });
  it.each([301, 302, 400, 401, 403, 404, 410, 422])('does not retry %s', (responseStatus) => {
    expect(isRetryable({ responseStatus })).toBe(false);
  });
});

describe('computeBackoffDelay', () => {
  it('grows exponentially up to the ceiling', () => {
    expect([1, 2, 3, 4].map((n) => computeBackoffDelay(n, opts, null, max))).toEqual([
      999, 1_999, 3_999, 7_999,
    ]);
  });
  it('caps at maxDelayMs, also for huge attempt numbers', () => {
    expect(computeBackoffDelay(5, opts, null, max)).toBe(9_999);
    expect(computeBackoffDelay(2000, opts, null, max)).toBe(9_999);
  });
  it('applies full jitter between 0 and the ceiling', () => {
    expect(computeBackoffDelay(3, opts, null, () => 0)).toBe(0);
    expect(computeBackoffDelay(3, opts, null, () => 0.5)).toBe(2_000);
  });
  it('respects Retry-After as a lower bound, but not above the ceiling', () => {
    expect(computeBackoffDelay(1, opts, 5_000, () => 0)).toBe(5_000);
    expect(computeBackoffDelay(1, opts, 60_000, () => 0)).toBe(10_000);
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and dates', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 4_000)).toBe(6_000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:01 GMT', 4_000)).toBe(0);
  });
  it('returns null for missing or invalid values', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('backoffStrategy', () => {
  it('uses the delay carried by the error', () => {
    expect(backoffStrategy(opts)(1, 'custom', new RetryableDeliveryError('x', 4_321))).toBe(4_321);
  });
  it('falls back to the formula for other errors', () => {
    expect(backoffStrategy(opts)(1, 'custom', new Error('x'))).toBeLessThanOrEqual(1_000);
  });
});
