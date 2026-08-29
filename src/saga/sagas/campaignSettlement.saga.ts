/**
 * Campaign Settlement Saga (REFUND_TO_DONOR path)
 *
 * Handles the REFUND_TO_DONOR settlement option for a cancelled campaign:
 *
 * Steps (in order):
 *  1. refundDonations         — mark each confirmed donation as REFUNDED (transactional)
 *  2. decrementCampaignBalance — zero out campaign.currentAmount (transactional)
 *  3. createDonorNotifications — notify each donor of their refund (async)
 *  4. updateRecoveryCase      — mark recovery case as RECOVERED (transactional)
 *
 * Compensation order (reverse):
 *  3 ← delete the notifications we created
 *  2 ← restore campaign.currentAmount from persisted snapshot
 *  1 ← revert donation statuses back to CONFIRMED
 *
 * The TRANSFER_TO_CAMPAIGN and RETAIN_IN_ESCROW paths remain synchronous
 * (no long-running loop) so they don't need saga wrapping.  Only REFUND_TO_DONOR
 * is wrapped because it may process a large number of donations.
 */

import { DonationStatus, NotificationType, RecoveryStatus, SettlementOption } from '@prisma/client';
import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import logger from '../../config/logger';
import { SagaDefinition } from '../types';
import { AppError } from '../../middleware/error';

// ─── Input / Output types ────────────────────────────────────────────────────

export interface CampaignSettlementInput {
  recoveryCaseId: string;
  campaignId: string;
  adminId: string;
  notes?: string;
  settlementOption: SettlementOption;
}

interface RefundedDonation {
  donationId: string;
  amount: Prisma.Decimal;
  currency: string;
  userId: string | null;
}

interface Step1Output extends CampaignSettlementInput {
  campaignTitle: string;
  refundedDonations: RefundedDonation[];
  totalRefunded: Prisma.Decimal;
}

interface Step2Output extends Step1Output {
  previousCampaignAmount: Prisma.Decimal;
}

interface Step3Output extends Step2Output {
  createdNotificationIds: string[];
}

export type CampaignSettlementOutput = Step3Output;

// ─── Step definitions ────────────────────────────────────────────────────────

