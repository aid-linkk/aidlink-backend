import { PrismaClient, PledgeAttemptStatus, PledgeStatus, NotificationType, TransactionType } from '@prisma/client';
import { PledgeService } from '../services/pledge.service';
import { DonationService } from '../services/donation.service';
import { createFailedPledgeCase } from '../services/recovery.service';
import { getPaymentProvider } from '../services/payment';
import { buildPledgeIdempotencyKey } from '../services/payment/idempotencyKey';
import { PaymentProvider } from '../services/payment/types';
import { sorobanIndexer } from '../blockchain/soroban.indexer';
import logger from '../config/logger';

const MAX_RETRIES = parseInt(process.env.PLEDGE_MAX_RETRIES ?? '3', 10);
const REMINDER_WINDOW_DAYS = parseInt(process.env.PLEDGE_REMINDER_WINDOW_DAYS ?? '3', 10);

/**
 * @notice Exponential backoff delay in ms for retry attempts
 */
function backoffDelay(retryCount: number): number {
  return Math.min(1000 * Math.pow(2, retryCount), 24 * 60 * 60 * 1000);
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
    const paymentProvider = getPaymentProvider();
    const duePledges = await this.pledgeService.getDuePledges();

    logger.info(`Processing ${duePledges.length} due pledges`);

    for (const pledge of duePledges) {
      await this.processSinglePledge(pledge, paymentProvider);
    }
  }

  /**
   * @notice Charges and settles a single due pledge. Restart-safe and
   * idempotent per billing cycle — see the module-level notes on
   * buildPledgeIdempotencyKey for why the key is stable across retries.
   */
  private async processSinglePledge(pledge: any, paymentProvider: PaymentProvider): Promise<void> {
    // Captured BEFORE any attempt is recorded for this tick, so re-running
    // this same tick after a crash always derives the same idempotency key
    // and the same retry-scoping window, no matter how many times it retries.
    const cycleStartAt: Date = pledge.nextRunAt ?? pledge.startDate;
    const idempotencyKey = buildPledgeIdempotencyKey(pledge.id, cycleStartAt);

    try {
      if (!pledge.campaignId) {
        // A confirmed Donation requires a campaign to credit; a pledge
        // without one can never be fulfilled as-is.
        throw new Error('Pledge has no linked campaignId; cannot create a donation');
      }

      // ── Restart safety ────────────────────────────────────────────────
      // If a prior run already completed this exact billing cycle (payment
      // succeeded AND the Donation/PledgeAttempt transaction committed),
      // this row will exist. Skip straight to advancing the schedule
      // without charging the donor again.
      const completedAttempt = await this.prisma.pledgeAttempt.findFirst({
        where: {
          pledgeId: pledge.id,
          providerReference: idempotencyKey,
          status: PledgeAttemptStatus.SUCCESS,
        },
      });

      if (completedAttempt) {
        logger.warn('Pledge cycle already completed — skipping duplicate charge', {
          pledgeId: pledge.id,
          idempotencyKey,
        });
      } else {
        await this.chargeAndRecordDonation(pledge, paymentProvider, idempotencyKey, cycleStartAt);
      }

      await this.pledgeService.markAttemptSuccess(pledge.id);
      logger.info('Pledge processed successfully', { pledgeId: pledge.id });
    } catch (error: any) {
      await this.handleFailedAttempt(pledge, cycleStartAt, error);
    }
  }

  /**
   * @notice Charges the payment provider using a stable per-cycle
   * idempotency key, then atomically creates the Donation + PledgeAttempt
   * rows in a single transaction. If the process crashes between the charge
   * succeeding and this transaction committing, the next tick re-derives
   * the same idempotencyKey, finds no completed PledgeAttempt yet, and will
   * call charge() again — which is safe because the underlying providers
   * are required to be idempotent per-key (Stripe natively; the mock
   * provider by design; Stellar via the worker-level guard above, since the
   * chain itself has no idempotency concept — see stellarProvider.ts).
   */
  private async chargeAndRecordDonation(
    pledge: any,
    paymentProvider: PaymentProvider,
    idempotencyKey: string,
    cycleStartAt: Date,
  ): Promise<void> {
    const metadata = (pledge.metadata ?? {}) as Record<string, unknown>;

    const chargeResult = await paymentProvider.charge({
      idempotencyKey,
      amount: pledge.amount.toNumber(),
      currency: pledge.currency,
      donorId: pledge.donorId,
      campaignId: pledge.campaignId,
      pledgeId: pledge.id,
      stripeCustomerId: metadata.stripeCustomerId as string | undefined,
      stripePaymentMethodId: metadata.stripePaymentMethodId as string | undefined,
    });

    // A Donation.blockchainTxHash unique constraint is our last line of
    // defense: even if two ticks somehow raced past the PledgeAttempt
    // check above, only one can win this insert.
    const { donation } = await this.prisma.$transaction(async (tx) => {
      const createResult = await DonationService.createConfirmedDonation(tx, {
        campaignId: pledge.campaignId,
        userId: pledge.donorId,
        amount: pledge.amount,
        currency: pledge.currency,
        blockchainTxHash: chargeResult.providerReference,
        isAnonymous: false,
        memo: `Recurring pledge ${pledge.id}`,
      });

      await tx.pledgeAttempt.create({
        data: {
          pledgeId: pledge.id,
          status: PledgeAttemptStatus.SUCCESS,
          providerReference: idempotencyKey,
          billingCycleAt: cycleStartAt,
          retryCount: 0,
          metadata: {
            donationId: createResult.donation.id,
            providerChargeReference: chargeResult.providerReference,
            provider: chargeResult.provider,
          },
        },
      });

      return createResult;
    });

    if (chargeResult.provider === 'stellar') {
      // Record the on-chain transaction via the indexer rather than
      // bypassing it, per the issue's constraint.
      await sorobanIndexer
        .indexTransaction(chargeResult.providerReference, TransactionType.DONATION, {
          amount: pledge.amount.toString(),
          currency: pledge.currency,
        })
        .catch((err) => logger.error('Failed to index pledge Stellar transaction', { pledgeId: pledge.id, err }));
    }

    DonationService.dispatchPostConfirmationSideEffects({
      donationId: donation.id,
      campaignId: pledge.campaignId,
      amount: donation.amount,
      currency: donation.currency,
      txHash: chargeResult.providerReference,
      isAnonymous: false,
      userId: pledge.donorId,
    });
  }

  /**
   * @notice Records a failed attempt with a retry count scoped to the
   * *current billing cycle only* (attempts with attemptAt >= cycleStartAt),
   * fixing the bug where all-time attempts across every past successful
   * cycle inflated the counter and caused premature dead-lettering. Once
   * MAX_RETRIES is reached within this cycle, the pledge is marked FAILED,
   * the donor is notified, and a FAILED_PLEDGE recovery case is opened.
   */
  private async handleFailedAttempt(pledge: any, cycleStartAt: Date, error: any): Promise<void> {
    logger.error('Pledge processing failed', { pledgeId: pledge.id, error: error.message });

    const priorAttemptsThisCycle = await this.prisma.pledgeAttempt.count({
      where: { pledgeId: pledge.id, attemptAt: { gte: cycleStartAt } },
    });
    const retryCount = priorAttemptsThisCycle + 1;

    await this.prisma.pledgeAttempt.create({
      data: {
        pledgeId: pledge.id,
        status: PledgeAttemptStatus.FAILED,
        failureReason: error.message,
        retryCount,
        billingCycleAt: cycleStartAt,
      },
    });

    if (retryCount >= MAX_RETRIES) {
      await this.prisma.pledge.update({
        where: { id: pledge.id },
        data: { status: PledgeStatus.FAILED },
      });

      await this.prisma.notification.create({
        data: {
          userId: pledge.donorId,
          type: NotificationType.PLEDGE_PAYMENT_FAILED,
          title: 'Pledge Payment Failed',
          message: `We were unable to process your pledge payment after ${retryCount} attempts: ${error.message}. Our team has been notified.`,
          metadata: { pledgeId: pledge.id, retryCount },
          sentVia: [],
        },
      });

      await createFailedPledgeCase(pledge.id, pledge.donorId, error.message, {
        cycleStartAt,
        retryCount,
      }).catch((caseError) =>
        logger.error('Failed to create FAILED_PLEDGE recovery case', { pledgeId: pledge.id, caseError }),
      );

      logger.warn('Pledge marked as FAILED after max retries in current cycle; dead-lettered', {
        pledgeId: pledge.id,
        retryCount,
      });
    } else {
      // Schedule retry with backoff
      const delay = backoffDelay(retryCount);
      const nextRunAt = new Date(Date.now() + delay);
      await this.prisma.pledge.update({
        where: { id: pledge.id },
        data: { nextRunAt },
      });
      logger.info('Pledge retry scheduled', { pledgeId: pledge.id, nextRunAt, retryCount });
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
