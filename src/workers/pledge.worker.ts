import { PrismaClient, PledgeAttemptStatus, PledgeStatus } from '@prisma/client';
import { PledgeService } from '../services/pledge.service';
import logger from '../config/logger';

const MAX_RETRIES = parseInt(process.env.PLEDGE_MAX_RETRIES ?? '3', 10);
const REMINDER_WINDOW_DAYS = parseInt(process.env.PLEDGE_REMINDER_WINDOW_DAYS ?? '3', 10);

/**
 * @notice Exponential backoff delay in ms for retry attempts
 */
function backoffDelay(retryCount: number): number {
  return Math.min(1000 * Math.pow(2, retryCount), 24 * 60 * 60 * 1000);
}

/**
 * @notice Mock payment processor — replace with real integration
 */
async function processPayment(pledgeId: string, amount: number): Promise<string> {
  // Replace this with actual payment service call
  logger.info('Processing payment', { pledgeId, amount });
  return `ref-${pledgeId}-${Date.now()}`;
}

export class PledgeWorker {
  private pledgeService: PledgeService;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(private prisma: PrismaClient) {
    this.pledgeService = new PledgeService(prisma);
  }

  /**
   * @notice Process all due pledges
   */
  async processDuePledges(): Promise<void> {
    const duePledges = await this.pledgeService.getDuePledges();

    logger.info(`Processing ${duePledges.length} due pledges`);

    for (const pledge of duePledges) {
      try {
        const providerReference = await processPayment(
          pledge.id,
          pledge.amount.toNumber(),
        );

        await this.pledgeService.recordAttempt(pledge.id, PledgeAttemptStatus.SUCCESS, {
          providerReference,
        });

        await this.pledgeService.markAttemptSuccess(pledge.id);

        logger.info('Pledge processed successfully', { pledgeId: pledge.id });
      } catch (error: any) {
        logger.error('Pledge processing failed', { pledgeId: pledge.id, error: error.message });

        // Get retry count from latest attempt
        const attempts = await this.pledgeService.listAttempts(pledge.id);
        const retryCount = attempts.length;

        await this.pledgeService.recordAttempt(pledge.id, PledgeAttemptStatus.FAILED, {
          failureReason: error.message,
          retryCount,
        });

        if (retryCount >= MAX_RETRIES) {
          await this.prisma.pledge.update({
            where: { id: pledge.id },
            data: { status: PledgeStatus.FAILED },
          });
          logger.warn('Pledge marked as FAILED after max retries', { pledgeId: pledge.id });
        } else {
          // Schedule retry with backoff
          const delay = backoffDelay(retryCount);
          const nextRunAt = new Date(Date.now() + delay);
          await this.prisma.pledge.update({
            where: { id: pledge.id },
            data: { nextRunAt },
          });
          logger.info('Pledge retry scheduled', { pledgeId: pledge.id, nextRunAt });
        }
      }
    }
  }

  /**
   * @notice Send reminders for pledges due within reminder window
   */
  async sendReminders(): Promise<void> {
    const windowEnd = new Date();
    windowEnd.setDate(windowEnd.getDate() + REMINDER_WINDOW_DAYS);

    const upcomingPledges = await this.prisma.pledge.findMany({
      where: {
        status: PledgeStatus.ACTIVE,
        nextRunAt: {
          gte: new Date(),
          lte: windowEnd,
        },
      },
    });

    logger.info(`Sending reminders for ${upcomingPledges.length} upcoming pledges`);

    for (const pledge of upcomingPledges) {
      logger.info('Reminder sent for pledge', {
        pledgeId: pledge.id,
        nextRunAt: pledge.nextRunAt,
        donorId: pledge.donorId,
      });
      // Integrate with notification.service.ts here
    }
  }

  /**
   * @notice Start the worker on a schedule
   * @param intervalMs - How often to run (default: 60 seconds)
   */
  start(intervalMs: number = 60_000): void {
    if (process.env.PLEDGE_WORKER_ENABLED !== 'true') {
      logger.info('Pledge worker disabled via PLEDGE_WORKER_ENABLED env var');
      return;
    }

    logger.info('Pledge worker started', { intervalMs });

    this.intervalId = setInterval(async () => {
      try {
        await this.processDuePledges();
        await this.sendReminders();
      } catch (error) {
        logger.error('Pledge worker error', { error });
      }
    }, intervalMs);
  }

  /**
   * @notice Stop the worker
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Pledge worker stopped');
    }
  }
}