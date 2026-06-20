import { Worker, Queue, Job } from 'bullmq';
import { config } from '../config';
import { ModerationService } from '../services/moderation.service';
import logger from '../config/logger';

const QUEUE_NAME = 'moderation-queue';

const connection = {
  host: config.bullmq.redisHost,
  port: config.bullmq.redisPort,
  password: config.bullmq.redisPassword,
};

// Producer — used to enqueue near-real-time and scheduled evaluations.
export const moderationQueue = new Queue(QUEUE_NAME, { connection });

/**
 * Enqueue evaluation of a single campaign (event-driven path, e.g. after a
 * new fraud report). De-duplicated by jobId so bursts collapse to one job.
 */
export const enqueueCampaignEvaluation = async (campaignId: string): Promise<void> => {
  await moderationQueue.add(
    'EVALUATE_CAMPAIGN',
    { type: 'EVALUATE_CAMPAIGN', data: { campaignId } },
    {
      jobId: `evaluate-campaign:${campaignId}`,
      removeOnComplete: true,
      removeOnFail: 100,
    }
  );
};

/**
 * Register the daily batch evaluation. No-op unless auto-suspension is enabled
 * so the feature flag fully gates background suspensions.
 */
export const scheduleModerationEvaluations = async (): Promise<void> => {
  if (!config.moderation.autoSuspendEnabled) {
    logger.info('Auto-suspension disabled; skipping moderation schedule');
    return;
  }

  await moderationQueue.add(
    'EVALUATE_ALL',
    { type: 'EVALUATE_ALL', data: {} },
    {
      repeat: { pattern: '0 2 * * *' }, // daily at 02:00
      jobId: 'moderation-evaluate-all',
      removeOnComplete: true,
      removeOnFail: 100,
    }
  );

  logger.info('Scheduled daily moderation batch evaluation');
};

const moderationWorker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    const { type, data } = job.data;

    logger.info(`Processing moderation job: ${job.id}, type: ${type}`);

    switch (type) {
      case 'EVALUATE_ALL': {
        const result = await ModerationService.evaluateAllCampaigns();
        return result;
      }

      case 'EVALUATE_CAMPAIGN': {
        const suspended = await ModerationService.evaluateCampaign(data.campaignId);
        return { campaignId: data.campaignId, suspended };
      }

      default:
        throw new Error(`Unknown moderation job type: ${type}`);
    }
  },
  {
    connection,
    concurrency: 5,
  }
);

moderationWorker.on('completed', (job) => {
  logger.info(`Moderation job completed: ${job.id}`);
});

moderationWorker.on('failed', (job, err) => {
  logger.error(`Moderation job failed: ${job?.id}`, err);
});

export default moderationWorker;
