import prisma from '../config/database';
import { DonationInput, DonationFilters, PaginatedResponse } from '../types';
import { DonationStatus, Role } from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { WebhookService } from './webhook.service';

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

    const donation = await prisma.donation.create({
      data: {
        ...data,
        userId,
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

    const updated = await prisma.$transaction(async (tx) => {
      // Update donation
      const updatedDonation = await tx.donation.update({
        where: { id },
        data: {
          status: DonationStatus.CONFIRMED,
          blockchainTxHash: txHash,
        },
      });

      // Update campaign current amount
      await tx.campaign.update({
        where: { id: donation.campaignId },
        data: {
          currentAmount: {
            increment: donation.amount,
          },
        },
      });

      return updatedDonation;
    });

    logger.info(`Donation confirmed: ${id} with tx ${txHash}`);

    WebhookService.dispatchEventSafely({
      type: 'donation.confirmed',
      resource: { type: 'donation', id: updated.id },
      data: {
        donationId: updated.id,
        campaignId: donation.campaignId,
        userId: donation.userId,
        amount: donation.amount,
        currency: donation.currency,
        blockchainTxHash: txHash,
        status: updated.status,
      },
    });

    DonationService.markReachedMilestones(donation.campaignId).catch((error) => {
      logger.error(`Failed to process campaign milestone webhooks for campaign ${donation.campaignId}`, error);
    });

    return updated;
  }

  private static async markReachedMilestones(campaignId: string): Promise<void> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        milestones: {
          where: { achieved: false },
          orderBy: { order: 'asc' },
        },
      },
    });

    if (!campaign) {
      return;
    }

    const currentAmount = Number(campaign.currentAmount);
    const reachedMilestones = campaign.milestones.filter((milestone: any) => (
      Number(milestone.targetAmount) <= currentAmount
    ));

    await Promise.all(reachedMilestones.map(async (milestone: any) => {
      const achieved = await prisma.milestone.update({
        where: { id: milestone.id },
        data: {
          achieved: true,
          achievedAt: new Date(),
        },
      });

      WebhookService.dispatchEventSafely({
        type: 'campaign.milestone_reached',
        resource: { type: 'milestone', id: achieved.id },
        data: {
          milestoneId: achieved.id,
          campaignId,
          title: achieved.title,
          targetAmount: achieved.targetAmount,
          currentAmount: campaign.currentAmount,
          achievedAt: achieved.achievedAt,
        },
      });
    }));
  }

  static async getDonations(filters: DonationFilters, pagination: any): Promise<PaginatedResponse<any>> {
    const { page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = pagination;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (filters.campaignId) {
      where.campaignId = filters.campaignId;
    }

    if (filters.userId) {
      where.userId = filters.userId;
    }

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.startDate) {
      where.createdAt = { gte: filters.startDate };
    }

    if (filters.endDate) {
      where.createdAt = { lte: filters.endDate };
    }

    const [donations, total] = await Promise.all([
      prisma.donation.findMany({
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
          user: {
            select: {
              id: true,
              username: true,
              email: true,
            },
          },
        },
      }),
      prisma.donation.count({ where }),
    ]);

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

  static async getDonationById(id: string): Promise<any> {
    const donation = await prisma.donation.findUnique({
      where: { id },
      include: {
        campaign: {
          select: {
            id: true,
            title: true,
            organization: {
              select: {
                name: true,
              },
            },
          },
        },
        user: {
          select: {
            id: true,
            username: true,
            email: true,
          },
        },
      },
    });

    if (!donation) {
      throw new AppError('Donation not found', 404);
    }

    return donation;
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

    // Check permissions
    if (donation.userId !== userId && userRole !== Role.ADMIN) {
      throw new AppError('You do not have permission to refund this donation', 403);
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Update donation status
      const updatedDonation = await tx.donation.update({
        where: { id },
        data: {
          status: DonationStatus.REFUNDED,
        },
      });

      // Decrease campaign current amount
      await tx.campaign.update({
        where: { id: donation.campaignId },
        data: {
          currentAmount: {
            decrement: donation.amount,
          },
        },
      });

      return updatedDonation;
    });

    logger.info(`Donation refunded: ${id} by user ${userId}`);

    return updated;
  }
}
