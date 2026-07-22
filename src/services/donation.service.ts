import prisma from '../config/database';
import { DonationInput, DonationFilters, PaginatedResponse } from '../types';
import { AuditAction, DonationStatus, Role } from '@prisma/client';
import { MultiplierService } from './multiplier.service';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { config } from '../config';
import { dispatchWebhookEvent } from '../controllers/webhook.controller';
import { AnalyticsService } from './analytics.service';
import { sanitizeString } from '../utils/sanitization';
import { sanitizeAnonymousInput, sanitizeDonorIdentity } from '../utils/anonymity';
import { MatchedFundAllocationService } from './matchedFundAllocation.service';

export class DonationService {
  static async createDonation(data: DonationInput, userId?: string): Promise<any> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: data.campaignId },
    });

    if (!campaign) {
      throw new AppError('Campaign not found', 404);
    }

    if (campaign.status !== 'ACTIVE') {
      throw new AppError('Campaign is not active', 400);
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
      throw new AppError('Donation not found', 404);
    }

    if (donation.status === DonationStatus.CONFIRMED) {
      throw new AppError('Donation already confirmed', 400);
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
        throw new AppError('Donation already confirmed', 400);
      }

      const updatedDonation = await tx.donation.findUniqueOrThrow({ where: { id } });

      // Multiplier evaluation reads through the same transaction so it sees a
      // consistent view of the multiplier set relative to the allocation below.
      const multiplier = await MultiplierService.evaluateMultiplierAtDonation(
        {
          campaignId: donation.campaignId,
          donationTime: new Date(),
          milestoneId: null,
        },
        tx,
      );

      const matchedFund = await MatchedFundAllocationService.allocate(tx, {
        donationId: updatedDonation.id,
        campaignId: donation.campaignId,
        donorAmount: updatedDonation.amount,
        multiplier,
      });

      // Update campaign current amount (donor-sourced only)
      await tx.campaign.update({
        where: { id: donation.campaignId },
        data: {
          currentAmount: {
            increment: donation.amount,
          },
        },
      });

      // Backwards-compatible response: top-level donation fields
      return {
        ...updatedDonation,
        matchedFund,
        multiplierApplied: matchedFund?.multiplierId ?? null,
      };
    });

    logger.info(`Donation confirmed: ${id} with tx ${txHash}`);

    dispatchWebhookEvent('DONATION_CONFIRMED', {
      donationId: id,
      campaignId: donation.campaignId,
      amount: updated.amount,
      currency: updated.currency,
      blockchainTxHash: txHash,
      isAnonymous: donation.isAnonymous,
    }).catch((err) => logger.error('Webhook dispatch error (donation.confirmed):', err));

    if (config.receipts.enabled && donation.userId) {
      import('../workers/receipt.worker.js')
        .then(({ enqueueReceiptGeneration }) => enqueueReceiptGeneration(id))
        .catch((error) =>
          logger.error(`Failed to enqueue receipt generation for donation ${id}:`, error),
        );
    }

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
      throw new AppError('Donation not found', 404);
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
      throw new AppError('Donation not found', 404);
    }

    if (donation.userId !== requestingUserId) {
      throw new AppError('You can only reveal identity for your own donations', 403);
    }

    if (!donation.isAnonymous) {
      throw new AppError('Donation is already identified', 400);
    }

    if (donation.revealedAt) {
      throw new AppError('Identity already revealed for this donation', 400);
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
      throw new AppError('Donation not found', 404);
    }

    if (donation.status !== DonationStatus.CONFIRMED) {
      throw new AppError('Only confirmed donations can be refunded', 400);
    }

    if (donation.userId !== userId && userRole !== Role.ADMIN) {
      throw new AppError('You do not have permission to refund this donation', 403);
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Re-read campaign balance inside transaction to prevent TOCTOU race condition
      const campaign = await tx.campaign.findUnique({
        where: { id: donation.campaignId },
        select: { currentAmount: true },
      });

      if (!campaign || Number(campaign.currentAmount) < Number(donation.amount)) {
        throw new AppError('Refund amount exceeds campaign current balance', 400);
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
