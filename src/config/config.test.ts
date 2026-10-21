import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './index.js';

const SECRET = 'a'.repeat(32);

const validEnv = {
  DATABASE_URL: 'postgres://gateway:gateway@localhost:5432/gateway',
  REDIS_URL: 'redis://localhost:6379',
  WEBHOOK_SECRET: SECRET,
  ADMIN_API_KEY: 'b'.repeat(32),
};

describe('loadConfig', () => {
  it('parses valid env and applies defaults', () => {
    const config = loadConfig(validEnv);
    expect(config).toMatchObject({
      nodeEnv: 'development',
      port: 3000,
      logLevel: 'info',
      workerConcurrency: 5,
      maxRetryAttempts: 8,
      webhookSecret: SECRET,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('coerces numeric strings', () => {
    expect(loadConfig({ ...validEnv, PORT: '8080', WORKER_CONCURRENCY: '2' })).toMatchObject({
      port: 8080,
      workerConcurrency: 2,
    });
  });

  it('fails without a required variable', () => {
    const env: NodeJS.ProcessEnv = { ...validEnv };
    delete env.WEBHOOK_SECRET;
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/WEBHOOK_SECRET/);
  });

  it('requires ADMIN_API_KEY of at least 32 chars', () => {
    const env: NodeJS.ProcessEnv = { ...validEnv };
    delete env.ADMIN_API_KEY;
    expect(() => loadConfig(env)).toThrow(/ADMIN_API_KEY/);
    expect(() => loadConfig({ ...validEnv, ADMIN_API_KEY: 'short' })).toThrow(/ADMIN_API_KEY/);
  });

  it('fails on wrong type', () => {
    expect(() => loadConfig({ ...validEnv, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...validEnv, MAX_RETRY_ATTEMPTS: '0' })).toThrow(
      /MAX_RETRY_ATTEMPTS/,
    );
  });

  it('does not leak values into the error message', () => {
    const secret = 'short-secret-value';
    try {
      loadConfig({ ...validEnv, WEBHOOK_SECRET: secret, LOG_LEVEL: 'verbose-leak' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain('WEBHOOK_SECRET');
      expect(message).not.toContain(secret);
      expect(message).not.toContain('verbose-leak');
    }
  });
});
