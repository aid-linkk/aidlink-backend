import prisma from '../config/database';
import { DonationInput, DonationFilters, PaginatedResponse } from '../types';
import { AuditAction, DonationStatus, Prisma, Role } from '@prisma/client';
import { MultiplierService } from './multiplier.service';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { config } from '../config';
import { dispatchWebhookEvent } from '../controllers/webhook.controller';
import { AnalyticsService } from './analytics.service';
import { sanitizeString } from '../utils/sanitization';
import { sanitizeAnonymousInput, sanitizeDonorIdentity } from '../utils/anonymity';
import { MatchedFundAllocationService } from './matchedFundAllocation.service';

export interface CreateConfirmedDonationInput {
  campaignId: string;
  userId?: string | null;
  amount: Prisma.Decimal.Value;
  currency?: string;
  blockchainTxHash: string;
  isAnonymous?: boolean;
  memo?: string;
  fromWallet?: string;
  toWallet?: string;
}

export class DonationService {
  /**
   * @notice Shared side-effect path for "a donation has just been confirmed":
   * multiplier evaluation, matched-fund allocation, and the campaign balance
   * update. Used by both confirmDonation (existing donation, PENDING ->
   * CONFIRMED) and createConfirmedDonation (new donation created directly as
   * CONFIRMED, e.g. from the pledge worker) so the two flows can never drift
   * apart. Must be called from within the caller's own transaction.
   */
  private static async applyConfirmationEffects(
    tx: Prisma.TransactionClient,
    params: { donationId: string; campaignId: string; donorAmount: Prisma.Decimal.Value },
  ) {
    const multiplier = await MultiplierService.evaluateMultiplierAtDonation(
      { campaignId: params.campaignId, donationTime: new Date(), milestoneId: null },
      tx,
    );

    const matchedFund = await MatchedFundAllocationService.allocate(tx, {
      donationId: params.donationId,
      campaignId: params.campaignId,
      donorAmount: params.donorAmount,
      multiplier,
    });

    await tx.campaign.update({
      where: { id: params.campaignId },
      data: {
        currentAmount: {
          increment: params.donorAmount,
        },
      },
    });

    return { multiplier, matchedFund };
  }

  /**
   * @notice Post-commit side effects shared by every donation-confirmation
   * path: webhook dispatch, analytics cache increment, and receipt
   * generation. Intentionally fire-and-forget (errors are logged, not
   * thrown) and intentionally called AFTER the DB transaction commits, since
   * none of these are safe or necessary to run inside it.
   */
  static dispatchPostConfirmationSideEffects(params: {
    donationId: string;
    campaignId: string;
    amount: Prisma.Decimal.Value;
    currency: string;
    txHash: string;
    isAnonymous: boolean;
    userId?: string | null;
  }): void {
    const { donationId, campaignId, amount, currency, txHash, isAnonymous, userId } = params;

    dispatchWebhookEvent('DONATION_CONFIRMED', {
      donationId,
      campaignId,
      amount,
      currency,
      blockchainTxHash: txHash,
      isAnonymous,
    }).catch((err) => logger.error('Webhook dispatch error (donation.confirmed):', err));

    AnalyticsService.incrementDonationStats(campaignId, Number(amount)).catch((err) =>
      logger.error('Analytics increment error (donation.confirmed):', err),
    );

    if (config.receipts.enabled && userId) {
      import('../workers/receipt.worker.js')
        .then(({ enqueueReceiptGeneration }) => enqueueReceiptGeneration(donationId))
        .catch((error) =>
          logger.error(`Failed to enqueue receipt generation for donation ${donationId}:`, error),
        );
    }
  }

