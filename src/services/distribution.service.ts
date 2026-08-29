import prisma from '../config/database';
import { DistributionInput, PaginatedResponse } from '../types';
import { DistributionStatus, Role } from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { dispatchWebhookEvent } from '../controllers/webhook.controller';
import { AnalyticsService } from './analytics.service';
import { CampaignAuditService } from './campaignAudit.service';
import { SagaOrchestrator } from '../saga/SagaOrchestrator';
import {
  distributionConfirmationSaga,
  DistributionConfirmationInput,
} from '../saga/sagas/distributionConfirmation.saga';

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
      throw AppError.from('CAMPAIGN_002');
    }

    const beneficiary = await prisma.beneficiary.findUnique({
      where: { id: data.beneficiaryId },
    });

    if (!beneficiary) {
      throw AppError.from('BENEFICIARY_001');
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
      throw AppError.from('DISTRIBUTION_002', 'Beneficiary is not assigned to this campaign');
    }

    // Check permissions
    if (campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw AppError.from('COMMON_001', 'You do not have permission to create distributions for this campaign');
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

    CampaignAuditService.log({
      campaignId: data.campaignId,
      action: 'DISTRIBUTION_CREATED',
      entityType: 'Distribution',
      entityId: distribution.id,
      actorId: userId,
      changes: {
        after: {
          beneficiaryId: distribution.beneficiaryId,
          amount: distribution.amount,
          currency: distribution.currency,
          method: distribution.method,
          status: distribution.status,
        },
      },
    });

    return distribution;
  }

  static async confirmDistribution(id: string, txHash: string, userId: string): Promise<any> {
    const distribution = await prisma.distribution.findUnique({
      where: { id },
      include: { campaign: true },
    });

    if (!distribution) {
      throw AppError.from('DISTRIBUTION_001');
    }

    if (distribution.status === DistributionStatus.COMPLETED) {
      throw AppError.from('DISTRIBUTION_002', 'Distribution already completed');
    }

    const sagaInput: DistributionConfirmationInput = {
      distributionId: id,
      txHash,
      userId,
    };

    // Transactional steps (status + campaign balance) run inside a single transaction.
    const result = await prisma.$transaction(async (tx) => {
      return SagaOrchestrator.execute(distributionConfirmationSaga, sagaInput, tx);
    });

    if (!result.success) {
      throw result.error;
    }

    logger.info(
      `Distribution confirmed via saga: ${id} with tx ${txHash} sagaId=${result.sagaId}`,
    );

    // Emit the campaign audit log (unchanged behaviour)
    const updated = await prisma.distribution.findUniqueOrThrow({ where: { id } });

    CampaignAuditService.log({
      campaignId: distribution.campaignId,
      action: 'DISTRIBUTION_CONFIRMED',
      entityType: 'Distribution',
      entityId: id,
      actorId: userId,
      changes: {
        diff: {
          status: { old: distribution.status, new: DistributionStatus.COMPLETED },
          blockchainTxHash: { old: distribution.blockchainTxHash, new: txHash },
        },
        after: {
          status: DistributionStatus.COMPLETED,
          blockchainTxHash: txHash,
          distributedAt: updated.distributedAt,
          distributedBy: userId,
          amount: updated.amount,
          currency: updated.currency,
          beneficiaryId: distribution.beneficiaryId,
        },
      },
    });

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
      throw AppError.from('DISTRIBUTION_001');
    }

    // Check permissions
    if (distribution.campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw AppError.from('COMMON_001', 'You do not have permission to update this distribution');
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
      throw AppError.from('DISTRIBUTION_001');
    }

    // Check permissions
    if (distribution.campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw AppError.from('COMMON_001', 'You do not have permission to update this distribution');
    }

    const updated = await prisma.distribution.update({
      where: { id },
      data: { proofDocumentUrl },
    });

    logger.info(`Proof document added to distribution: ${id}`);

    return updated;
  }
}
