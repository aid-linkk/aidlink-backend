import os from 'os';
import { PrismaClient } from '@prisma/client';
import { config } from './index';
import logger from './logger';
import {
  buildPooledDatabaseUrl,
  effectiveConnectionLimit,
  redactDatabaseUrl,
  resolveConnectionLimit,
  PoolSettings,
} from './dbPool';
import { DatabaseMetrics } from '../utils/dbMetrics';

/**
 * Prisma error codes we translate into connection-level signals.
 * P2024: timed out fetching a connection from the pool (pool is saturated).
 * P1008: the database itself timed out the operation.
 * P1001/P1002: server unreachable / connection timed out.
 */
const POOL_TIMEOUT_CODE = 'P2024';
const OPERATION_TIMEOUT_CODE = 'P1008';

export const poolSettings: PoolSettings = {
  connectionLimit: resolveConnectionLimit({
    override: config.database.pool.max,
    cpuCount: os.cpus().length,
    instances: config.database.pool.instances,
    serverConnectionBudget: config.database.pool.serverConnectionBudget,
  }),
  poolTimeoutSeconds: config.database.pool.timeoutSeconds,
  connectTimeoutSeconds: config.database.pool.connectTimeoutSeconds,
  socketTimeoutSeconds: config.database.pool.socketTimeoutSeconds,
};

/** Query metrics collector for this process. Exported for the metrics endpoints. */
export const databaseMetrics = new DatabaseMetrics({
  slowQueryThresholdMs: config.database.monitoring.slowQueryThresholdMs,
});

/**
 * Pool parameters are applied by rewriting DATABASE_URL. When the variable is
 * missing we leave the datasource untouched so Prisma raises its own error.
 */
const pooledDatabaseUrl = config.database.url
  ? buildPooledDatabaseUrl(config.database.url, poolSettings)
  : undefined;

// An operator-pinned connection_limit in DATABASE_URL wins over our heuristic,
// so the monitored limit is read back from the URL Prisma will actually use.
poolSettings.connectionLimit = effectiveConnectionLimit(
  pooledDatabaseUrl ?? '',
  poolSettings.connectionLimit
);

const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
  ...(pooledDatabaseUrl ? { datasources: { db: { url: pooledDatabaseUrl } } } : {}),
});

interface PrismaQueryEvent {
  query: string;
  params: string;
  duration: number;
  target: string;
}

interface PrismaLogEvent {
  message: string;
  target: string;
}

/**
 * Prisma types `$on` against the client's log generic, which is awkward to
 * express when the log array is built conditionally. The narrow view below
 * keeps the handlers typed without leaking `any` into callers.
 */
const events = prisma as unknown as {
  $on(event: 'query', callback: (e: PrismaQueryEvent) => void): void;
  $on(event: 'error' | 'warn', callback: (e: PrismaLogEvent) => void): void;
};

// SQL-level timing. Useful for spotting the exact statement behind a slow
// logical operation; the metrics themselves are recorded by the middleware.
events.$on('query', (event) => {
  if (config.env === 'development') {
    logger.debug(`prisma query (${event.duration}ms): ${event.query}`);
  }

  if (config.database.monitoring.logSlowQueries && databaseMetrics.isSlow(event.duration)) {
    logger.warn('Slow SQL statement', {
      durationMs: event.duration,
      sql: truncate(event.query, 500),
      target: event.target,
    });
  }
});

events.$on('error', (event) => logger.error('Prisma error', { message: event.message, target: event.target }));
events.$on('warn', (event) => logger.warn('Prisma warning', { message: event.message, target: event.target }));

/**
 * Records duration, success and connection-level failures for every Prisma
 * operation, and optionally aborts queries that outlive
 * `DB_QUERY_TIMEOUT_MS` so a single runaway statement cannot hold a pooled
 * connection indefinitely.
 */
