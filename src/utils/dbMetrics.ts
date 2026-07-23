/**
 * In-process database query metrics.
 *
 * Prisma reports pool gauges (open/busy/idle connections) but says nothing
 * about how long individual queries take, which operations are slow, or how
 * often they fail. This collector fills that gap with bounded, allocation-light
 * bookkeeping so it can stay enabled in production.
 *
 * Everything is kept in memory and is per-process: it is intended for the
 * `/health/db` and admin metrics endpoints and for scraping into an external
 * time-series store, not as a durable record.
 */

/** Rolling window of durations used to compute percentiles. */
const DEFAULT_SAMPLE_SIZE = 1000;

/** How many slow queries to retain for inspection. */
const DEFAULT_SLOW_QUERY_HISTORY = 20;

/** Cap on distinct operation keys, so a pathological caller cannot leak memory. */
const MAX_TRACKED_OPERATIONS = 200;

/** Upper bounds (ms) of the latency histogram buckets. */
export const LATENCY_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

export interface QueryRecord {
  /** Prisma model, or `$raw` for raw SQL. */
  model?: string;
  /** Prisma action (`findMany`, `create`, ...) or the raw SQL verb. */
  operation: string;
  durationMs: number;
  success: boolean;
  /** Raw SQL or a description; only retained for slow queries. */
  statement?: string;
}

export interface OperationStats {
  operation: string;
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  avgMs: number;
}

export interface SlowQueryEntry {
  operation: string;
  durationMs: number;
  statement?: string;
  at: string;
}

export interface ConnectionEventCounters {
  connectAttempts: number;
  connectFailures: number;
  connectRetries: number;
  disconnects: number;
  /** Queries rejected because no pooled connection became free in time. */
  poolTimeouts: number;
  /** Queries aborted by the client-side query timeout. */
  queryTimeouts: number;
}

export interface DatabaseMetricsSnapshot {
  uptimeMs: number;
  since: string;
  queries: {
    total: number;
    errors: number;
    slow: number;
    errorRate: number;
    queriesPerSecond: number;
    latencyMs: {
      avg: number;
      p50: number;
      p95: number;
      p99: number;
      max: number;
    };
    histogram: Record<string, number>;
  };
  connections: ConnectionEventCounters;
  topOperations: OperationStats[];
  slowQueries: SlowQueryEntry[];
  slowQueryThresholdMs: number;
}

export interface DatabaseMetricsOptions {
  slowQueryThresholdMs?: number;
  sampleSize?: number;
  slowQueryHistory?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

export class DatabaseMetrics {
  private readonly slowQueryThresholdMs: number;
  private readonly sampleSize: number;
  private readonly slowQueryHistory: number;
  private readonly now: () => number;

  private startedAt: number;
  private total = 0;
  private errors = 0;
  private slow = 0;
  private totalMs = 0;
  private maxMs = 0;

  /** Ring buffer of recent durations backing the percentile estimates. */
  private samples: Float64Array;
  private sampleCursor = 0;
  private sampleCount = 0;

  private buckets: number[];
  private operations = new Map<string, OperationStats>();
  private slowQueries: SlowQueryEntry[] = [];
  private connections: ConnectionEventCounters = emptyConnectionCounters();

  constructor(options: DatabaseMetricsOptions = {}) {
    this.slowQueryThresholdMs = options.slowQueryThresholdMs ?? 500;
    this.sampleSize = Math.max(1, options.sampleSize ?? DEFAULT_SAMPLE_SIZE);
    this.slowQueryHistory = Math.max(1, options.slowQueryHistory ?? DEFAULT_SLOW_QUERY_HISTORY);
    this.now = options.now ?? Date.now;

    this.samples = new Float64Array(this.sampleSize);
    this.buckets = new Array(LATENCY_BUCKETS_MS.length + 1).fill(0);
    this.startedAt = this.now();
  }

  /** True when the query took longer than the configured slow threshold. */
  isSlow(durationMs: number): boolean {
    return durationMs >= this.slowQueryThresholdMs;
  }

  getSlowQueryThresholdMs(): number {
    return this.slowQueryThresholdMs;
  }

