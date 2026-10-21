import { Queue, Worker, type BackoffStrategy, type Job } from 'bullmq';

export const DELIVERY_QUEUE_NAME = 'webhook-delivery';
export const DLQ_QUEUE_NAME = 'webhook-dlq';
export const DEFAULT_ENQUEUE_TIMEOUT_MS = 2_000;
const KEEP_COMPLETED = { age: 3_600, count: 1_000 };
const KEEP_FAILED = { age: 7 * 24 * 3_600, count: 5_000 };

export interface DeliveryQueue {
  readonly queue: Queue;
  /** Число попыток задачи (BullMQ `attempts`): первая отправка + повторы. */
  readonly maxAttempts: number;
  readonly timeoutMs: number;
}

function parseRedisUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    tls: u.protocol === 'rediss:' ? {} : undefined,
  };
}

export function createDeliveryQueue(
  config: { redisUrl: string; maxRetryAttempts?: number },
  options: { name?: string; timeoutMs?: number } = {},
): DeliveryQueue {
  const queue = new Queue(options.name ?? DELIVERY_QUEUE_NAME, {
    connection: { ...parseRedisUrl(config.redisUrl), enableOfflineQueue: false },
    defaultJobOptions: { removeOnComplete: KEEP_COMPLETED, removeOnFail: KEEP_FAILED },
  });
  // Без обработчика ошибка соединения станет unhandled 'error'; недоступность видна в enqueue и /health.
  queue.on('error', () => undefined);
  return {
    queue,
    maxAttempts: config.maxRetryAttempts ?? 1,
    timeoutMs: options.timeoutMs ?? DEFAULT_ENQUEUE_TIMEOUT_MS,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** В задаче только eventId; jobId = eventId, поэтому повторная постановка дубля не создаёт. */
export async function enqueueDelivery(dq: DeliveryQueue, eventId: string): Promise<void> {
  await withTimeout(
    dq.queue.add(
      'deliver',
      { eventId },
      { jobId: eventId, attempts: dq.maxAttempts, backoff: { type: 'custom' } },
    ),
    dq.timeoutMs,
    'enqueue',
  );
}

export interface DeadLetterData {
  eventId: string;
  endpointId: string;
  attempts: number;
  reason: string;
}

/** DLQ только для наблюдения и алертов: источник истины — `events.status = 'dead'` в PostgreSQL. */
export function createDlqQueue(
  config: { redisUrl: string },
  options: { name?: string; timeoutMs?: number } = {},
): DeliveryQueue {
  const queue = new Queue(options.name ?? DLQ_QUEUE_NAME, {
    connection: { ...parseRedisUrl(config.redisUrl), enableOfflineQueue: false },
    defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
  });
  queue.on('error', () => undefined);
  return { queue, maxAttempts: 1, timeoutMs: options.timeoutMs ?? DEFAULT_ENQUEUE_TIMEOUT_MS };
}

export async function enqueueDead(dlq: DeliveryQueue, data: DeadLetterData): Promise<void> {
  await withTimeout(dlq.queue.add('dead', data, { attempts: 1 }), dlq.timeoutMs, 'dlq enqueue');
}

export async function isRedisHealthy(dq: DeliveryQueue): Promise<boolean> {
  try {
    await withTimeout(dq.queue.waitUntilReady(), dq.timeoutMs, 'redis connect');
    await withTimeout(dq.queue.getJobCounts('waiting'), dq.timeoutMs, 'redis roundtrip');
    return true;
  } catch {
    return false;
  }
}

export interface DeliveryJobData {
  eventId: string;
}

/** Воркер доставки. Закрытие (`worker.close()`) дожидается текущих задач. */
export function createDeliveryWorker(
  config: { redisUrl: string; workerConcurrency: number },
  handler: (job: Job<DeliveryJobData>) => Promise<void>,
  options: { name?: string; backoffStrategy?: BackoffStrategy } = {},
): Worker<DeliveryJobData> {
  return new Worker<DeliveryJobData>(options.name ?? DELIVERY_QUEUE_NAME, handler, {
    connection: parseRedisUrl(config.redisUrl),
    concurrency: config.workerConcurrency,
    settings: { backoffStrategy: options.backoffStrategy },
  });
}

export async function closeDeliveryQueue(dq: DeliveryQueue): Promise<void> {
  await dq.queue.close();
}

export type { Job, Queue, Worker };
