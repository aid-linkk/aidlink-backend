import { Worker } from 'bullmq';
import { Queue } from 'bullmq';
import { config } from '../config';
import { WebhookService } from '../services/webhook.service';
import logger from '../config/logger';

const connection = {
  host: config.bullmq.redisHost,
  port: config.bullmq.redisPort,
  password: config.bullmq.redisPassword,
};

export const webhookQueue = new Queue('webhook-delivery', { connection });

const webhookWorker = new Worker(
  'webhook-delivery',
  async (job) => {
    const { eventId } = job.data;
    await WebhookService.deliverEvent(eventId);
  },
  { connection, concurrency: 10 }
);

webhookWorker.on('failed', (job, err) => {
  logger.error(`Webhook delivery job ${job?.id} failed:`, err);
});

// Schedule retry processing every 60 seconds
setInterval(async () => {
  try {
    await WebhookService.processDueRetries();
  } catch (err) {
    logger.error('Webhook retry processor error:', err);
  }
}, 60_000);

export default webhookWorker;
