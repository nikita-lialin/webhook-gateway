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

/**
 * Ставит событие заново, только если задачи в Redis нет (потеряна вместе с Redis или не была поставлена).
 * Живая задача (waiting/delayed/active) не трогается; отработавшая (completed/failed) удаляется, иначе
 * BullMQ отбросит новую с тем же jobId как дубль. `true` — задача поставлена.
 */
export async function requeueIfLost(dq: DeliveryQueue, eventId: string): Promise<boolean> {
  const job = await withTimeout(dq.queue.getJob(eventId), dq.timeoutMs, 'get job');
  if (job) {
    const state = await withTimeout(job.getState(), dq.timeoutMs, 'get job state');
    if (state !== 'completed' && state !== 'failed') return false;
    await withTimeout(job.remove(), dq.timeoutMs, 'remove job');
  }
  await enqueueDelivery(dq, eventId);
  return true;
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

export const SWEEPER_QUEUE_NAME = 'webhook-sweeper';
const SWEEPER_SCHEDULER_ID = 'recovery-sweep';

/**
 * Периодический запуск sweeper: repeatable job с фиксированным id — в Redis он один, сколько бы
 * воркеров ни стартовало, и каждый тик обрабатывает ровно один из них. Возвращает функцию остановки.
 */
export async function startSweeperSchedule(
  config: { redisUrl: string; sweeperIntervalMs: number },
  handler: () => Promise<void>,
  onError: (err: Error) => void,
  options: { name?: string } = {},
): Promise<() => Promise<void>> {
  const name = options.name ?? SWEEPER_QUEUE_NAME;
  const connection = parseRedisUrl(config.redisUrl);
  const queue = new Queue(name, {
    connection,
    defaultJobOptions: { removeOnComplete: true, removeOnFail: 10 },
  });
  queue.on('error', onError);
  const worker = new Worker(name, handler, { connection, concurrency: 1 });
  worker.on('error', onError);
  await queue.upsertJobScheduler(SWEEPER_SCHEDULER_ID, { every: config.sweeperIntervalMs });
  return async () => {
    await worker.close();
    await queue.close();
  };
}

export async function closeDeliveryQueue(dq: DeliveryQueue): Promise<void> {
  await dq.queue.close();
}

export type { Job, Queue, Worker };
