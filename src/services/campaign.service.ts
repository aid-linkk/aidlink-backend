import prisma from '../config/database';
import { CampaignInput, CampaignFilters, PaginatedResponse } from '../types';
import { CampaignStatus, Role } from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { ModerationService } from './moderation.service';
import { CampaignDuplicateService, DuplicateMatch as CampaignDuplicateMatch } from './campaignDuplicate.service';
import { dispatchWebhookEvent } from '../controllers/webhook.controller';
import { getOrSet, invalidateCampaignCache, invalidateSearchCache } from '../utils/cache';
import { sanitizeString } from '../utils/sanitization';
import { CampaignAuditService, diffObjects } from './campaignAudit.service';

export class CampaignService {
  static async createCampaign(data: CampaignInput, userId: string, organizationId: string): Promise<any> {
    // Verify organization exists and belongs to user
    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!organization) {
      throw AppError.from('ORG_001');
    }

    if (organization.userId !== userId) {
      throw AppError.from('COMMON_001', 'You do not have permission to create campaigns for this organization');
    }

    // Check for likely duplicates before creating. Non-blocking: a failure
    // here should never prevent campaign creation.
    let duplicates = { hasPotentialDuplicates: false, matches: [] as CampaignDuplicateMatch[] };
    try {
      duplicates = await CampaignDuplicateService.detectDuplicates(
        { title: data.title, targetAmount: data.targetAmount },
        organizationId,
        organization.country
      );
    } catch (err) {
      logger.error('Duplicate detection failed during campaign creation:', err);
    }

    const campaign = await prisma.campaign.create({
      data: {
        ...data,
        title: sanitizeString(data.title),
        description: sanitizeString(data.description),
        userId,
        organizationId,
        status: CampaignStatus.DRAFT,
      },
    });

    logger.info(`Campaign created: ${campaign.id} by user ${userId}`);

    CampaignAuditService.log({
      campaignId: campaign.id,
      action: 'CAMPAIGN_CREATED',
      entityType: 'Campaign',
      entityId: campaign.id,
      actorId: userId,
      changes: {
        after: {
          title: campaign.title,
          description: campaign.description,
          targetAmount: campaign.targetAmount,
          startDate: campaign.startDate,
          endDate: campaign.endDate,
          status: campaign.status,
          organizationId: campaign.organizationId,
        },
      },
    });

    if (duplicates.hasPotentialDuplicates) {
      logger.info(
        `Potential duplicate campaigns detected for ${campaign.id}: ${duplicates.matches.map((m) => m.campaignId).join(', ')}`
      );
    }

