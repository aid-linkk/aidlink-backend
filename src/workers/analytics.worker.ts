import { Worker, Queue, Job } from 'bullmq';
import { config } from '../config';
import { AnalyticsService } from '../services/analytics.service';
import logger from '../config/logger';

const QUEUE_NAME = 'analytics-queue';

const connection = {
  host: config.bullmq.redisHost,
  port: config.bullmq.redisPort,
  password: config.bullmq.redisPassword,
};

// Producer — used to enqueue real-time cache updates and scheduled jobs.
export const analyticsQueue = new Queue(QUEUE_NAME, { connection });

/**
 * Enqueue a real-time analytics cache update after a donation event.
 */
export const enqueueRealtimeDonationUpdate = async (
  campaignId: string,
  amount: number,
): Promise<void> => {
  await analyticsQueue.add(
    'REALTIME_DONATION',
    { type: 'REALTIME_DONATION', data: { campaignId, amount } },
    {
      jobId: `realtime-donation:${campaignId}:${Date.now()}`,
      removeOnComplete: true,
      removeOnFail: 100,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    },
  );
};

/**
 * Enqueue a real-time analytics cache update after a distribution event.
 */
export const enqueueRealtimeDistributionUpdate = async (
  campaignId: string,
  amount: number,
): Promise<void> => {
  await analyticsQueue.add(
    'REALTIME_DISTRIBUTION',
    { type: 'REALTIME_DISTRIBUTION', data: { campaignId, amount } },
    {
      jobId: `realtime-distribution:${campaignId}:${Date.now()}`,
      removeOnComplete: true,
      removeOnFail: 100,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    },
  );
};

/**
 * Register the scheduled analytics jobs:
 * - Hourly rollup (every hour at :05)
 * - Monthly rollup (1st of month at 02:00)
 * - Trending campaign refresh (every 15 minutes)
 * - Cache reconciliation (every 6 hours)
 */
export const scheduleAnalyticsJobs = async (): Promise<void> => {
  if (!config.analytics.analyticsWorkerEnabled) {
    logger.info('Analytics worker disabled; skipping analytics schedule');
    return;
  }

  // Hourly rollup
  await analyticsQueue.add(
    'HOURLY_ROLLUP',
    { type: 'HOURLY_ROLLUP', data: {} },
    {
      repeat: { pattern: config.analytics.hourlyRollupCron },
      jobId: 'analytics-hourly-rollup',
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );

  // Monthly rollup
  await analyticsQueue.add(
    'MONTHLY_ROLLUP',
    { type: 'MONTHLY_ROLLUP', data: {} },
    {
      repeat: { pattern: config.analytics.monthlyRollupCron },
      jobId: 'analytics-monthly-rollup',
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );

  // Trending campaign refresh
  await analyticsQueue.add(
    'TRENDING_REFRESH',
    { type: 'TRENDING_REFRESH', data: {} },
    {
      repeat: { pattern: config.analytics.trendingRefreshCron },
      jobId: 'analytics-trending-refresh',
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );

  // Cache reconciliation (every 6 hours)
  await analyticsQueue.add(
    'CACHE_RECONCILE',
    { type: 'CACHE_RECONCILE', data: {} },
    {
      repeat: { pattern: '0 */6 * * *' },
      jobId: 'analytics-cache-reconcile',
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );

  logger.info('Scheduled analytics jobs: hourly, monthly, trending, cache-reconcile');
};

const analyticsWorker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    const { type, data } = job.data;

    logger.info(`Processing analytics job: ${job.id}, type: ${type}`);

    switch (type) {
      case 'HOURLY_ROLLUP': {
        const result = await AnalyticsService.runHourlyRollup();
        logger.info(`Hourly rollup completed: ${result.processed} campaigns for ${result.hourOf}`);
        return result;
      }

      case 'MONTHLY_ROLLUP': {
        const result = await AnalyticsService.runMonthlyRollup();
        logger.info(`Monthly rollup completed: ${result.processed} campaigns for ${result.monthOf}`);
        return result;
      }

      case 'TRENDING_REFRESH': {
        await AnalyticsService.refreshTrendingCampaigns();
        logger.info('Trending campaigns refreshed');
        return { success: true };
      }

      case 'CACHE_RECONCILE': {
        const rebuilt = await AnalyticsService.rebuildAllCampaignCaches();
        logger.info(`Cache reconciliation completed: ${rebuilt} campaigns rebuilt`);
        return { rebuilt };
      }

      case 'REALTIME_DONATION': {
        await AnalyticsService.incrementDonationStats(data.campaignId, data.amount);
        // Also update the trending ZSET for real-time trending
        return { campaignId: data.campaignId };
      }

      case 'REALTIME_DISTRIBUTION': {
        await AnalyticsService.incrementDistributionStats(data.campaignId, data.amount);
        return { campaignId: data.campaignId };
      }

      default:
        throw new Error(`Unknown analytics job type: ${type}`);
    }
  },
  {
    connection,
    concurrency: 3,
  },
);

analyticsWorker.on('completed', (job) => {
  logger.info(`Analytics job completed: ${job.id}`);
});

analyticsWorker.on('failed', (job, err) => {
  logger.error(`Analytics job failed: ${job?.id}`, err);
});

export default analyticsWorker;
