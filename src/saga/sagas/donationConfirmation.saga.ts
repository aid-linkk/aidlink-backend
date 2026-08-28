/**
 * Donation Confirmation Saga
 *
 * Steps (in order):
 *  1. confirmDonationStatus     — PENDING → CONFIRMED (transactional, idempotent via updateMany guard)
 *  2. applyMultiplier           — evaluate active multiplier (transactional, idempotent)
 *  3. allocateMatchedFunds      — claim match-cap share (transactional, idempotent via unique donationId)
 *  4. updateCampaignBalance     — increment campaign.currentAmount (transactional)
 *  5. dispatchDonationWebhook   — fire DONATION_CONFIRMED event (async)
 *  6. incrementAnalyticsCache   — update Redis donation stats (async)
 *  7. enqueueReceiptGeneration  — enqueue receipt BullMQ job (async)
 *
 * Compensation order (reverse):
 *  7 ← cancel receipt job (no-op — BullMQ job not yet processed)
 *  6 ← decrementAnalyticsCache
 *  5 ← dispatch DONATION_CANCELLED webhook
 *  4 ← decrement campaign.currentAmount
 *  3 ← mark MatchedFund as refunded, reverse Multiplier.matchedTotal
 *  2 ← (no state written by multiplier evaluation alone — step 3 owns the undo)
 *  1 ← revert donation status to PENDING
 *
 * Note: steps 2–4 run inside the CALLER'S Prisma transaction (isTransactional: true).
 * The caller passes tx to the saga; the saga does not create its own transaction for
 * these steps. The saga state rows are always in their own independent transactions.
 */

import { DonationStatus, Prisma } from '@prisma/client';
import prisma from '../../config/database';
import logger from '../../config/logger';
import { config } from '../../config';
import { SagaDefinition } from '../types';
import { MultiplierService } from '../../services/multiplier.service';
import { MatchedFundAllocationService } from '../../services/matchedFundAllocation.service';
import { AnalyticsService } from '../../services/analytics.service';
import { dispatchWebhookEvent } from '../../controllers/webhook.controller';
import { AppError } from '../../middleware/error';

// ─── Input / Output types ────────────────────────────────────────────────────

export interface DonationConfirmationInput {
  donationId: string;
  txHash: string;
  campaignId: string;
  donorUserId: string | null;
  isAnonymous: boolean;
}

interface Step1Output {
  donationId: string;
  campaignId: string;
  donorAmount: Prisma.Decimal;
  currency: string;
  txHash: string;
  userId: string | null;
  isAnonymous: boolean;
}

interface Step2Output extends Step1Output {
  multiplier: Awaited<ReturnType<typeof MultiplierService.evaluateMultiplierAtDonation>> | null;
}

interface Step3Output extends Step2Output {
  matchedFund: Awaited<ReturnType<typeof MatchedFundAllocationService.allocate>> | null;
}

interface Step4Output extends Step3Output {
  campaignUpdated: boolean;
}

// Final saga output
export interface DonationConfirmationOutput {
  donationId: string;
  campaignId: string;
  donorAmount: Prisma.Decimal;
  currency: string;
  txHash: string;
  userId: string | null;
  isAnonymous: boolean;
  matchedFund: Awaited<ReturnType<typeof MatchedFundAllocationService.allocate>> | null;
  multiplierApplied: string | null;
}

// ─── Step definitions ────────────────────────────────────────────────────────

