/**
 * fraudRecalibration.worker.ts
 *
 * BullMQ worker for online Platt / isotonic re-calibration of the KYC fraud model.
 *
 * Two trigger paths:
 *
 *  1. Periodic cron  – enqueued by scheduleFraudRecalibrationCron() at startup.
 *     Default schedule: 0 3 * * * (3 AM UTC daily).
 *
 *  2. Label-count threshold  – createFraudLabel() in kycFraud.service.ts calls
 *     enqueueFraudRecalibration() when the unlabelled count crosses
 *     FRAUD_RECALIBRATION_LABEL_TRIGGER (default 200).
 *
 * The worker is deliberately non-blocking with respect to assessFraud():
 *   - assessFraud() reads the active model version from Redis cache.
 *   - After runRecalibration() completes the version swap, this worker calls
 *     invalidateFraudModelCache() so the new parameters are picked up on the
 *     very next request (or within one TTL on Redis failure).
 */

import { Worker, Queue, Job } from 'bullmq';
import { config } from '../config';
import { runRecalibration } from '../services/fraudCalibration.service';
import { invalidateFraudModelCache } from '../services/kycFraud.service';
import logger from '../config/logger';

// ─── Queue name & connection ──────────────────────────────────────────────────

export const FRAUD_RECALIBRATION_QUEUE = 'fraud-recalibration-queue';
export const FRAUD_RECALIBRATE_JOB = 'FRAUD_RECALIBRATE';

const connection = {
  host: config.bullmq.redisHost,
  port: config.bullmq.redisPort,
  password: config.bullmq.redisPassword,
};

// ─── Queue producer ───────────────────────────────────────────────────────────

export const fraudRecalibrationQueue = new Queue(FRAUD_RECALIBRATION_QUEUE, {
  connection,
  defaultJobOptions: {
    removeOnComplete: 50,   // Keep the last 50 completed jobs for audit
    removeOnFail: 100,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
  },
});

/**
 * Enqueue a single FRAUD_RECALIBRATE job.
 *
 * De-duplicated by a stable jobId so concurrent enqueues from multiple label
 * writes don't stack up: if a job with the same id is already queued or active,
 * BullMQ silently discards the duplicate.
 *
 * @param reason  Human-readable trigger source (for logging / metadata)
 */
export async function enqueueFraudRecalibration(reason: string): Promise<void> {
  try {
    await fraudRecalibrationQueue.add(
      FRAUD_RECALIBRATE_JOB,
      {
        type: FRAUD_RECALIBRATE_JOB,
        triggeredBy: reason,
        enqueuedAt: new Date().toISOString(),
      },
      {
        // Stable id: only one pending recalibration job at a time
        jobId: `${FRAUD_RECALIBRATE_JOB}:singleton`,
        // Allow a new singleton job to be queued even if one just completed
        // BullMQ will coalesce if the same jobId is already queued/active
      },
    );
    logger.info(`Fraud recalibration job enqueued (reason: ${reason})`);
  } catch (err) {
    // Never propagate — enqueue failure must not block label creation or assessFraud
    logger.warn('Failed to enqueue fraud recalibration job', { error: err, reason });
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const fraudRecalibrationWorker = new Worker(
  FRAUD_RECALIBRATION_QUEUE,
  async (job: Job) => {
    const { triggeredBy } = job.data as { triggeredBy: string };

    logger.info(`Fraud recalibration job started`, {
      jobId: job.id,
      triggeredBy,
    });

    const result = await runRecalibration();

    if (result === null) {
      // runRecalibration logs the reason (no active version / insufficient labels)
      logger.info('Fraud recalibration skipped (see previous log for reason)', {
        jobId: job.id,
      });
      return { status: 'skipped' };
    }

    // Invalidate Redis cache so the next assessFraud() call sees the new version
    await invalidateFraudModelCache();

    logger.info('Fraud recalibration job completed', {
      jobId: job.id,
      newVersionId: result.newVersionId,
      oldVersionId: result.oldVersionId,
      oldEce: result.oldEce,
      newEce: result.newEce,
      newAuc: result.newAuc,
      calibrationType: result.calibrationType,
    });

    return {
      status: 'completed',
      ...result,
    };
  },
  {
    connection,
    concurrency: 1,   // Only one recalibration at a time to avoid concurrent version swaps
  },
);

fraudRecalibrationWorker.on('completed', (job, returnValue) => {
  logger.info(`Fraud recalibration worker: job ${job.id} completed`, { returnValue });
});

fraudRecalibrationWorker.on('failed', (job, err) => {
  logger.error(`Fraud recalibration worker: job ${job?.id} failed`, { error: err });
});

// ─── Cron scheduler ──────────────────────────────────────────────────────────

/**
 * Register the recurring cron-based recalibration job.
 *
 * Call this once at application startup (e.g. from src/index.ts).
 * BullMQ persists the repeatable job in Redis, so it survives process restarts.
 */
export async function scheduleFraudRecalibrationCron(): Promise<void> {
  const cron = config.fraudRecalibration.cron;

  try {
    // Remove any stale repeatable jobs that may have a different cron pattern
    const existing = await fraudRecalibrationQueue.getRepeatableJobs();
    for (const job of existing) {
      if (job.name === FRAUD_RECALIBRATE_JOB) {
        await fraudRecalibrationQueue.removeRepeatableByKey(job.key);
        logger.info(`Removed stale repeatable fraud recalibration job: ${job.key}`);
      }
    }

    await fraudRecalibrationQueue.add(
      FRAUD_RECALIBRATE_JOB,
      {
        type: FRAUD_RECALIBRATE_JOB,
        triggeredBy: 'cron',
      },
      {
        repeat: { pattern: cron },
        jobId: `${FRAUD_RECALIBRATE_JOB}:cron`,
        removeOnComplete: 20,
        removeOnFail: 50,
      },
    );

    logger.info(`Fraud recalibration cron scheduled: ${cron}`);
  } catch (err) {
    logger.error('Failed to schedule fraud recalibration cron', { error: err });
  }
}

export default fraudRecalibrationWorker;
