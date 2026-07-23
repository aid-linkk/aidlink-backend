/**
 * Connection-pool sizing and DATABASE_URL construction.
 *
 * Prisma manages its pool through query-string parameters on the connection
 * URL, so pool tuning happens by rewriting the URL before the client is
 * constructed. Everything here is pure so it can be unit tested without a
 * database.
 *
 * See docs/DATABASE_POOLING.md for the sizing rationale and profiling notes.
 */

export interface PoolSettings {
  /** Max connections this process keeps open against PostgreSQL. */
  connectionLimit: number;
  /** Seconds a query waits for a free pooled connection before failing. */
  poolTimeoutSeconds: number;
  /** Seconds to wait for a new TCP/TLS connection to be established. */
  connectTimeoutSeconds: number;
  /** Seconds a single statement may occupy a connection (0 disables). */
  socketTimeoutSeconds: number;
}

export interface ConnectionLimitInput {
  /** Explicit override (DB_POOL_MAX). Wins over every heuristic. */
  override?: number;
  /** Logical CPUs available to this process. */
  cpuCount: number;
  /**
   * Number of processes/replicas sharing the same PostgreSQL server. The
   * per-process budget is divided by this so the fleet stays within
   * `max_connections`.
   */
  instances: number;
  /** Server-side `max_connections`, minus headroom for admin/migrations. */
  serverConnectionBudget: number;
}

/** Prisma's own default is `cpus * 2 + 1`; we keep it as the floor. */
export const PRISMA_DEFAULT_MULTIPLIER = 2;

/** Never open fewer than this many connections, even on a 1-vCPU box. */
export const MIN_CONNECTION_LIMIT = 5;

/** Guardrail so a mis-set env var cannot exhaust PostgreSQL slots. */
export const MAX_CONNECTION_LIMIT = 100;

/**
 * Resolves the per-process pool size.
 *
 * AidLink's workload is IO-bound (Prisma queries, Stellar RPC, S3) rather than
 * CPU-bound, so the pool is sized slightly above Prisma's CPU-derived default
 * and then capped by the share of the server's connection budget this process
 * is allowed to take.
 */
export function resolveConnectionLimit(input: ConnectionLimitInput): number {
  const { override, cpuCount, instances, serverConnectionBudget } = input;

  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return clamp(Math.floor(override), MIN_CONNECTION_LIMIT, MAX_CONNECTION_LIMIT);
  }

  const cpus = Math.max(1, Math.floor(cpuCount) || 1);
  const safeInstances = Math.max(1, Math.floor(instances) || 1);

  // Prisma's formula, plus one extra connection per CPU for IO-bound waits.
  const cpuDerived = cpus * PRISMA_DEFAULT_MULTIPLIER + 1 + cpus;

  // Fair share of the server budget across every process pointing at this DB.
  const fairShare = Math.floor(serverConnectionBudget / safeInstances);

  return clamp(Math.min(cpuDerived, fairShare), MIN_CONNECTION_LIMIT, MAX_CONNECTION_LIMIT);
}

/**
 * Appends pool parameters to a PostgreSQL connection URL.
 *
 * Parameters already present in the URL are preserved: an operator who pins
 * `?connection_limit=1` (the usual setup behind PgBouncer) keeps that value.
 * Returns the input untouched when it is not a parseable URL so that Prisma
 * produces its own, clearer error message.
 */
export function buildPooledDatabaseUrl(databaseUrl: string, settings: PoolSettings): string {
  if (!databaseUrl) return databaseUrl;

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return databaseUrl;
  }

  const protocol = url.protocol.replace(':', '');
  if (protocol !== 'postgres' && protocol !== 'postgresql') {
    return databaseUrl;
  }

  setIfAbsent(url, 'connection_limit', settings.connectionLimit);
  setIfAbsent(url, 'pool_timeout', settings.poolTimeoutSeconds);
  setIfAbsent(url, 'connect_timeout', settings.connectTimeoutSeconds);

  if (settings.socketTimeoutSeconds > 0) {
    setIfAbsent(url, 'socket_timeout', settings.socketTimeoutSeconds);
  }

  return url.toString();
}

/**
 * Reads the pool size actually in force from a connection URL.
 *
 * `buildPooledDatabaseUrl` leaves an operator-set `connection_limit` alone, so
 * the value we computed is not necessarily the value Prisma uses. Monitoring
 * must report the real limit or utilisation figures are wrong.
 */
export function effectiveConnectionLimit(databaseUrl: string, fallback: number): number {
  try {
    const value = new URL(databaseUrl).searchParams.get('connection_limit');
    const parsed = value === null ? NaN : parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Strips credentials so a connection URL can be safely logged. */
export function redactDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<unparseable database url>';
  }
}

function setIfAbsent(url: URL, key: string, value: number): void {
  if (!url.searchParams.has(key)) {
    url.searchParams.set(key, String(value));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