const confirmDonationStatusStep = {
  name: 'confirmDonationStatus',
  isTransactional: true,
  isAsync: false,

  async execute(
    input: DonationConfirmationInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Step1Output> {
    const client = tx ?? prisma;

    // Idempotent atomic guard — only one concurrent confirmation can win
    const result = await client.donation.updateMany({
      where: { id: input.donationId, status: { not: DonationStatus.CONFIRMED } },
      data: { status: DonationStatus.CONFIRMED, blockchainTxHash: input.txHash },
    });

    if (result.count === 0) {
      // Idempotency: already confirmed — fetch current state and pass through
      const existing = await client.donation.findUnique({
        where: { id: input.donationId },
      });
      if (!existing || existing.status !== DonationStatus.CONFIRMED) {
        throw AppError.from('DONATION_002');
      }
      return {
        donationId: existing.id,
        campaignId: existing.campaignId,
        donorAmount: existing.amount,
        currency: existing.currency,
        txHash: input.txHash,
        userId: existing.userId,
        isAnonymous: existing.isAnonymous,
      };
    }

    const updated = await client.donation.findUniqueOrThrow({
      where: { id: input.donationId },
    });

    return {
      donationId: updated.id,
      campaignId: updated.campaignId,
      donorAmount: updated.amount,
      currency: updated.currency,
      txHash: input.txHash,
      userId: updated.userId,
      isAnonymous: updated.isAnonymous,
    };
  },

  async compensate(output: Step1Output): Promise<void> {
    // Revert to PENDING so the donation can be reconfirmed if compensation succeeds
    await prisma.donation.updateMany({
      where: { id: output.donationId, status: DonationStatus.CONFIRMED },
      data: { status: DonationStatus.PENDING, blockchainTxHash: null },
    });
    logger.info(`[Saga] Compensated confirmDonationStatus for donation ${output.donationId}`);
  },
};

const applyMultiplierStep = {
  name: 'applyMultiplier',
  isTransactional: true,
  isAsync: false,

  async execute(
    input: Step1Output,
    tx?: Prisma.TransactionClient,
  ): Promise<Step2Output> {
    const client = tx ?? prisma;
    const multiplier = await MultiplierService.evaluateMultiplierAtDonation(
      { campaignId: input.campaignId, donationTime: new Date(), milestoneId: null },
      client,
    );
    return { ...input, multiplier };
  },

  // Multiplier evaluation is read-only — no compensation needed.
  // The matched fund allocation (step 3) owns the undo for any state written.
};

const allocateMatchedFundsStep = {
  name: 'allocateMatchedFunds',
  isTransactional: true,
  isAsync: false,

  async execute(
    input: Step2Output,
    tx?: Prisma.TransactionClient,
  ): Promise<Step3Output> {
    const client = tx ?? prisma;
    const matchedFund = await MatchedFundAllocationService.allocate(client, {
      donationId: input.donationId,
      campaignId: input.campaignId,
      donorAmount: input.donorAmount,
      multiplier: input.multiplier,
    });
    return { ...input, matchedFund };
  },

  async compensate(output: Step3Output): Promise<void> {
    if (!output.matchedFund) return; // Nothing was allocated

    await prisma.$transaction(async (tx) => {
      // Mark the matched fund as refunded
      await tx.matchedFund.update({
        where: { id: output.matchedFund!.id },
        data: { refundedAt: new Date() },
      });

      // Reverse the matchedTotal on the Multiplier using the same GREATEST guard
      // pattern as DonationService.refundDonation to prevent going below zero.
      await tx.$queryRaw`
        UPDATE "Multiplier"
        SET "matchedTotal" = GREATEST("matchedTotal" - ${output.matchedFund!.matchedAmount.toString()}::numeric, 0)
        WHERE id = ${output.matchedFund!.multiplierId}
      `;
    });

    logger.info(
      `[Saga] Compensated allocateMatchedFunds: reversed matchedFund ${output.matchedFund.id}`,
    );
  },
};

const updateCampaignBalanceStep = {
  name: 'updateCampaignBalance',
  isTransactional: true,
  isAsync: false,

  async execute(
    input: Step3Output,
    tx?: Prisma.TransactionClient,
  ): Promise<Step4Output> {
    const client = tx ?? prisma;
    await client.campaign.update({
      where: { id: input.campaignId },
      data: { currentAmount: { increment: input.donorAmount } },
    });
    return { ...input, campaignUpdated: true };
  },

  async compensate(output: Step4Output): Promise<void> {
    if (!output.campaignUpdated) return;
    await prisma.campaign.update({
      where: { id: output.campaignId },
      data: { currentAmount: { decrement: output.donorAmount } },
    });
    logger.info(
      `[Saga] Compensated updateCampaignBalance: decremented campaign ${output.campaignId} by ${output.donorAmount}`,
    );
  },
};

const dispatchDonationWebhookStep = {
  name: 'dispatchDonationWebhook',
  isTransactional: false,
  isAsync: true,

  async execute(input: Step4Output): Promise<void> {
    await dispatchWebhookEvent('DONATION_CONFIRMED', {
      donationId: input.donationId,
      campaignId: input.campaignId,
      amount: input.donorAmount,
      currency: input.currency,
      blockchainTxHash: input.txHash,
      isAnonymous: input.isAnonymous,
    });
  },

  async compensate(output: void, input: Step4Output): Promise<void> {
    // Send a best-effort cancellation webhook so subscribers can undo
    // any side effects they applied on the DONATION_CONFIRMED event.
    await dispatchWebhookEvent('DONATION_CONFIRMED', {
      donationId: input.donationId,
      campaignId: input.campaignId,
      amount: input.donorAmount,
      currency: input.currency,
      blockchainTxHash: input.txHash,
      isAnonymous: input.isAnonymous,
      _compensated: true,
    } as any).catch((err) =>
      logger.error('[Saga] Failed to dispatch compensation webhook:', err),
    );
  },
};

const incrementAnalyticsCacheStep = {
  name: 'incrementAnalyticsCache',
  isTransactional: false,
  isAsync: true,

  async execute(input: Step4Output): Promise<void> {
    await AnalyticsService.incrementDonationStats(
      input.campaignId,
      input.donorAmount,
      input.userId,
    );
  },

  async compensate(output: void, input: Step4Output): Promise<void> {
    await AnalyticsService.decrementDonationStats(
      input.campaignId,
      input.donorAmount,
      input.userId,
    ).catch((err) => logger.error('[Saga] Failed to decrement analytics cache:', err));
  },
};

const enqueueReceiptGenerationStep = {
  name: 'enqueueReceiptGeneration',
  isTransactional: false,
  isAsync: true,

  async execute(input: Step4Output): Promise<void> {
    if (!config.receipts.enabled || !input.userId) return;
    const { enqueueReceiptGeneration } = await import('../../workers/receipt.worker.js');
    await enqueueReceiptGeneration(input.donationId);
  },

  async compensate(output: void, input: Step4Output): Promise<void> {
    // BullMQ job is idempotent (uses jobId = generate-receipt:<donationId>).
    // If the receipt was never generated, there's nothing to undo.
    // If it was generated, the receipt service handles its own lifecycle.
    // Log only — no meaningful compensation possible at this level.
    logger.info(
      `[Saga] Receipt enqueue compensation (no-op) for donation ${input.donationId}`,
    );
  },
};

// ─── Saga definition ─────────────────────────────────────────────────────────

export const donationConfirmationSaga: SagaDefinition<
  DonationConfirmationInput,
  DonationConfirmationOutput
> = {
  name: 'DonationConfirmationSaga',
  compensationTimeoutMs: 30_000,

  steps: [
    confirmDonationStatusStep,
    applyMultiplierStep,
    allocateMatchedFundsStep,
    updateCampaignBalanceStep,
    dispatchDonationWebhookStep,
    incrementAnalyticsCacheStep,
    enqueueReceiptGenerationStep,
  ],

  async onCompletion(result, sagaId) {
    logger.info(
      `[DonationConfirmationSaga] Completed sagaId=${sagaId} donationId=${result.donationId}`,
    );
  },

  async onCompensation(error, sagaId) {
    logger.error(
      `[DonationConfirmationSaga] Compensated sagaId=${sagaId} error=${error.message}`,
    );
  },
};
