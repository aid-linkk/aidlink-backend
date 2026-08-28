/**
 * Matched Fund Verification Worker
 *
 * Registers three BullMQ job types against the `matched-fund-verification`
 * queue and sets up two recurring schedules:
 *
 *   FULL_VERIFICATION    – daily (off-peak), scans every Multiplier row.
 *   SAMPLING_VERIFICATION – hourly, scans a random TABLESAMPLE subset.
 *
 * A third job type, TRIGGERED_VERIFICATION, is not scheduled — it is enqueued
 * on-demand via `enqueueTriggeredVerification()`.  Typical callers are:
 *   - Admin API handlers (after a manual data fix).
 *   - Post-deployment scripts.
 *   - External tooling that detects a suspected anomaly.
 *
 * ─── Feature flag ────────────────────────────────────────────────────────────
 * Everything is gated behind `config.matchedFundVerification.enabled`.  When
 * the flag is false the queue and worker are still created (so the BullMQ
 * dashboard shows an empty queue rather than a missing one) but no jobs are
 * scheduled and ad-hoc enqueues are rejected with a warning.
 *
 * ─── Concurrency ─────────────────────────────────────────────────────────────
 * The worker uses concurrency=1 so that only one verification job runs at a
 * time.  This prevents two full-scan jobs from hammering the database
 * simultaneously if, for example, a previous job was delayed and two fire
 * close together.  The BullMQ `jobId` option on repeating jobs means that if a
 * repeat fires while the previous instance is still running, BullMQ will see
 * the job already in the queue and deduplicate it.
 *
 * ─── Retry behaviour ─────────────────────────────────────────────────────────
 * Each job gets 3 attempts with exponential backoff starting at 5 s.  A failed
 * job does not leave the system inconsistent — the next scheduled run will
 * pick up any remaining inconsistencies.
 */

import { Worker, Queue, Job } from 'bullmq';
import { config } from '../config';
import { MatchedFundVerificationService } from '../services/matchedFundVerification.service';
import logger from '../config/logger';

// ─── BullMQ connection ────────────────────────────────────────────────────────

const connection = {
  host: config.bullmq.redisHost,
  port: config.bullmq.redisPort,
  password: config.bullmq.redisPassword,
};

const QUEUE_NAME = 'matched-fund-verification';

// ─── Job payload shapes ───────────────────────────────────────────────────────

export interface FullVerificationJobData {
  type: 'FULL_VERIFICATION';
}

export interface SamplingVerificationJobData {
  type: 'SAMPLING_VERIFICATION';
  /** Override sampling percent for this specific run. */
  samplingPercent?: number;
}

export interface TriggeredVerificationJobData {
  type: 'TRIGGERED_VERIFICATION';
  /** Specific Multiplier IDs to verify (empty = all). */
  multiplierIds: string[];
  /** When false, detect but do not repair. Defaults to true. */
  repair?: boolean;
}

export type VerificationJobData =
  | FullVerificationJobData
  | SamplingVerificationJobData
  | TriggeredVerificationJobData;

// ─── Queue (producer) ─────────────────────────────────────────────────────────

export const matchedFundVerificationQueue = new Queue<VerificationJobData>(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: true,
    removeOnFail: 100,
  },
});

/**
 * Enqueues a TRIGGERED_VERIFICATION job for the given multiplier IDs.
 * Throws if the verification feature flag is disabled.
 *
 * @param multiplierIds  List of Multiplier primary keys to verify.
 * @param repair         Whether to repair found inconsistencies. Default true.
 */
export async function enqueueTriggeredVerification(
  multiplierIds: string[],
  repair = true,
): Promise<void> {
  if (!config.matchedFundVerification.enabled) {
    logger.warn(
      '[matchedFundVerification] enqueueTriggeredVerification called but feature is disabled; ' +
        'set MATCHED_FUND_VERIFICATION_ENABLED=true to enable',
    );
    return;
  }

  const jobId = `triggered:${multiplierIds.sort().join(',')}:${Date.now()}`;

  await matchedFundVerificationQueue.add(
    'TRIGGERED_VERIFICATION',
    {
      type: 'TRIGGERED_VERIFICATION',
      multiplierIds,
      repair,
    },
    { jobId },
  );

  logger.info(
    `[matchedFundVerification] Enqueued triggered verification for ` +
      `${multiplierIds.length} multiplier(s)`,
    { multiplierIds, repair },
  );
}