  recordQuery(record: QueryRecord): void {
    const duration = Number.isFinite(record.durationMs) ? Math.max(0, record.durationMs) : 0;

    this.total += 1;
    this.totalMs += duration;
    if (duration > this.maxMs) this.maxMs = duration;
    if (!record.success) this.errors += 1;

    this.samples[this.sampleCursor] = duration;
    this.sampleCursor = (this.sampleCursor + 1) % this.sampleSize;
    if (this.sampleCount < this.sampleSize) this.sampleCount += 1;

    this.buckets[bucketIndex(duration)] += 1;

    const key = record.model ? `${record.model}.${record.operation}` : record.operation;
    this.trackOperation(key, duration, record.success);

    if (this.isSlow(duration)) {
      this.slow += 1;
      this.slowQueries.push({
        operation: key,
        durationMs: round(duration),
        statement: record.statement,
        at: new Date(this.now()).toISOString(),
      });
      if (this.slowQueries.length > this.slowQueryHistory) {
        this.slowQueries.shift();
      }
    }
  }

  recordConnectionEvent(event: keyof ConnectionEventCounters, count = 1): void {
    this.connections[event] += count;
  }

  snapshot(): DatabaseMetricsSnapshot {
    const uptimeMs = Math.max(0, this.now() - this.startedAt);
    const sorted = this.sortedSamples();

    return {
      uptimeMs,
      since: new Date(this.startedAt).toISOString(),
      queries: {
        total: this.total,
        errors: this.errors,
        slow: this.slow,
        errorRate: this.total === 0 ? 0 : round(this.errors / this.total, 4),
        queriesPerSecond: uptimeMs === 0 ? 0 : round((this.total * 1000) / uptimeMs, 2),
        latencyMs: {
          avg: this.total === 0 ? 0 : round(this.totalMs / this.total),
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          p99: percentile(sorted, 99),
          max: round(this.maxMs),
        },
        histogram: this.histogram(),
      },
      connections: { ...this.connections },
      topOperations: this.topOperations(),
      slowQueries: [...this.slowQueries],
      slowQueryThresholdMs: this.slowQueryThresholdMs,
    };
  }

  reset(): void {
    this.total = 0;
    this.errors = 0;
    this.slow = 0;
    this.totalMs = 0;
    this.maxMs = 0;
    this.samples = new Float64Array(this.sampleSize);
    this.sampleCursor = 0;
    this.sampleCount = 0;
    this.buckets = new Array(LATENCY_BUCKETS_MS.length + 1).fill(0);
    this.operations.clear();
    this.slowQueries = [];
    this.connections = emptyConnectionCounters();
    this.startedAt = this.now();
  }

  private trackOperation(key: string, duration: number, success: boolean): void {
    let stats = this.operations.get(key);

    if (!stats) {
      if (this.operations.size >= MAX_TRACKED_OPERATIONS) return;
      stats = { operation: key, count: 0, errors: 0, totalMs: 0, maxMs: 0, avgMs: 0 };
      this.operations.set(key, stats);
    }

    stats.count += 1;
    stats.totalMs += duration;
    if (!success) stats.errors += 1;
    if (duration > stats.maxMs) stats.maxMs = duration;
  }

  /** Slowest operations by cumulative time, which is what pool pressure tracks. */
  private topOperations(limit = 10): OperationStats[] {
    return [...this.operations.values()]
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, limit)
      .map((stats) => ({
        ...stats,
        totalMs: round(stats.totalMs),
        maxMs: round(stats.maxMs),
        avgMs: round(stats.totalMs / stats.count),
      }));
  }

  private histogram(): Record<string, number> {
    const result: Record<string, number> = {};
    LATENCY_BUCKETS_MS.forEach((bound, index) => {
      result[`<=${bound}ms`] = this.buckets[index];
    });
    result[`>${LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1]}ms`] =
      this.buckets[LATENCY_BUCKETS_MS.length];
    return result;
  }

  private sortedSamples(): number[] {
    return Array.from(this.samples.slice(0, this.sampleCount)).sort((a, b) => a - b);
  }
}

function bucketIndex(duration: number): number {
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i += 1) {
    if (duration <= LATENCY_BUCKETS_MS[i]) return i;
  }
  return LATENCY_BUCKETS_MS.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return round(sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]);
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function emptyConnectionCounters(): ConnectionEventCounters {
  return {
    connectAttempts: 0,
    connectFailures: 0,
    connectRetries: 0,
    disconnects: 0,
    poolTimeouts: 0,
    queryTimeouts: 0,
  };
}

export default DatabaseMetrics;
