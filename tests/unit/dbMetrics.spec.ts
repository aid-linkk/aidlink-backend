import { DatabaseMetrics } from '../../src/utils/dbMetrics';

describe('DatabaseMetrics', () => {
  let clock: number;
  const now = (): number => clock;

  const createMetrics = (overrides = {}): DatabaseMetrics =>
    new DatabaseMetrics({ slowQueryThresholdMs: 100, now, ...overrides });

  beforeEach(() => {
    clock = 1_700_000_000_000;
  });

  it('starts empty', () => {
    const snapshot = createMetrics().snapshot();

    expect(snapshot.queries.total).toBe(0);
    expect(snapshot.queries.errorRate).toBe(0);
    expect(snapshot.queries.latencyMs.p95).toBe(0);
    expect(snapshot.topOperations).toEqual([]);
  });

  it('aggregates counts, error rate and throughput', () => {
    const metrics = createMetrics();

    metrics.recordQuery({ model: 'Campaign', operation: 'findMany', durationMs: 10, success: true });
    metrics.recordQuery({ model: 'Campaign', operation: 'findMany', durationMs: 30, success: true });
    metrics.recordQuery({ model: 'Donation', operation: 'create', durationMs: 20, success: false });
    clock += 2000;

    const snapshot = metrics.snapshot();

    expect(snapshot.queries.total).toBe(3);
    expect(snapshot.queries.errors).toBe(1);
    expect(snapshot.queries.errorRate).toBe(0.3333);
    expect(snapshot.queries.queriesPerSecond).toBe(1.5);
    expect(snapshot.queries.latencyMs.avg).toBe(20);
    expect(snapshot.queries.latencyMs.max).toBe(30);
  });

  it('computes percentiles over the sample window', () => {
    const metrics = createMetrics();

    for (let i = 1; i <= 100; i += 1) {
      metrics.recordQuery({ operation: 'findUnique', durationMs: i, success: true });
    }

    const { latencyMs } = metrics.snapshot().queries;
    expect(latencyMs.p50).toBe(50);
    expect(latencyMs.p95).toBe(95);
    expect(latencyMs.p99).toBe(99);
  });

  it('only keeps the most recent durations in the percentile window', () => {
    const metrics = createMetrics({ sampleSize: 3 });

    [1000, 1000, 1000, 5, 5, 5].forEach((durationMs) =>
      metrics.recordQuery({ operation: 'findMany', durationMs, success: true })
    );

    // The three 1000ms samples have been evicted by the newer ones.
    expect(metrics.snapshot().queries.latencyMs.p99).toBe(5);
    // Cumulative counters are unaffected by the window.
    expect(metrics.snapshot().queries.total).toBe(6);
  });

  it('tracks slow queries against the threshold', () => {
    const metrics = createMetrics();

    metrics.recordQuery({ operation: 'findMany', durationMs: 99, success: true });
    metrics.recordQuery({
      model: 'Campaign',
      operation: 'findMany',
      durationMs: 250,
      success: true,
      statement: 'SELECT * FROM campaigns',
    });

    const snapshot = metrics.snapshot();
    expect(metrics.isSlow(100)).toBe(true);
    expect(metrics.isSlow(99)).toBe(false);
    expect(snapshot.queries.slow).toBe(1);
    expect(snapshot.slowQueries).toHaveLength(1);
    expect(snapshot.slowQueries[0]).toMatchObject({
      operation: 'Campaign.findMany',
      durationMs: 250,
      statement: 'SELECT * FROM campaigns',
    });
  });

  it('bounds the slow-query history', () => {
    const metrics = createMetrics({ slowQueryHistory: 2 });

    [200, 300, 400].forEach((durationMs) =>
      metrics.recordQuery({ operation: 'findMany', durationMs, success: true })
    );

    const { slowQueries } = metrics.snapshot();
    expect(slowQueries).toHaveLength(2);
    expect(slowQueries.map((entry) => entry.durationMs)).toEqual([300, 400]);
  });

  it('ranks operations by cumulative time', () => {
    const metrics = createMetrics();

    metrics.recordQuery({ model: 'Campaign', operation: 'findMany', durationMs: 10, success: true });
    metrics.recordQuery({ model: 'Campaign', operation: 'findMany', durationMs: 30, success: true });
    metrics.recordQuery({ model: 'User', operation: 'findUnique', durationMs: 5, success: false });

    const [first, second] = metrics.snapshot().topOperations;

    expect(first).toEqual({
      operation: 'Campaign.findMany',
      count: 2,
      errors: 0,
      totalMs: 40,
      maxMs: 30,
      avgMs: 20,
    });
    expect(second.operation).toBe('User.findUnique');
    expect(second.errors).toBe(1);
  });

  it('buckets latencies into the histogram', () => {
    const metrics = createMetrics();

    [0.5, 7, 7, 9000].forEach((durationMs) =>
      metrics.recordQuery({ operation: 'findMany', durationMs, success: true })
    );

    const { histogram } = metrics.snapshot().queries;
    expect(histogram['<=1ms']).toBe(1);
    expect(histogram['<=10ms']).toBe(2);
    expect(histogram['>5000ms']).toBe(1);
  });

  it('records connection events', () => {
    const metrics = createMetrics();

    metrics.recordConnectionEvent('connectAttempts');
    metrics.recordConnectionEvent('poolTimeouts', 3);

    expect(metrics.snapshot().connections).toMatchObject({
      connectAttempts: 1,
      poolTimeouts: 3,
      connectFailures: 0,
    });
  });

  it('clears every counter on reset', () => {
    const metrics = createMetrics();

    metrics.recordQuery({ operation: 'findMany', durationMs: 500, success: false });
    metrics.recordConnectionEvent('poolTimeouts');
    clock += 5000;
    metrics.reset();

    const snapshot = metrics.snapshot();
    expect(snapshot.queries.total).toBe(0);
    expect(snapshot.queries.errors).toBe(0);
    expect(snapshot.slowQueries).toEqual([]);
    expect(snapshot.connections.poolTimeouts).toBe(0);
    expect(snapshot.uptimeMs).toBe(0);
  });

  it('ignores non-finite durations rather than corrupting averages', () => {
    const metrics = createMetrics();

    metrics.recordQuery({ operation: 'findMany', durationMs: Number.NaN, success: true });
    metrics.recordQuery({ operation: 'findMany', durationMs: -5, success: true });

    const { latencyMs, total } = metrics.snapshot().queries;
    expect(total).toBe(2);
    expect(latencyMs.avg).toBe(0);
    expect(latencyMs.max).toBe(0);
  });
});
