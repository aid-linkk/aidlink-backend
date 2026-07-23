/**
 * Connection-pool profiler.
 *
 * Drives a configurable number of concurrent queries against the configured
 * database and reports latency percentiles, pool saturation and pool-timeout
 * counts. Used to produce the numbers in docs/DATABASE_POOLING.md and to
 * re-validate pool sizing after schema or infrastructure changes.
 *
 * Usage:
 *   npm run db:profile                       # default sweep
 *   CONCURRENCY=1,10,50 ITERATIONS=200 npm run db:profile
 *
 * The workload is read-only (SELECT 1 plus a bounded campaign listing), so it
 * is safe against a staging database. Do not point it at production.
 */
import prisma, { databaseMetrics, getPoolStats, poolSettings } from '../src/config/database';

interface PhaseResult {
  concurrency: number;
  iterations: number;
  wallClockMs: number;
  throughputPerSecond: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  errors: number;
  poolTimeouts: number;
  peakBusy: number;
  peakWaiting: number;
}

const concurrencyLevels = (process.env.CONCURRENCY || '1,5,10,25,50,100')
  .split(',')
  .map((value) => parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0);

const iterations = parseInt(process.env.ITERATIONS || '200', 10);

async function unitOfWork(): Promise<void> {
  // Two round trips per unit: a trivial probe and a realistic indexed read.
  await prisma.$queryRaw`SELECT 1`;
  await prisma.campaign.findMany({ take: 10, orderBy: { createdAt: 'desc' } });
}

async function runPhase(concurrency: number): Promise<PhaseResult> {
  databaseMetrics.reset();

  const durations: number[] = [];
  let errors = 0;
  let peakBusy = 0;
  let peakWaiting = 0;

  const sampler = setInterval(async () => {
    const stats = await getPoolStats();
    if (!stats.available) return;
    peakBusy = Math.max(peakBusy, stats.busy);
    peakWaiting = Math.max(peakWaiting, stats.waiting);
  }, 50);

  const startedAt = Date.now();
  let issued = 0;

  const worker = async (): Promise<void> => {
    while (issued < iterations) {
      issued += 1;
      const queryStart = Date.now();
      try {
        await unitOfWork();
        durations.push(Date.now() - queryStart);
      } catch {
        errors += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  const wallClockMs = Date.now() - startedAt;
  clearInterval(sampler);

  const snapshot = databaseMetrics.snapshot();
  durations.sort((a, b) => a - b);

  return {
    concurrency,
    iterations,
    wallClockMs,
    throughputPerSecond: Math.round((iterations / wallClockMs) * 1000 * 100) / 100,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    max: durations[durations.length - 1] ?? 0,
    errors,
    poolTimeouts: snapshot.connections.poolTimeouts,
    peakBusy,
    peakWaiting,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(Math.ceil((p / 100) * sorted.length) - 1, sorted.length - 1)];
}

async function main(): Promise<void> {
  await prisma.$connect();

  // eslint-disable-next-line no-console
  console.log('Pool settings:', poolSettings);
  // eslint-disable-next-line no-console
  console.log(`Iterations per phase: ${iterations}\n`);

  const results: PhaseResult[] = [];
  for (const concurrency of concurrencyLevels) {
    // Warm-up so connection establishment is not counted in the first phase.
    await unitOfWork();
    results.push(await runPhase(concurrency));
  }

  // eslint-disable-next-line no-console
  console.table(results);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error('Profiling run failed:', error);
  await prisma.$disconnect();
  process.exit(1);
});
