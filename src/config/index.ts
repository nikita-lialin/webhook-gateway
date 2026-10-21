export type NodeEnv = 'development' | 'production' | 'test';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface Config {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly logLevel: LogLevel;
}

const NODE_ENVS: readonly string[] = ['development', 'production', 'test'];
const LOG_LEVELS: readonly string[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

// Временная ручная проверка; на шаге 2 заменяется zod-схемой.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const logLevel = env.LOG_LEVEL ?? 'info';
  const port = Number(env.PORT ?? '3000');

  if (!NODE_ENVS.includes(nodeEnv)) throw new Error('Invalid NODE_ENV');
  if (!LOG_LEVELS.includes(logLevel)) throw new Error('Invalid LOG_LEVEL');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid PORT');

  return Object.freeze({
    nodeEnv: nodeEnv as NodeEnv,
    port,
    logLevel: logLevel as LogLevel,
  });
}