prisma.$use(async (params, next) => {
  const startedAt = process.hrtime.bigint();
  const { queryTimeoutMs } = config.database.monitoring;

  try {
    const result = queryTimeoutMs > 0
      ? await withTimeout(next(params), queryTimeoutMs, describe(params.model, params.action))
      : await next(params);

    record(params, startedAt, true);
    return result;
  } catch (error) {
    record(params, startedAt, false);
    classifyConnectionError(error);
    throw error;
  }
});

function record(
  params: { model?: string; action: string; args?: unknown },
  startedAt: bigint,
  success: boolean
): void {
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  databaseMetrics.recordQuery({
    model: params.model,
    operation: params.action,
    durationMs,
    success,
    statement: rawStatement(params),
  });
}

/** Raw operations carry their SQL in args; model operations do not. */
function rawStatement(params: { action: string; args?: unknown }): string | undefined {
  if (!params.action.toLowerCase().includes('raw')) return undefined;

  const args = params.args as { strings?: string[]; sql?: string; text?: string } | string[] | undefined;
  if (!args) return undefined;
  if (Array.isArray(args)) return truncate(String(args[0]), 300);
  if (Array.isArray(args.strings)) return truncate(args.strings.join('?'), 300);
  return truncate(String(args.sql ?? args.text ?? ''), 300) || undefined;
}

function classifyConnectionError(error: unknown): void {
  const code = (error as { code?: string })?.code;

  if (code === POOL_TIMEOUT_CODE) {
    databaseMetrics.recordConnectionEvent('poolTimeouts');
    logger.error('Connection pool exhausted: no connection became available in time', {
      connectionLimit: poolSettings.connectionLimit,
      poolTimeoutSeconds: poolSettings.poolTimeoutSeconds,
    });
  } else if (code === OPERATION_TIMEOUT_CODE) {
    databaseMetrics.recordConnectionEvent('queryTimeouts');
  }
}

