import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.url(),
    TEST_DATABASE_URL: z.url().optional(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    REDIS_URL: z.url(),
    WEBHOOK_SECRET: z.string().min(32),
    ADMIN_API_KEY: z.string().min(32),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
    MAX_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(8),
    RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(1_000),
    RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(3_600_000),
    DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  })
  .refine((e) => e.RETRY_MAX_DELAY_MS >= e.RETRY_BASE_DELAY_MS, {
    path: ['RETRY_MAX_DELAY_MS'],
    message: 'must be >= RETRY_BASE_DELAY_MS',
  });

export type NodeEnv = z.infer<typeof envSchema>['NODE_ENV'];
export type LogLevel = z.infer<typeof envSchema>['LOG_LEVEL'];

export interface Config {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  readonly testDatabaseUrl: string | undefined;
  readonly dbPoolMax: number;
  readonly dbStatementTimeoutMs: number;
  readonly redisUrl: string;
  readonly webhookSecret: string;
  readonly adminApiKey: string;
  readonly workerConcurrency: number;
  readonly maxRetryAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly deliveryTimeoutMs: number;
  readonly bodyLimitBytes: number;
}

/** Ошибка конфигурации: сообщения содержат только имена переменных и причины, но не их значения. */
export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  const e = result.data;
  return Object.freeze({
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    testDatabaseUrl: e.TEST_DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    dbStatementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
    redisUrl: e.REDIS_URL,
    webhookSecret: e.WEBHOOK_SECRET,
    adminApiKey: e.ADMIN_API_KEY,
    workerConcurrency: e.WORKER_CONCURRENCY,
    maxRetryAttempts: e.MAX_RETRY_ATTEMPTS,
    retryBaseDelayMs: e.RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: e.RETRY_MAX_DELAY_MS,
    deliveryTimeoutMs: e.DELIVERY_TIMEOUT_MS,
    bodyLimitBytes: e.BODY_LIMIT_BYTES,
  });
}

/** Для integration-тестов: URL тестовой БД или `undefined`, если он не задан (тесты пропускаются). */
export function loadTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const parsed = z
    .url()
    .optional()
    .safeParse(env.TEST_DATABASE_URL || undefined);
  return parsed.success ? parsed.data : undefined;
}

/** Для CLI-скрипта подписи: только `WEBHOOK_SECRET`, без остальных переменных окружения. */
export function loadWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  const parsed = z.string().min(32).safeParse(env.WEBHOOK_SECRET);
  if (!parsed.success) throw new ConfigError(['WEBHOOK_SECRET: must be set (min 32 characters)']);
  return parsed.data;
}