  /**
   * @notice Atomically creates a Donation row already in CONFIRMED status
   * and runs the same matched-fund / campaign-balance effects as
   * confirmDonation. For flows (like the pledge worker) where there is no
   * pre-existing PENDING donation to transition — the charge has already
   * succeeded off-band, and this is the durable record of it. Must be
   * called from within the caller's own prisma.$transaction so it commits
   * atomically with whatever else the caller writes in the same tx (e.g. a
   * PledgeAttempt row).
   */
  static async createConfirmedDonation(
    tx: Prisma.TransactionClient,
    input: CreateConfirmedDonationInput,
  ) {
    const donation = await tx.donation.create({
      data: {
        campaignId: input.campaignId,
        userId: input.userId ?? undefined,
        amount: input.amount,
        currency: input.currency ?? 'XLM',
        status: DonationStatus.CONFIRMED,
        blockchainTxHash: input.blockchainTxHash,
        fromWallet: input.fromWallet,
        toWallet: input.toWallet,
        isAnonymous: input.isAnonymous ?? false,
        memo: input.memo,
      },
    });

    const { matchedFund } = await DonationService.applyConfirmationEffects(tx, {
      donationId: donation.id,
      campaignId: input.campaignId,
      donorAmount: donation.amount,
    });

    return { donation, matchedFund };
  }