// ─── Scheduled job registration ───────────────────────────────────────────────

/**
 * Registers the repeating full and sampling verification schedules.
 * Idempotent: BullMQ deduplicates by `jobId`, so calling this on every
 * startup is safe.
 */
export async function scheduleVerificationJobs(): Promise<void> {
  if (!config.matchedFundVerification.enabled) {
    logger.info(
      '[matchedFundVerification] Verification worker disabled; skipping schedule registration',
    );
    return;
  }

  // Daily full sweep
  await matchedFundVerificationQueue.add(
    'FULL_VERIFICATION',
    { type: 'FULL_VERIFICATION' },
    {
      repeat: { pattern: config.matchedFundVerification.fullVerificationCron },
      jobId: 'matched-fund-full-verification',
    },
  );

  // Hourly sampling pass
  await matchedFundVerificationQueue.add(
    'SAMPLING_VERIFICATION',
    { type: 'SAMPLING_VERIFICATION' },
    {
      repeat: { pattern: config.matchedFundVerification.samplingVerificationCron },
      jobId: 'matched-fund-sampling-verification',
    },
  );

  logger.info(
    '[matchedFundVerification] Scheduled verification jobs: full (cron: ' +
      config.matchedFundVerification.fullVerificationCron +
      '), sampling (cron: ' +
      config.matchedFundVerification.samplingVerificationCron +
      ')',
  );
}

// ─── Worker (consumer) ────────────────────────────────────────────────────────

const matchedFundVerificationWorker = new Worker<VerificationJobData>(
  QUEUE_NAME,
  async (job: Job<VerificationJobData>) => {
    const { type } = job.data;

    logger.info(`[matchedFundVerification] Processing job id=${job.id} type=${type}`);

    switch (type) {
      case 'FULL_VERIFICATION': {
        const result = await MatchedFundVerificationService.verify({
          mode: 'full',
          repair: true,
        });

        logger.info('[matchedFundVerification] Full verification complete', {
          examined: result.examined,
          inconsistentCount: result.inconsistentCount,
          repairedCount: result.repairedCount,
          repairFailureCount: result.repairFailureCount,
          systemicAlert: result.systemicAlert,
          durationMs: result.durationMs,
        });

        return result;
      }

      case 'SAMPLING_VERIFICATION': {
        const data = job.data as SamplingVerificationJobData;
        const result = await MatchedFundVerificationService.verify({
          mode: 'sampling',
          repair: true,
          samplingPercent: data.samplingPercent,
        });

        logger.info('[matchedFundVerification] Sampling verification complete', {
          examined: result.examined,
          inconsistentCount: result.inconsistentCount,
          repairedCount: result.repairedCount,
          repairFailureCount: result.repairFailureCount,
          systemicAlert: result.systemicAlert,
          durationMs: result.durationMs,
        });

        return result;
      }

      case 'TRIGGERED_VERIFICATION': {
        const data = job.data as TriggeredVerificationJobData;
        const result = await MatchedFundVerificationService.verify({
          mode: 'triggered',
          multiplierIds: data.multiplierIds,
          repair: data.repair !== false,
        });

        logger.info('[matchedFundVerification] Triggered verification complete', {
          multiplierIds: data.multiplierIds,
          examined: result.examined,
          inconsistentCount: result.inconsistentCount,
          repairedCount: result.repairedCount,
          repairFailureCount: result.repairFailureCount,
          durationMs: result.durationMs,
        });

        return result;
      }

      default: {
        // TypeScript exhaustiveness guard
        const exhaustive: never = type;
        throw new Error(`Unknown verification job type: ${exhaustive}`);
      }
    }
  },
  {
    connection,
    // Concurrency=1 prevents two full scans from running simultaneously and
    // avoids double-repairing the same rows if jobs queue up.
    concurrency: 1,
  },
);

matchedFundVerificationWorker.on('completed', (job) => {
  logger.info(`[matchedFundVerification] Job completed id=${job.id}`);
});

matchedFundVerificationWorker.on('failed', (job, err) => {
  logger.error(`[matchedFundVerification] Job failed id=${job?.id}`, {
    jobType: job?.data?.type,
    error: err.message,
    stack: err.stack,
  });
});

matchedFundVerificationWorker.on('error', (err) => {
  logger.error('[matchedFundVerification] Worker error', { error: err.message });
});

export default matchedFundVerificationWorker;
