import { Worker, Job } from 'bullmq';
import { z } from 'zod';
import { config } from '../config';
import { NotificationService } from '../services/notification.service';
import logger from '../config/logger';

// ── Job Data Schemas ────────────────────────────────────────────────

const DonationReceivedSchema = z.object({
  type: z.literal('DONATION_RECEIVED'),
  data: z.object({
    userId: z.string(),
    campaignTitle: z.string().min(1),
    amount: z.number().positive(),
  }),
});

const CampaignUpdateSchema = z.object({
  type: z.literal('CAMPAIGN_UPDATE'),
  data: z.object({
    userId: z.string(),
    campaignTitle: z.string().min(1),
    update: z.string().min(1),
  }),
});

const DistributionSentSchema = z.object({
  type: z.literal('DISTRIBUTION_SENT'),
  data: z.object({
    userId: z.string(),
    amount: z.number().positive(),
  }),
});

const KYCApprovedSchema = z.object({
  type: z.literal('KYC_APPROVED'),
  data: z.object({
    userId: z.string(),
  }),
});

const KYCRejectedSchema = z.object({
  type: z.literal('KYC_REJECTED'),
  data: z.object({
    userId: z.string(),
    reason: z.string().min(1),
  }),
});

const EmailJobSchema = z.union([
  DonationReceivedSchema,
  CampaignUpdateSchema,
  DistributionSentSchema,
  KYCApprovedSchema,
  KYCRejectedSchema,
]);

type EmailJobData = z.infer<typeof EmailJobSchema>;

// ── Worker Instance ─────────────────────────────────────────────────

let emailWorker: Worker | null = null;

function createWorker(): Worker {
  return new Worker(
    'email-queue',
    async (job: Job<EmailJobData>) => {
      const parsed = EmailJobSchema.safeParse(job.data);
      if (!parsed.success) {
        logger.error(`Invalid email job data for job ${job.id}:`, parsed.error.flatten());
        throw new Error(`Invalid job data: ${parsed.error.message}`);
      }

      const { type, data } = parsed.data;

      logger.info(`Processing email job: ${job.id}, type: ${type}`);

      switch (type) {
        case 'DONATION_RECEIVED':
          await NotificationService.sendDonationReceivedNotification(
            data.userId,
            data.campaignTitle,
            data.amount,
            data.currency || 'XLM'
          );
          break;

        case 'CAMPAIGN_UPDATE':
          await NotificationService.sendCampaignUpdateNotification(
            data.userId,
            data.campaignTitle,
            data.update
          );
          break;

        case 'DISTRIBUTION_SENT':
          await NotificationService.sendDistributionSentNotification(
            data.userId,
            data.amount,
            data.currency || 'XLM'
          );
          break;

        case 'KYC_APPROVED':
          await NotificationService.sendKYCApprovedNotification(data.userId);
          break;

        case 'KYC_REJECTED':
          await NotificationService.sendKYCRejectedNotification(
            data.userId,
            data.reason
          );
          break;

        default:
          throw new Error(`Unknown email job type: ${(parsed.data as any).type}`);
      }

      logger.info(`Email job completed: ${job.id}`);
    },
    {
      connection: {
        host: config.bullmq.redisHost,
        port: config.bullmq.redisPort,
        password: config.bullmq.redisPassword,
      },
      concurrency: 5,
    }
  );
}

// ── Lifecycle ───────────────────────────────────────────────────────

export function startEmailWorker(): Worker {
  if (emailWorker) {
    logger.warn('Email worker is already running');
    return emailWorker;
  }

  emailWorker = createWorker();

  emailWorker.on('completed', (job) => {
    logger.info(`Email job completed: ${job.id}`);
  });

  emailWorker.on('failed', (job, err) => {
    logger.error(`Email job failed: ${job?.id}`, err);
  });

  emailWorker.on('error', (err) => {
    logger.error('Email worker error:', err);
  });

  logger.info('Email worker started (email-queue, concurrency=5)');
  return emailWorker;
}

export async function stopEmailWorker(): Promise<void> {
  if (!emailWorker) return;
  await emailWorker.close();
  emailWorker = null;
  logger.info('Email worker stopped');
}

export default emailWorker;