  static async createDonation(data: DonationInput, userId?: string): Promise<any> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: data.campaignId },
    });

    if (!campaign) {
      throw AppError.from('CAMPAIGN_002');
    }

    if (campaign.status !== 'ACTIVE') {
      throw AppError.from('CAMPAIGN_003', 'Campaign is not active');
    }

    // Strip donor PII when anonymous to enforce GDPR data minimisation
    const sanitised = sanitizeAnonymousInput(data);

    const donation = await prisma.donation.create({
      data: {
        ...sanitised,
        donorMessage: sanitised.donorMessage ? sanitizeString(sanitised.donorMessage) : undefined,
        userId: data.isAnonymous ? undefined : userId,
        status: DonationStatus.PENDING,
      },
    });

    logger.info(`Donation created: ${donation.id} for campaign ${data.campaignId}`);

    return donation;
  }

  static async confirmDonation(id: string, txHash: string): Promise<any> {
    const donation = await prisma.donation.findUnique({
      where: { id },
      include: { campaign: true },
    });

    if (!donation) {
      throw AppError.from('DONATION_001');
    }

    if (donation.status === DonationStatus.CONFIRMED) {
      throw AppError.from('DONATION_002');
    }

    // IMPORTANT: multipliers must be applied at the time the payment is confirmed,
    // so the matched-funds ledger is auditable.
    const updated = await prisma.$transaction(async (tx) => {
      // Guard the state transition atomically: only one concurrent confirmation
      // for this donation can win the update. A competing confirmation (or a
      // retry of this same call) sees count === 0 and is rejected before any
      // matched-fund allocation or balance update happens.
      const confirmResult = await tx.donation.updateMany({
        where: { id, status: { not: DonationStatus.CONFIRMED } },
        data: {
          status: DonationStatus.CONFIRMED,
          blockchainTxHash: txHash,
        },
      });

      if (confirmResult.count === 0) {
        throw AppError.from('DONATION_002');
      }

      const updatedDonation = await tx.donation.findUniqueOrThrow({ where: { id } });

      // Multiplier evaluation + matched-fund allocation + campaign balance
      // update — shared with createConfirmedDonation (pledge worker) so the
      // two confirmation paths can never drift apart.
      const { matchedFund } = await DonationService.applyConfirmationEffects(tx, {
        donationId: updatedDonation.id,
        campaignId: donation.campaignId,
        donorAmount: updatedDonation.amount,
      });

      // Backwards-compatible response: top-level donation fields
      return {
        ...updatedDonation,
        matchedFund,
        multiplierApplied: matchedFund?.multiplierId ?? null,
      };
    });

    logger.info(`Donation confirmed: ${id} with tx ${txHash}`);

    DonationService.dispatchPostConfirmationSideEffects({
      donationId: id,
      campaignId: donation.campaignId,
      amount: updated.amount,
      currency: updated.currency,
      txHash,
      isAnonymous: donation.isAnonymous,
      userId: donation.userId,
    });

    return updated;
  }

  static async getDonations(
    filters: DonationFilters = {},
    pagination: any,
    requestingUserId?: string,
    requestingUserRole?: string,
  ): Promise<PaginatedResponse<any>> {
    filters = filters ?? {};

    const { page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = pagination;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (filters.campaignId) where.campaignId = filters.campaignId;
    if (filters.userId) where.userId = filters.userId;
    if (filters.status) where.status = filters.status;

    if (filters.startDate || filters.endDate) {
      where.createdAt = {};
      if (filters.startDate) where.createdAt.gte = filters.startDate;
      if (filters.endDate) where.createdAt.lte = filters.endDate;
    }

    const [rawDonations, total] = await Promise.all([
      prisma.donation.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          campaign: { select: { id: true, title: true } },
          user: { select: { id: true, username: true, email: true } },
        },
      }),
      prisma.donation.count({ where }),
    ]);

    const donations = rawDonations.map((d) =>
      sanitizeDonorIdentity(d, requestingUserId, requestingUserRole),
    );

    return {
      data: donations,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async getDonationById(
    id: string,
    requestingUserId?: string,
    requestingUserRole?: string,
  ): Promise<any> {
    const donation = await prisma.donation.findUnique({
      where: { id },
      include: {
        campaign: {
          select: {
            id: true,
            title: true,
            organization: { select: { name: true } },
          },
        },
        user: { select: { id: true, username: true, email: true } },
      },
    });

    if (!donation) {
      throw AppError.from('DONATION_001');
    }

    return sanitizeDonorIdentity(donation, requestingUserId, requestingUserRole);
  }

  /**
   * Allows a donor to optionally reveal their identity after donating.
   * Explicitly opt-in; logged to the audit trail.
   */
  static async revealIdentity(
    id: string,
    requestingUserId: string,
  ): Promise<any> {
    const donation = await prisma.donation.findUnique({ where: { id } });

    if (!donation) {
      throw AppError.from('DONATION_001');
    }

    if (donation.userId !== requestingUserId) {
      throw AppError.from('COMMON_001', 'You can only reveal identity for your own donations');
    }

    if (!donation.isAnonymous) {
      throw AppError.from('DONATION_003', 'Donation is already identified');
    }

    if (donation.revealedAt) {
      throw AppError.from('DONATION_003', 'Identity already revealed for this donation');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const updatedDonation = await tx.donation.update({
        where: { id },
        data: {
          isAnonymous: false,
          revealedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          userId: requestingUserId,
          action: AuditAction.DONATION_IDENTITY_REVEALED,
          entityType: 'Donation',
          entityId: id,
          metadata: { revealedAt: updatedDonation.revealedAt },
        },
      });

      return updatedDonation;
    });

    logger.info(`Donation identity revealed: ${id} by user ${requestingUserId}`);

    return updated;
  }

  static async refundDonation(id: string, userId: string, userRole: Role): Promise<any> {
    const donation = await prisma.donation.findUnique({
      where: { id },
      include: { campaign: true },
    });

    if (!donation) {
      throw AppError.from('DONATION_001');
    }

    if (donation.status !== DonationStatus.CONFIRMED) {
      throw AppError.from('DONATION_004', 'Only confirmed donations can be refunded');
    }

    if (donation.userId !== userId && userRole !== Role.ADMIN) {
      throw AppError.from('COMMON_001', 'You do not have permission to refund this donation');
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Re-read campaign balance inside transaction to prevent TOCTOU race condition
      const campaign = await tx.campaign.findUnique({
        where: { id: donation.campaignId },
        select: { currentAmount: true },
      });

      if (!campaign || Number(campaign.currentAmount) < Number(donation.amount)) {
        throw AppError.from('DONATION_004', 'Refund amount exceeds campaign current balance');
      }

      // Update donation status
      const updatedDonation = await tx.donation.update({
        where: { id },
        data: { status: DonationStatus.REFUNDED },
      });

      await tx.campaign.update({
        where: { id: donation.campaignId },
        data: { currentAmount: { decrement: donation.amount } },
      });

      return updatedDonation;
    });

    logger.info(`Donation refunded: ${id} by user ${userId}`);

    AnalyticsService.invalidateCampaignCache(donation.campaignId).catch((err) =>
      logger.error('Failed to invalidate campaign cache on refund', err),
    );

    return updated;
  }
}
