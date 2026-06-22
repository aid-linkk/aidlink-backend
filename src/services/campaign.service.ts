import prisma from '../config/database';
import { CampaignInput, CampaignFilters, PaginatedResponse } from '../types';
import { CampaignStatus, Role } from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { ModerationService } from './moderation.service';
import { dispatchWebhookEvent } from '../controllers/webhook.controller';

export class CampaignService {
  static async createCampaign(data: CampaignInput, userId: string, organizationId: string): Promise<any> {
    // Verify organization exists and belongs to user
    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new AppError('Organization not found', 404);
    }

    if (organization.userId !== userId) {
      throw new AppError('You do not have permission to create campaigns for this organization', 403);
    }

    const campaign = await prisma.campaign.create({
      data: {
        ...data,
        userId,
        organizationId,
        status: CampaignStatus.DRAFT,
      },
    });

    logger.info(`Campaign created: ${campaign.id} by user ${userId}`);

    return campaign;
  }

  static async getCampaigns(filters: CampaignFilters, pagination: any): Promise<PaginatedResponse<any>> {
    const { page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = pagination;
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
        },
      },
    });

    if (!campaign) {
      throw new AppError('Campaign not found', 404);
    }

    // Attach moderation context: current suspension summary and whether the
    // owner can submit an appeal.
    const { suspensionSummary, canAppeal } = await ModerationService.getModerationView(campaign);

    return { ...campaign, suspensionSummary, canAppeal };
  }

  /**
   * Validates campaign input fields for update operations.
   * Enforces business rules for title, description, targetAmount, dates, and imageUrl.
   */
  private static validateCampaignUpdateInput(data: Partial<CampaignInput>): void {
    if (data.title !== undefined) {
      if (typeof data.title !== 'string' || data.title.trim().length < 3) {
        throw new AppError('Title must be at least 3 characters long', 400);
      }
      if (data.title.trim().length > 200) {
        throw new AppError('Title must not exceed 200 characters', 400);
      }
    }

    if (data.description !== undefined) {
      if (typeof data.description !== 'string' || data.description.trim().length < 10) {
        throw new AppError('Description must be at least 10 characters long', 400);
      }
      if (data.description.trim().length > 5000) {
        throw new AppError('Description must not exceed 5000 characters', 400);
      }
    }

    if (data.targetAmount !== undefined) {
      if (typeof data.targetAmount !== 'number' || data.targetAmount <= 0) {
        throw new AppError('Target amount must be a positive number', 400);
      }
    }

    if (data.startDate !== undefined) {
      const startDate = new Date(data.startDate);
      if (isNaN(startDate.getTime())) {
        throw new AppError('Start date must be a valid date', 400);
      }
    }

    if (data.endDate !== undefined && data.endDate !== null) {
      const endDate = new Date(data.endDate);
      if (isNaN(endDate.getTime())) {
        throw new AppError('End date must be a valid date', 400);
      }
      // Validate endDate is after startDate if both are provided
      if (data.startDate !== undefined) {
        const startDate = new Date(data.startDate);
        if (endDate <= startDate) {
          throw new AppError('End date must be after start date', 400);
        }
      }
    }

    if (data.imageUrl !== undefined && data.imageUrl !== null && data.imageUrl !== '') {
      try {
        new URL(data.imageUrl);
      } catch {
        throw new AppError('Image URL must be a valid URL', 400);
      }
    }
  }

  static async updateCampaign(id: string, data: Partial<CampaignInput>, userId: string, userRole: Role): Promise<any> {
    const campaign = await prisma.campaign.findUnique({
      where: { id },
    });

    if (!campaign) {
      throw new AppError('Campaign not found', 404);
    }

    // Check permissions
    if (campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw new AppError('You do not have permission to update this campaign', 403);
    }

    // Prevent updating if campaign is completed or cancelled
    if (campaign.status === CampaignStatus.COMPLETED || campaign.status === CampaignStatus.CANCELLED) {
      throw new AppError('Cannot update a completed or cancelled campaign', 400);
    }

    // Validate input fields
    CampaignService.validateCampaignUpdateInput(data);

    // If endDate is provided without startDate, validate against existing startDate
    if (data.endDate !== undefined && data.endDate !== null && data.startDate === undefined) {
      const endDate = new Date(data.endDate);
      if (endDate <= campaign.startDate) {
        throw new AppError('End date must be after start date', 400);
      }
    }

    const updated = await prisma.campaign.update({
      where: { id },
      data,
    });

    logger.info(`Campaign updated: ${id} by user ${userId}`);

    return updated;
  }

  static async deleteCampaign(id: string, userId: string, userRole: Role): Promise<void> {
    const campaign = await prisma.campaign.findUnique({
      where: { id },
    });

    if (!campaign) {
      throw new AppError('Campaign not found', 404);
    }

    // Check permissions
    if (campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw new AppError('You do not have permission to delete this campaign', 403);
    }

    // Only allow deletion of draft campaigns
    if (campaign.status !== CampaignStatus.DRAFT) {
      throw new AppError('Can only delete draft campaigns', 400);
    }

    // Delete campaign and dependent records transactionally
    await prisma.$transaction(async (tx) => {
      await tx.milestone.deleteMany({ where: { campaignId: id } });
      await tx.beneficiaryAssignment.deleteMany({ where: { campaignId: id } });
      await tx.distribution.deleteMany({ where: { campaignId: id } });
      await tx.donation.deleteMany({ where: { campaignId: id } });
      await tx.campaign.delete({ where: { id } });
    });

    logger.info(`Campaign deleted: ${id} by user ${userId}`);
  }

  static async updateCampaignStatus(id: string, status: CampaignStatus, userId: string, userRole: Role): Promise<any> {
    const campaign = await prisma.campaign.findUnique({
      where: { id },
    });

    if (!campaign) {
      throw new AppError('Campaign not found', 404);
    }

    // Check permissions
    if (campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw new AppError('You do not have permission to update this campaign status', 403);
    }

    // Suspension/reinstatement must go through the moderation workflow so that
    // a suspension record and audit trail are always created. This prevents an
    // owner from self-reinstating a suspended campaign via this endpoint.
    if (status === CampaignStatus.SUSPENDED) {
      throw new AppError('Use the moderation endpoint to suspend a campaign', 400);
    }
    if (campaign.status === CampaignStatus.SUSPENDED) {
      throw new AppError('Suspended campaigns can only be reinstated by an admin or via an approved appeal', 400);
    }

    const updated = await prisma.campaign.update({
      where: { id },
      data: { status },
    });

    logger.info(`Campaign status updated: ${id} to ${status} by user ${userId}`);

    return updated;
  }

  /**
   * Validates milestone input fields.
   * Enforces presence of title/description and valid numeric constraints.
   */
  private static validateMilestoneInput(data: any): void {
    if (!data.title || typeof data.title !== 'string' || data.title.trim().length === 0) {
      throw new AppError('Milestone title is required', 400);
    }

    if (!data.description || typeof data.description !== 'string' || data.description.trim().length === 0) {
      throw new AppError('Milestone description is required', 400);
    }

    if (data.targetAmount === undefined || data.targetAmount === null || typeof data.targetAmount !== 'number' || data.targetAmount <= 0) {
      throw new AppError('Milestone target amount must be a positive number', 400);
    }

    if (data.order === undefined || data.order === null || typeof data.order !== 'number' || data.order < 0 || !Number.isInteger(data.order)) {
      throw new AppError('Milestone order must be a non-negative integer', 400);
    }
  }

  static async addMilestone(campaignId: string, data: any, userId: string, userRole: Role): Promise<any> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new AppError('Campaign not found', 404);
    }

    // Check permissions
    if (campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw new AppError('You do not have permission to add milestones to this campaign', 403);
    }

    // Validate milestone input
    CampaignService.validateMilestoneInput(data);

    const milestone = await prisma.milestone.create({
      data: {
        title: data.title,
        description: data.description,
        targetAmount: data.targetAmount,
        order: data.order,
        campaignId,
      },
    });

    logger.info(`Milestone added to campaign ${campaignId} by user ${userId}`);

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
        throw new AppError('Assigned amount must be a non-negative number', 400);
      }
    }

    if (data.allocatedAmount !== undefined) {
      if (typeof data.allocatedAmount !== 'number' || data.allocatedAmount < 0) {
        throw new AppError('Allocated amount must be a non-negative number', 400);
      }
    }

    if (data.priority !== undefined) {
      if (typeof data.priority !== 'number' || !Number.isInteger(data.priority) || data.priority < 0) {
        throw new AppError('Priority must be a non-negative integer', 400);
      }
    }
  }

  static async assignBeneficiary(campaignId: string, beneficiaryId: string, data: any, userId: string, userRole: Role): Promise<any> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new AppError('Campaign not found', 404);
    }

    // Check permissions
    if (campaign.userId !== userId && userRole !== Role.ADMIN) {
      throw new AppError('You do not have permission to assign beneficiaries to this campaign', 403);
    }

    const beneficiary = await prisma.beneficiary.findUnique({
      where: { id: beneficiaryId },
    });

    if (!beneficiary) {
      throw new AppError('Beneficiary not found', 404);
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
      throw new AppError('Campaign not found', 404);
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