    return {
      ...campaign,
      ...(duplicates.hasPotentialDuplicates ? { duplicateWarning: duplicates } : {}),
    };
  }

  static async getCampaigns(filters: CampaignFilters, pagination: any): Promise<PaginatedResponse<any>> {
    const { page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = pagination;

    // Build cache key from filters + pagination
    const cacheKey = buildKey('campaigns', `list:${JSON.stringify({ filters, page, limit, sortBy, sortOrder })}`);

    return getOrSet(cacheKey, 300, async () => {
      const skip = (page - 1) * limit;

      const where: any = {};

      if (filters.status) {
        where.status = filters.status;
      }

      if (filters.organizationId) {
        where.organizationId = filters.organizationId;
      }

      if (filters.startDate) {
        where.startDate = { gte: filters.startDate };
      }

      if (filters.endDate) {
        where.endDate = { lte: filters.endDate };
      }

      if (filters.search) {
        where.OR = [
          { title: { contains: filters.search, mode: 'insensitive' } },
          { description: { contains: filters.search, mode: 'insensitive' } },
        ];
      }

      const [campaigns, total] = await Promise.all([
        prisma.campaign.findMany({
          where,
          skip,
          take: limit,
          orderBy: { [sortBy]: sortOrder },
          include: {
            organization: {
              select: {
                id: true,
                name: true,
                logo: true,
              },
            },
            _count: {
              select: {
                donations: true,
                beneficiaries: true,
              },
            },
          },
        }),
        prisma.campaign.count({ where }),
      ]);

      return {
        data: campaigns,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    });
  }

  static async getCampaignById(id: string): Promise<any> {
    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            description: true,
            logo: true,
            website: true,
          },
        },
        donations: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: {
            user: {
              select: {
                id: true,
                username: true,
              },
            },
          },
        },
        beneficiaries: {
          include: {
            beneficiary: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                country: true,
              },
            },
          },
        },
        milestones: {
          orderBy: { order: 'asc' },
          include: {
            submissions: {
              where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED'] } },
              orderBy: { createdAt: 'desc' },
              take: 1,
              include: {
                reviews: { orderBy: { createdAt: 'desc' }, take: 1 },
              },
            },
          },
        },
      },
    });

    if (!campaign) {
      throw AppError.from('CAMPAIGN_002');
    }

    // Anonymize anonymous donations in the campaign feed
    const sanitizedDonations = campaign.donations.map((d) =>
      d.isAnonymous ? { ...d, user: { id: null, username: 'Anonymous' } } : d
    );

    // Attach moderation context: current suspension summary and whether the
    // owner can submit an appeal.
    const { suspensionSummary, canAppeal } = await ModerationService.getModerationView(campaign);

    return { ...campaign, donations: sanitizedDonations, suspensionSummary, canAppeal };
  }

  /**
   * Validates campaign input fields for update operations.
   * Enforces business rules for title, description, targetAmount, dates, and imageUrl.
   */
  private static validateCampaignUpdateInput(data: Partial<CampaignInput>): void {
    if (data.title !== undefined) {
      if (typeof data.title !== 'string' || data.title.trim().length < 3) {
        throw AppError.from('CAMPAIGN_001', 'Title must be at least 3 characters long');
      }
      if (data.title.trim().length > 200) {
        throw AppError.from('CAMPAIGN_001', 'Title must not exceed 200 characters');
      }
    }

    if (data.description !== undefined) {
      if (typeof data.description !== 'string' || data.description.trim().length < 10) {
        throw AppError.from('CAMPAIGN_001', 'Description must be at least 10 characters long');
      }
      if (data.description.trim().length > 5000) {
        throw AppError.from('CAMPAIGN_001', 'Description must not exceed 5000 characters');
      }
    }

    if (data.targetAmount !== undefined) {
      if (typeof data.targetAmount !== 'number' || data.targetAmount <= 0) {
        throw AppError.from('CAMPAIGN_001', 'Target amount must be a positive number');
      }
    }

    if (data.startDate !== undefined) {
      const startDate = new Date(data.startDate);
      if (isNaN(startDate.getTime())) {
        throw AppError.from('CAMPAIGN_001', 'Start date must be a valid date');
      }
    }

    if (data.endDate !== undefined && data.endDate !== null) {
      const endDate = new Date(data.endDate);
      if (isNaN(endDate.getTime())) {
        throw AppError.from('CAMPAIGN_001', 'End date must be a valid date');
      }
      // Validate endDate is after startDate if both are provided
      if (data.startDate !== undefined) {
        const startDate = new Date(data.startDate);
        if (endDate <= startDate) {
          throw AppError.from('CAMPAIGN_001', 'End date must be after start date');
        }
      }
    }

    if (data.imageUrl !== undefined && data.imageUrl !== null && data.imageUrl !== '') {
      try {
        new URL(data.imageUrl);
      } catch {
        throw AppError.from('CAMPAIGN_001', 'Image URL must be a valid URL');
      }
    }
  }

  static async updateCampaign(id: string, data: Partial<CampaignInput>, userId: string, userRole: Role): Promise<any> {
    const campaign = await prisma.campaign.findUnique({
      where: { id },
    });

    if (!campaign) {
      throw AppError.from('CAMPAIGN_002');
    }

    // Check permissions
    if (campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw AppError.from('COMMON_001', 'You do not have permission to update this campaign');
    }

    // Prevent updating if campaign is completed or cancelled
    if (campaign.status === CampaignStatus.COMPLETED || campaign.status === CampaignStatus.CANCELLED) {
      throw AppError.from('CAMPAIGN_003', 'Cannot update a completed or cancelled campaign');
    }

    // Validate input fields
    CampaignService.validateCampaignUpdateInput(data);

    // If endDate is provided without startDate, validate against existing startDate
    if (data.endDate !== undefined && data.endDate !== null && data.startDate === undefined) {
      const endDate = new Date(data.endDate);
      if (endDate <= campaign.startDate) {
        throw AppError.from('CAMPAIGN_001', 'End date must be after start date');
      }
    }

    const sanitizedData = {
      ...data,
      ...(data.title !== undefined ? { title: sanitizeString(data.title) } : {}),
      ...(data.description !== undefined ? { description: sanitizeString(data.description) } : {}),
    };

    const updated = await prisma.campaign.update({
      where: { id },
      data: sanitizedData,
    });

    logger.info(`Campaign updated: ${id} by user ${userId}`);

    // Compute field-level diff for the audit entry
    const before: Record<string, unknown> = {
      title: campaign.title,
      description: campaign.description,
      targetAmount: campaign.targetAmount,
      imageUrl: campaign.imageUrl,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
    };
    const after: Record<string, unknown> = {
      title: updated.title,
      description: updated.description,
      targetAmount: updated.targetAmount,
      imageUrl: updated.imageUrl,
      startDate: updated.startDate,
      endDate: updated.endDate,
    };
    CampaignAuditService.log({
      campaignId: id,
      action: 'CAMPAIGN_UPDATED',
      entityType: 'Campaign',
      entityId: id,
      actorId: userId,
      changes: { diff: diffObjects(before, after), before, after },
    });

    // Invalidate campaign listing caches
    await invalidateCampaignCache(id);

    return updated;
  }

  static async deleteCampaign(id: string, userId: string, userRole: Role): Promise<void> {
    const campaign = await prisma.campaign.findUnique({
      where: { id },
    });

    if (!campaign) {
      throw AppError.from('CAMPAIGN_002');
    }

    // Check permissions
    if (campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw AppError.from('COMMON_001', 'You do not have permission to delete this campaign');
    }

    // Only allow deletion of draft campaigns
    if (campaign.status !== CampaignStatus.DRAFT) {
      throw AppError.from('CAMPAIGN_003', 'Can only delete draft campaigns');
    }

    // Delete campaign and dependent records transactionally
    await prisma.$transaction(async (tx) => {
      await tx.milestone.deleteMany({ where: { campaignId: id } });
      await tx.beneficiaryAssignment.deleteMany({ where: { campaignId: id } });
      await tx.distribution.deleteMany({ where: { campaignId: id } });
      await tx.donation.deleteMany({ where: { campaignId: id } });
      await tx.campaign.delete({ where: { id } });
    });

    // Invalidate campaign caches
    await invalidateCampaignCache(id);
    await invalidateSearchCache();

    CampaignAuditService.log({
      campaignId: id,
      action: 'CAMPAIGN_DELETED',
      entityType: 'Campaign',
      entityId: id,
      actorId: userId,
      changes: {
        before: {
          title: campaign.title,
          status: campaign.status,
          targetAmount: campaign.targetAmount,
        },
      },
    });

    logger.info(`Campaign deleted: ${id} by user ${userId}`);
  }

  static async updateCampaignStatus(id: string, status: CampaignStatus, userId: string, userRole: Role): Promise<any> {
    const campaign = await prisma.campaign.findUnique({
      where: { id },
    });

    if (!campaign) {
      throw AppError.from('CAMPAIGN_002');
    }

    // Check permissions
    if (campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw AppError.from('COMMON_001', 'You do not have permission to update this campaign status');
    }

    // Suspension/reinstatement must go through the moderation workflow so that
    // a suspension record and audit trail are always created. This prevents an
    // owner from self-reinstating a suspended campaign via this endpoint.
    if (status === CampaignStatus.SUSPENDED) {
      throw AppError.from('CAMPAIGN_003', 'Use the moderation endpoint to suspend a campaign');
    }
    if (campaign.status === CampaignStatus.SUSPENDED) {
      throw AppError.from('CAMPAIGN_003', 'Suspended campaigns can only be reinstated by an admin or via an approved appeal');
    }

    const updated = await prisma.campaign.update({
      where: { id },
      data: { status },
    });

    logger.info(`Campaign status updated: ${id} to ${status} by user ${userId}`);

    CampaignAuditService.log({
      campaignId: id,
      action: 'CAMPAIGN_STATUS_CHANGED',
      entityType: 'Campaign',
      entityId: id,
      actorId: userId,
      changes: {
        diff: { status: { old: campaign.status, new: status } },
      },
    });

    // Invalidate campaign caches
    await invalidateCampaignCache(id);

    return updated;
  }

  /**
   * Validates milestone input fields.
   * Enforces presence of title/description and valid numeric constraints.
   */
  private static validateMilestoneInput(data: any): void {
    if (!data.title || typeof data.title !== 'string' || data.title.trim().length === 0) {
      throw AppError.from('CAMPAIGN_001', 'Milestone title is required');
    }

    if (!data.description || typeof data.description !== 'string' || data.description.trim().length === 0) {
      throw AppError.from('CAMPAIGN_001', 'Milestone description is required');
    }

    if (data.targetAmount === undefined || data.targetAmount === null || typeof data.targetAmount !== 'number' || data.targetAmount <= 0) {
      throw AppError.from('CAMPAIGN_001', 'Milestone target amount must be a positive number');
    }

    if (data.order === undefined || data.order === null || typeof data.order !== 'number' || data.order < 0 || !Number.isInteger(data.order)) {
      throw AppError.from('CAMPAIGN_001', 'Milestone order must be a non-negative integer');
    }
  }

  static async addMilestone(campaignId: string, data: any, userId: string, userRole: Role): Promise<any> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw AppError.from('CAMPAIGN_002');
    }

    // Check permissions
    if (campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw AppError.from('COMMON_001', 'You do not have permission to add milestones to this campaign');
    }

    // Validate milestone input
    CampaignService.validateMilestoneInput(data);

    const isAlreadyReached = Number(campaign.currentAmount) >= Number(data.targetAmount);
    const milestone = await prisma.milestone.create({
      data: {
        title: data.title,
        description: data.description,
        targetAmount: data.targetAmount,
        order: data.order,
        campaignId,
        achieved: isAlreadyReached,
        achievedAt: isAlreadyReached ? new Date() : null,
      },
    });

    logger.info(`Milestone added to campaign ${campaignId} by user ${userId}`);

    CampaignAuditService.log({
      campaignId,
      action: 'MILESTONE_ADDED',
      entityType: 'Milestone',
      entityId: milestone.id,
      actorId: userId,
      changes: {
        after: {
          title: milestone.title,
          description: milestone.description,
          targetAmount: milestone.targetAmount,
          order: milestone.order,
        },
      },
    });

    dispatchWebhookEvent('CAMPAIGN_MILESTONE_REACHED', {
      milestoneId: milestone.id,
      campaignId,
      title: milestone.title,
      targetAmount: milestone.targetAmount,
      order: milestone.order,
    }).catch((err) => logger.error('Webhook dispatch error (campaign.milestone_reached):', err));

    return milestone;
  }

  /**
   * Validates beneficiary assignment input fields.
   * Enforces non-negative amounts and valid priority.
   */
  private static validateAssignmentInput(data: any): void {
    if (data.assignedAmount !== undefined) {
      if (typeof data.assignedAmount !== 'number' || data.assignedAmount < 0) {
        throw AppError.from('CAMPAIGN_001', 'Assigned amount must be a non-negative number');
      }
    }

    if (data.allocatedAmount !== undefined) {
      if (typeof data.allocatedAmount !== 'number' || data.allocatedAmount < 0) {
        throw AppError.from('CAMPAIGN_001', 'Allocated amount must be a non-negative number');
      }
    }

    if (data.priority !== undefined) {
      if (typeof data.priority !== 'number' || !Number.isInteger(data.priority) || data.priority < 0) {
        throw AppError.from('CAMPAIGN_001', 'Priority must be a non-negative integer');
      }
    }
  }

  static async assignBeneficiary(campaignId: string, beneficiaryId: string, data: any, userId: string, userRole: Role): Promise<any> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw AppError.from('CAMPAIGN_002');
    }

    // Check permissions
    if (campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw AppError.from('COMMON_001', 'You do not have permission to assign beneficiaries to this campaign');
    }

    const beneficiary = await prisma.beneficiary.findUnique({
      where: { id: beneficiaryId },
    });

    if (!beneficiary) {
      throw AppError.from('BENEFICIARY_001');
    }

    // Validate assignment input
    CampaignService.validateAssignmentInput(data);

    const assignment = await prisma.beneficiaryAssignment.upsert({
      where: {
        campaignId_beneficiaryId: {
          campaignId,
          beneficiaryId,
        },
      },
      update: {
        ...data,
      },
      create: {
        campaignId,
        beneficiaryId,
        ...data,
        assignedBy: userId,
      },
    });

    logger.info(`Beneficiary ${beneficiaryId} assigned to campaign ${campaignId} by user ${userId}`);

    CampaignAuditService.log({
      campaignId,
      action: 'BENEFICIARY_ASSIGNED',
      entityType: 'BeneficiaryAssignment',
      entityId: assignment.id,
      actorId: userId,
      changes: {
        after: {
          beneficiaryId,
          assignedAmount: assignment.assignedAmount,
          allocatedAmount: assignment.allocatedAmount,
          priority: assignment.priority,
          notes: assignment.notes,
        },
      },
    });

    return assignment;
  }

  static async getCampaignStats(campaignId: string): Promise<any> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        _count: {
          select: {
            donations: true,
            beneficiaries: true,
            distributions: true,
          },
        },
      },
    });

    if (!campaign) {
      throw AppError.from('CAMPAIGN_002');
    }

    const totalDonated = await prisma.donation.aggregate({
      where: {
        campaignId,
        status: 'CONFIRMED',
      },
      _sum: {
        amount: true,
      },
    });

    const totalDistributed = await prisma.distribution.aggregate({
      where: {
        campaignId,
        status: 'COMPLETED',
      },
      _sum: {
        amount: true,
      },
    });

    const targetAmount = Number(campaign.targetAmount) || 1;
    const currentAmount = Number(campaign.currentAmount) || 0;
    const progress = Number(((currentAmount / targetAmount) * 100).toFixed(2));

    return {
      campaignId: campaign.id,
      title: campaign.title,
      targetAmount: campaign.targetAmount,
      currentAmount: campaign.currentAmount,
      totalDonated: totalDonated._sum.amount || 0,
      totalDistributed: totalDistributed._sum.amount || 0,
      donationCount: campaign._count.donations,
      beneficiaryCount: campaign._count.beneficiaries,
      distributionCount: campaign._count.distributions,
      progress,
    };
  }
}