export class DatabaseQueryTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Database operation ${operation} exceeded ${timeoutMs}ms`);
    this.name = 'DatabaseQueryTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      databaseMetrics.recordConnectionEvent('queryTimeouts');
      reject(new DatabaseQueryTimeoutError(operation, timeoutMs));
    }, timeoutMs);
    // The timer must not keep the event loop alive on shutdown.
    timer.unref?.();
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

let monitorTimer: NodeJS.Timeout | null = null;

export async function connectDatabase(): Promise<void> {
  const { connectRetries, connectRetryBaseDelayMs } = config.database.pool;
  const attempts = Math.max(1, connectRetries);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    databaseMetrics.recordConnectionEvent('connectAttempts');

    try {
      await prisma.$connect();

      logger.info('Database connected', {
        connectionLimit: poolSettings.connectionLimit,
        poolTimeoutSeconds: poolSettings.poolTimeoutSeconds,
        connectTimeoutSeconds: poolSettings.connectTimeoutSeconds,
        url: redactDatabaseUrl(pooledDatabaseUrl ?? ''),
      });

      startPoolMonitoring();
      return;
    } catch (error) {
      databaseMetrics.recordConnectionEvent('connectFailures');

      if (attempt === attempts) {
        logger.error('Database connection failed after all retries', { attempts, error });
        process.exit(1);
      }

      // Exponential backoff: transient DNS/boot-order failures are common when
      // the API container starts before PostgreSQL is accepting connections.
      const delay = connectRetryBaseDelayMs * 2 ** (attempt - 1);
      databaseMetrics.recordConnectionEvent('connectRetries');
      logger.warn(`Database connection failed, retrying in ${delay}ms`, { attempt, attempts });
      await sleep(delay);
    }
  }
}

export async function disconnectDatabase(): Promise<void> {
  stopPoolMonitoring();
  await prisma.$disconnect();
  databaseMetrics.recordConnectionEvent('disconnects');
  logger.info('Database disconnected');
}

// ---------------------------------------------------------------------------
// Pool monitoring
// ---------------------------------------------------------------------------

export interface PoolStats {
  /** Connections currently open against PostgreSQL. */
  open: number;
  /** Connections currently executing a query. */
  busy: number;
  idle: number;
  /** Queries waiting for a free connection right now. */
  waiting: number;
  limit: number;
  /** busy / limit, rounded to two decimals. */
  utilization: number;
  /** False when the Prisma `metrics` preview feature is not enabled. */
  available: boolean;
}

/**
 * Reads live pool gauges from Prisma.
 *
 * `$metrics` requires `previewFeatures = ["metrics"]` in schema.prisma and a
 * regenerated client. When unavailable we report `available: false` rather than
 * failing the caller, so health checks keep working on older clients.
 */
export async function getPoolStats(): Promise<PoolStats> {
  const unavailable: PoolStats = {
    open: 0,
    busy: 0,
    idle: 0,
    waiting: 0,
    limit: poolSettings.connectionLimit,
    utilization: 0,
    available: false,
  };

  const metricsApi = (prisma as unknown as {
    $metrics?: { json(): Promise<{ gauges: { key: string; value: number }[] }> };
  }).$metrics;

  if (!metricsApi?.json) return unavailable;

  try {
    const { gauges } = await metricsApi.json();
    const gauge = (key: string): number => gauges.find((g) => g.key === key)?.value ?? 0;

    const open = gauge('prisma_pool_connections_open');
    const busy = gauge('prisma_pool_connections_busy');
    const idle = gauge('prisma_pool_connections_idle');
    const waiting = gauge('prisma_client_queries_wait');

    return {
      open,
      busy,
      idle,
      waiting,
      limit: poolSettings.connectionLimit,
      utilization: Math.round((busy / poolSettings.connectionLimit) * 100) / 100,
      available: true,
    };
  } catch (error) {
    logger.debug('Prisma pool metrics unavailable', { error });
    return unavailable;
  }
}

export function startPoolMonitoring(): void {
  const { intervalMs, saturationThreshold } = config.database.monitoring;
  if (intervalMs <= 0 || monitorTimer) return;

  monitorTimer = setInterval(async () => {
    const stats = await getPoolStats();
    if (!stats.available) return;

    if (stats.utilization >= saturationThreshold || stats.waiting > 0) {
      logger.warn('Database connection pool under pressure', stats);
    } else {
      logger.debug('Database connection pool', stats);
    }
  }, intervalMs);

  monitorTimer.unref?.();
}

export function stopPoolMonitoring(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type DatabaseHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface DatabaseHealth {
  status: DatabaseHealthStatus;
  latencyMs: number | null;
  pool: PoolStats;
  queries: {
    total: number;
    errors: number;
    slow: number;
    errorRate: number;
    p95LatencyMs: number;
  };
  error?: string;
}

/**
 * Round-trips a trivial query and combines the result with pool gauges.
 *
 * `degraded` means the database answered but the pool is close to saturation
 * or queries are queueing, which is the signal to scale before requests start
 * failing with P2024.
 */
export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const snapshot = databaseMetrics.snapshot();
  const queries = {
    total: snapshot.queries.total,
    errors: snapshot.queries.errors,
    slow: snapshot.queries.slow,
    errorRate: snapshot.queries.errorRate,
    p95LatencyMs: snapshot.queries.latencyMs.p95,
  };

  const startedAt = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;
    const latencyMs = Date.now() - startedAt;
    const pool = await getPoolStats();

    const saturated =
      pool.available &&
      (pool.waiting > 0 || pool.utilization >= config.database.monitoring.saturationThreshold);

    return {
      status: saturated ? 'degraded' : 'healthy',
      latencyMs,
      pool,
      queries,
    };
  } catch (error) {
    logger.error('Database health check failed', { error });
    return {
      status: 'unhealthy',
      latencyMs: null,
      pool: await getPoolStats(),
      queries,
      error: error instanceof Error ? error.message : 'Unknown database error',
    };
  }
}

function describe(model: string | undefined, action: string): string {
  return model ? `${model}.${action}` : action;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default prisma;
