/**
 * Matched Fund Verification Worker
 *
 * BullMQ-backed worker that runs three types of consistency verification jobs:
 *
 *   FULL_VERIFICATION  — checks all Multiplier rows. Scheduled daily (or
 *                        as configured by MATCHED_FUND_VERIFICATION_FULL_CRON).
 *
 *   SAMPLE_VERIFICATION — checks a random TABLESAMPLE subset. Scheduled
 *                         hourly (MATCHED_FUND_VERIFICATION_SAMPLE_CRON).
 *
 *   TRIGGERED_VERIFICATION — one-shot check enqueued on-demand (e.g. by the
 *                            admin API or after a suspected anomaly). Treated
 *                            like FULL but marked separately in logs/results.
 *
 * Worker lifecycle mirrors analytics.worker.ts: the module exports the Queue
 * (for enqueueing), a schedule function (for cron setup), and a start/stop
 * function (for graceful shutdown). index.ts dynamically imports and starts
 * it when the feature flag is enabled.
 */

import { Worker, Queue, Job } from 'bullmq';
import { config } from '../config';
import {
  MatchedFundVerificationService,
  VerificationMode,
  VerificationResult,
} from '../services/matchedFundVerification.service';
import logger from '../config/logger';

export const QUEUE_NAME = 'matched-fund-verification-queue';

const connection = {
  host: config.bullmq.redisHost,
  port: config.bullmq.redisPort,
  password: config.bullmq.redisPassword,
};

// ─── Producer / Queue ─────────────────────────────────────────────────────────

export const matchedFundVerificationQueue = new Queue(QUEUE_NAME, { connection });

export type VerificationJobType =
  | 'FULL_VERIFICATION'
  | 'SAMPLE_VERIFICATION'
  | 'TRIGGERED_VERIFICATION';

export interface VerificationJobData {
  type: VerificationJobType;
  /** For SAMPLE_VERIFICATION: percentage of rows to check (1–100). */
  samplePct?: number;
  /** Whether to auto-repair detected inconsistencies. Defaults to true. */
  autoRepair?: boolean;
  /** Optional correlation ID for tracing triggered jobs back to the request. */
  correlationId?: string;
}

/**
 * Enqueue a one-shot triggered verification. Called by the admin API route
 * when an operator wants to run an immediate check outside the scheduled cadence.
 */
export async function enqueueTriggedVerification(opts: {
  autoRepair?: boolean;
  correlationId?: string;
}): Promise<string> {
  const job = await matchedFundVerificationQueue.add(
    'TRIGGERED_VERIFICATION',
    {
      type: 'TRIGGERED_VERIFICATION',
      autoRepair: opts.autoRepair ?? true,
      correlationId: opts.correlationId,
    } satisfies VerificationJobData,
    {
      jobId: `triggered-verification:${opts.correlationId ?? Date.now()}`,
      removeOnComplete: 50,
      removeOnFail: 100,
      attempts: 2,
      backoff: { type: 'fixed', delay: 5_000 },
    },
  );
  return job.id!;
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Register the two recurring verification jobs.
 * Safe to call multiple times — BullMQ deduplicates by jobId.
 */
export async function scheduleVerificationJobs(): Promise<void> {
  if (!config.matchedFundVerification.enabled) {
    logger.info('MatchedFundVerification: worker disabled; skipping schedule');
    return;
  }

  // Full verification (default: daily at 02:30 UTC)
  await matchedFundVerificationQueue.add(
    'FULL_VERIFICATION',
    { type: 'FULL_VERIFICATION', autoRepair: true } satisfies VerificationJobData,
    {
      repeat: { pattern: config.matchedFundVerification.fullVerificationCron },
      jobId: 'matched-fund-full-verification',
      removeOnComplete: 10,
      removeOnFail: 100,
    },
  );

  // Sample verification (default: hourly at :45)
  await matchedFundVerificationQueue.add(
    'SAMPLE_VERIFICATION',
    {
      type: 'SAMPLE_VERIFICATION',
      autoRepair: true,
      samplePct: config.matchedFundVerification.samplePercent,
    } satisfies VerificationJobData,
    {
      repeat: { pattern: config.matchedFundVerification.sampleVerificationCron },
      jobId: 'matched-fund-sample-verification',
      removeOnComplete: 10,
      removeOnFail: 100,
    },
  );

  logger.info('MatchedFundVerification: scheduled full and sample verification jobs', {
    fullCron: config.matchedFundVerification.fullVerificationCron,
    sampleCron: config.matchedFundVerification.sampleVerificationCron,
  });
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const matchedFundVerificationWorker = new Worker(
  QUEUE_NAME,
  async (job: Job<VerificationJobData>): Promise<VerificationResult> => {
    const { type, autoRepair = true, samplePct, correlationId } = job.data;

    logger.info(`MatchedFundVerification: processing job ${job.id} (type=${type})`, {
      correlationId,
    });

    let mode: VerificationMode;
    switch (type) {
      case 'FULL_VERIFICATION':
        mode = 'FULL';
        break;
      case 'SAMPLE_VERIFICATION':
        mode = 'SAMPLE';
        break;
      case 'TRIGGERED_VERIFICATION':
        mode = 'TRIGGERED';
        break;
      default:
        throw new Error(`Unknown verification job type: ${type}`);
    }

    const result = await MatchedFundVerificationService.verify(mode, autoRepair, samplePct);

    // Surface key metrics in job output for BullMQ dashboard / log aggregation.
    logger.info(`MatchedFundVerification: job ${job.id} finished`, {
      mode,
      durationMs: result.durationMs,
      checkedCount: result.checkedCount,
      inconsistentCount: result.inconsistentCount,
      repairedCount: result.repairedCount,
      failedRepairCount: result.failedRepairCount,
      alertCount: result.alerts.length,
      correlationId,
    });

    return result;
  },
  {
    connection,
    // Serialize verification runs — only one active at a time to prevent
    // two simultaneous repair transactions from racing on the same multiplier.
    concurrency: 1,
  },
);

matchedFundVerificationWorker.on('completed', (job) => {
  logger.info(`MatchedFundVerification: job completed: ${job.id}`);
});

matchedFundVerificationWorker.on('failed', (job, err) => {
  logger.error(`MatchedFundVerification: job failed: ${job?.id}`, err);
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export async function startMatchedFundVerificationWorker(): Promise<void> {
  await scheduleVerificationJobs();
  logger.info('MatchedFundVerification: worker started');
}

export async function stopMatchedFundVerificationWorker(): Promise<void> {
  await matchedFundVerificationWorker.close();
  await matchedFundVerificationQueue.close();
  logger.info('MatchedFundVerification: worker stopped');
}

export default matchedFundVerificationWorker;
