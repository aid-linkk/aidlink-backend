/**
 * Distribution Confirmation Saga
 *
 * Steps (in order):
 *  1. confirmDistributionStatus  — PENDING/IN_PROGRESS → COMPLETED (transactional)
 *  2. decrementCampaignBalance   — subtract distribution.amount from campaign.currentAmount (transactional)
 *  3. dispatchDistributionWebhook — fire DISTRIBUTION_COMPLETED event (async)
 *  4. invalidateAnalyticsCache   — bust campaign analytics cache (async, no compensation needed)
 *
 * Compensation order (reverse):
 *  3 ← dispatch DISTRIBUTION_CANCELLED webhook
 *  2 ← increment campaign.currentAmount back
 *  1 ← revert distribution status to PENDING
 */

import { DistributionStatus, Prisma } from '@prisma/client';
import prisma from '../../config/database';
import logger from '../../config/logger';
import { SagaDefinition } from '../types';
import { AnalyticsService } from '../../services/analytics.service';
import { dispatchWebhookEvent } from '../../controllers/webhook.controller';
import { AppError } from '../../middleware/error';

// ─── Input / Output types ────────────────────────────────────────────────────

export interface DistributionConfirmationInput {
  distributionId: string;
  txHash: string;
  userId: string; // the user who confirmed the distribution
}

interface Step1Output {
  distributionId: string;
  campaignId: string;
  beneficiaryId: string;
  amount: Prisma.Decimal;
  currency: string;
  txHash: string;
  prevStatus: DistributionStatus;
}

interface Step2Output extends Step1Output {
  campaignUpdated: boolean;
}

export type DistributionConfirmationOutput = Step2Output;

// ─── Step definitions ────────────────────────────────────────────────────────

const confirmDistributionStatusStep = {
  name: 'confirmDistributionStatus',
  isTransactional: true,
  isAsync: false,

  async execute(
    input: DistributionConfirmationInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Step1Output> {
    const client = tx ?? prisma;

    const dist = await client.distribution.findUnique({
      where: { id: input.distributionId },
    });

    if (!dist) {
      throw AppError.from('DISTRIBUTION_001');
    }

    if (dist.status === DistributionStatus.COMPLETED) {
      // Idempotent: already completed — pass through
      return {
        distributionId: dist.id,
        campaignId: dist.campaignId,
        beneficiaryId: dist.beneficiaryId,
        amount: dist.amount,
        currency: dist.currency,
        txHash: input.txHash,
        prevStatus: dist.status,
      };
    }

    const updated = await client.distribution.update({
      where: { id: input.distributionId },
      data: {
        status: DistributionStatus.COMPLETED,
        blockchainTxHash: input.txHash,
        distributedAt: new Date(),
        distributedBy: input.userId,
      },
    });

    return {
      distributionId: updated.id,
      campaignId: updated.campaignId,
      beneficiaryId: updated.beneficiaryId,
      amount: updated.amount,
      currency: updated.currency,
      txHash: input.txHash,
      prevStatus: dist.status,
    };
  },

  async compensate(output: Step1Output): Promise<void> {
    if (output.prevStatus === DistributionStatus.COMPLETED) {
      // Was already completed before the saga — don't revert
      return;
    }
    await prisma.distribution.updateMany({
      where: { id: output.distributionId, status: DistributionStatus.COMPLETED },
      data: {
        status: output.prevStatus,
        blockchainTxHash: null,
        distributedAt: null,
        distributedBy: null,
      },
    });
    logger.info(
      `[Saga] Compensated confirmDistributionStatus for distribution ${output.distributionId}`,
    );
  },
};

const decrementCampaignBalanceStep = {
  name: 'decrementCampaignBalance',
  isTransactional: true,
  isAsync: false,

  async execute(
    input: Step1Output,
    tx?: Prisma.TransactionClient,
  ): Promise<Step2Output> {
    if (input.prevStatus === DistributionStatus.COMPLETED) {
      // Already completed before saga — don't double-decrement
      return { ...input, campaignUpdated: false };
    }
    const client = tx ?? prisma;
    await client.campaign.update({
      where: { id: input.campaignId },
      data: { currentAmount: { decrement: input.amount } },
    });
    return { ...input, campaignUpdated: true };
  },

  async compensate(output: Step2Output): Promise<void> {
    if (!output.campaignUpdated) return;
    await prisma.campaign.update({
      where: { id: output.campaignId },
      data: { currentAmount: { increment: output.amount } },
    });
    logger.info(
      `[Saga] Compensated decrementCampaignBalance: restored campaign ${output.campaignId} by ${output.amount}`,
    );
  },
};

const dispatchDistributionWebhookStep = {
  name: 'dispatchDistributionWebhook',
  isTransactional: false,
  isAsync: true,

  async execute(input: Step2Output): Promise<void> {
    await dispatchWebhookEvent('DISTRIBUTION_COMPLETED', {
      distributionId: input.distributionId,
      campaignId: input.campaignId,
      beneficiaryId: input.beneficiaryId,
      amount: input.amount,
      currency: input.currency,
      blockchainTxHash: input.txHash,
    });
  },

  async compensate(output: void, input: Step2Output): Promise<void> {
    await dispatchWebhookEvent('DISTRIBUTION_COMPLETED', {
      distributionId: input.distributionId,
      campaignId: input.campaignId,
      beneficiaryId: input.beneficiaryId,
      amount: input.amount,
      currency: input.currency,
      blockchainTxHash: input.txHash,
      _compensated: true,
    } as any).catch((err) =>
      logger.error('[Saga] Failed to dispatch distribution compensation webhook:', err),
    );
  },
};

const invalidateAnalyticsCacheStep = {
  name: 'invalidateAnalyticsCache',
  isTransactional: false,
  isAsync: true,

  async execute(input: Step2Output): Promise<void> {
    await AnalyticsService.invalidateCampaignCache(input.campaignId);
  },

  // Cache invalidation is idempotent and has no durable side effects.
  // No compensation needed.
};

// ─── Saga definition ─────────────────────────────────────────────────────────

export const distributionConfirmationSaga: SagaDefinition<
  DistributionConfirmationInput,
  DistributionConfirmationOutput
> = {
  name: 'DistributionConfirmationSaga',
  compensationTimeoutMs: 30_000,

  steps: [
    confirmDistributionStatusStep,
    decrementCampaignBalanceStep,
    dispatchDistributionWebhookStep,
    invalidateAnalyticsCacheStep,
  ],

  async onCompletion(result, sagaId) {
    logger.info(
      `[DistributionConfirmationSaga] Completed sagaId=${sagaId} distributionId=${result.distributionId}`,
    );
  },

  async onCompensation(error, sagaId) {
    logger.error(
      `[DistributionConfirmationSaga] Compensated sagaId=${sagaId} error=${error.message}`,
    );
  },
};
