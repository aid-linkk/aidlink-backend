import prisma from '../config/database';
import { DistributionInput, PaginatedResponse } from '../types';
import { DistributionStatus, Role } from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { dispatchWebhookEvent } from '../controllers/webhook.controller';
import { AnalyticsService } from './analytics.service';

export class DistributionService {
  static async createDistribution(
    data: DistributionInput,
    userId: string,
    userRole: Role
  ): Promise<any> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: data.campaignId },
    });

    if (!campaign) {
      throw new AppError('Campaign not found', 404);
    }

    const beneficiary = await prisma.beneficiary.findUnique({
      where: { id: data.beneficiaryId },
    });

    if (!beneficiary) {
      throw new AppError('Beneficiary not found', 404);
    }

    // Check if beneficiary is assigned to campaign
    const assignment = await prisma.beneficiaryAssignment.findUnique({
      where: {
        campaignId_beneficiaryId: {
          campaignId: data.campaignId,
          beneficiaryId: data.beneficiaryId,
        },
      },
    });

    if (!assignment) {
      throw new AppError('Beneficiary is not assigned to this campaign', 400);
    }

    // Check permissions
    if (campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw new AppError(
        'You do not have permission to create distributions for this campaign',
        403
      );
    }

    const distribution = await prisma.$transaction(async (tx) => {
      return tx.distribution.create({
        data: {
          ...data,
          status: DistributionStatus.PENDING,
        },
      });
    });

    logger.info(`Distribution created: ${distribution.id} for campaign ${data.campaignId}`);

    return distribution;
  }

  static async confirmDistribution(id: string, txHash: string, userId: string): Promise<any> {
    const distribution = await prisma.distribution.findUnique({
      where: { id },
      include: { campaign: true },
    });

    if (!distribution) {
      throw new AppError('Distribution not found', 404);
    }

    if (distribution.status === DistributionStatus.COMPLETED) {
      throw new AppError('Distribution already completed', 400);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const dist = await tx.distribution.update({
        where: { id },
        data: {
          status: DistributionStatus.COMPLETED,
          blockchainTxHash: txHash,
          distributedAt: new Date(),
          distributedBy: userId,
        },
      });

      // Decrement campaign currentAmount to reflect distributed funds
      await tx.campaign.update({
        where: { id: distribution.campaignId },
        data: {
          currentAmount: {
            decrement: distribution.amount,
          },
        },
      });

      return dist;
    });

    logger.info(`Distribution confirmed: ${id} with tx ${txHash}`);

    dispatchWebhookEvent('DISTRIBUTION_COMPLETED', {
      distributionId: id,
      campaignId: distribution.campaignId,
      beneficiaryId: distribution.beneficiaryId,
      amount: updated.amount,
      currency: updated.currency,
      blockchainTxHash: txHash,
    }).catch((err) => logger.error('Webhook dispatch error (distribution.completed):', err));

    return updated;
  }

  static async getDistributions(
    campaignId?: string,
    beneficiaryId?: string,
    pagination?: any
  ): Promise<PaginatedResponse<any>> {
    const { page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = pagination || {};
    const skip = (page - 1) * limit;

    const where: any = {};

    if (campaignId) {
      where.campaignId = campaignId;
    }

    if (beneficiaryId) {
      where.beneficiaryId = beneficiaryId;
    }

    const [distributions, total] = await Promise.all([
      prisma.distribution.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          campaign: {
            select: {
              id: true,
              title: true,
            },
          },
          beneficiary: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              country: true,
            },
          },
        },
      }),
      prisma.distribution.count({ where }),
    ]);

    return {
      data: distributions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async updateDistributionStatus(
    id: string,
    status: DistributionStatus,
    userId: string,
    userRole: Role
  ): Promise<any> {
    const distribution = await prisma.distribution.findUnique({
      where: { id },
      include: { campaign: true },
    });

    if (!distribution) {
      throw new AppError('Distribution not found', 404);
    }

    // Check permissions
    if (distribution.campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw new AppError('You do not have permission to update this distribution', 403);
    }

    const updated = await prisma.$transaction(async (tx) => {
      return tx.distribution.update({
        where: { id },
        data: {
          status,
          ...(status === DistributionStatus.IN_PROGRESS && { distributedBy: userId }),
          ...(status === DistributionStatus.COMPLETED && { distributedAt: new Date() }),
        },
      });
    });

    logger.info(`Distribution status updated: ${id} to ${status} by user ${userId}`);

    // Invalidate cache when distribution status changes
    AnalyticsService.invalidateCampaignCache(distribution.campaignId).catch((err) =>
      logger.error('Failed to invalidate campaign cache on status update', err)
    );

    return updated;
  }

  static async addProofDocument(
    id: string,
    proofDocumentUrl: string,
    userId: string,
    userRole: Role
  ): Promise<any> {
    const distribution = await prisma.distribution.findUnique({
      where: { id },
      include: { campaign: true },
    });

    if (!distribution) {
      throw new AppError('Distribution not found', 404);
    }

    // Check permissions
    if (distribution.campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw new AppError('You do not have permission to update this distribution', 403);
    }

    const updated = await prisma.distribution.update({
      where: { id },
      data: { proofDocumentUrl },
    });

    logger.info(`Proof document added to distribution: ${id}`);

    return updated;
  }
}