const refundDonationsStep = {
  name: 'refundDonations',
  isTransactional: true,
  isAsync: false,

  async execute(
    input: CampaignSettlementInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Step1Output> {
    const client = tx ?? prisma;

    const campaign = await client.campaign.findUnique({
      where: { id: input.campaignId },
      include: {
        donations: { where: { status: DonationStatus.CONFIRMED } },
      },
    });

    if (!campaign) {
      throw AppError.from('CAMPAIGN_002');
    }

    const refundedDonations: RefundedDonation[] = [];

    // Update all confirmed donations to REFUNDED in one batch for efficiency
    if (campaign.donations.length > 0) {
      await client.donation.updateMany({
        where: {
          campaignId: input.campaignId,
          status: DonationStatus.CONFIRMED,
        },
        data: { status: DonationStatus.REFUNDED },
      });

      for (const d of campaign.donations) {
        refundedDonations.push({
          donationId: d.id,
          amount: d.amount,
          currency: d.currency,
          userId: d.userId,
        });
      }
    }

    const totalRefunded = refundedDonations.reduce(
      (sum, d) => sum.add(d.amount),
      new Prisma.Decimal(0),
    );

    return {
      ...input,
      campaignTitle: campaign.title,
      refundedDonations,
      totalRefunded,
    };
  },

  async compensate(output: Step1Output): Promise<void> {
    if (output.refundedDonations.length === 0) return;

    // Revert REFUNDED → CONFIRMED for all donations we processed
    await prisma.donation.updateMany({
      where: {
        id: { in: output.refundedDonations.map((d) => d.donationId) },
        status: DonationStatus.REFUNDED,
      },
      data: { status: DonationStatus.CONFIRMED },
    });

    logger.info(
      `[Saga] Compensated refundDonations: reverted ${output.refundedDonations.length} donations back to CONFIRMED`,
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
    const client = tx ?? prisma;

    // Snapshot current amount for compensation
    const campaign = await client.campaign.findUniqueOrThrow({
      where: { id: input.campaignId },
      select: { currentAmount: true },
    });

    const previousCampaignAmount = campaign.currentAmount;

    // Decrement for each refunded donation individually to maintain audit trail
    for (const donation of input.refundedDonations) {
      await client.campaign.update({
        where: { id: input.campaignId },
        data: { currentAmount: { decrement: donation.amount } },
      });
    }

    return { ...input, previousCampaignAmount };
  },

  async compensate(output: Step2Output): Promise<void> {
    // Restore the exact snapshotted balance
    await prisma.campaign.update({
      where: { id: output.campaignId },
      data: { currentAmount: output.previousCampaignAmount },
    });
    logger.info(
      `[Saga] Compensated decrementCampaignBalance: restored campaign ${output.campaignId} to ${output.previousCampaignAmount}`,
    );
  },
};

const createDonorNotificationsStep = {
  name: 'createDonorNotifications',
  isTransactional: false,
  isAsync: true,

  async execute(input: Step2Output): Promise<string[]> {
    const notificationIds: string[] = [];

    for (const donation of input.refundedDonations) {
      if (!donation.userId) continue;

      const notification = await prisma.notification.create({
        data: {
          userId: donation.userId,
          type: NotificationType.CAMPAIGN_SETTLEMENT,
          title: 'Campaign Cancelled – Refund Issued',
          message: `Campaign "${input.campaignTitle}" was cancelled. Your donation of ${donation.amount} ${donation.currency} has been refunded.`,
          metadata: {
            recoveryCaseId: input.recoveryCaseId,
            campaignId: input.campaignId,
          },
          sentVia: [],
        },
      });

      notificationIds.push(notification.id);
    }

    return notificationIds;
  },

  async compensate(output: string[]): Promise<void> {
    if (!output || output.length === 0) return;

    // Delete the notifications we created
    await prisma.notification.deleteMany({
      where: { id: { in: output } },
    });

    logger.info(
      `[Saga] Compensated createDonorNotifications: deleted ${output.length} notifications`,
    );
  },
};

const updateRecoveryCaseStep = {
  name: 'updateRecoveryCase',
  isTransactional: true,
  isAsync: false,

  async execute(
    input: Step2Output,
    tx?: Prisma.TransactionClient,
  ): Promise<Step3Output> {
    const client = tx ?? prisma;

    await client.recoveryCase.update({
      where: { id: input.recoveryCaseId },
      data: {
        status: RecoveryStatus.RECOVERED,
        settlementOption: input.settlementOption,
        settlementNotes: input.notes,
        settledAt: new Date(),
        settledBy: input.adminId,
        resolvedAt: new Date(),
      },
    });

    // The createDonorNotifications step is async so its output isn't wired here.
    // Return an empty array; the real notification IDs are tracked in the step's
    // own SagaStepExecution row and used for compensation if needed.
    return { ...(input as Step3Output), createdNotificationIds: [] };
  },

  async compensate(output: Step3Output): Promise<void> {
    // Revert the recovery case back to RECOVERY_REQUIRED so it can be retried
    await prisma.recoveryCase.update({
      where: { id: output.recoveryCaseId },
      data: {
        status: RecoveryStatus.RECOVERY_REQUIRED,
        settlementOption: null,
        settlementNotes: null,
        settledAt: null,
        settledBy: null,
        resolvedAt: null,
      },
    });
    logger.info(
      `[Saga] Compensated updateRecoveryCase: reverted case ${output.recoveryCaseId} to RECOVERY_REQUIRED`,
    );
  },
};

// ─── Saga definition ─────────────────────────────────────────────────────────

export const campaignSettlementSaga: SagaDefinition<
  CampaignSettlementInput,
  CampaignSettlementOutput
> = {
  name: 'CampaignSettlementSaga',
  compensationTimeoutMs: 60_000, // longer timeout — may process many donations

  steps: [
    refundDonationsStep,
    decrementCampaignBalanceStep,
    createDonorNotificationsStep,
    updateRecoveryCaseStep,
  ],

  async onCompletion(result, sagaId) {
    logger.info(
      `[CampaignSettlementSaga] Completed sagaId=${sagaId} caseId=${result.recoveryCaseId} refunded=${result.refundedDonations.length} donations`,
    );
  },

  async onCompensation(error, sagaId) {
    logger.error(
      `[CampaignSettlementSaga] Compensated sagaId=${sagaId} error=${error.message}`,
    );
  },
};
