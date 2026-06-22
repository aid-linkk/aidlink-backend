import prisma from '../config/database';
import { DonationInput, DonationFilters, PaginatedResponse } from '../types';
import { DonationStatus, Role } from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { dispatchWebhookEvent } from '../controllers/webhook.controller';
import { AnalyticsService } from './analytics.service';

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

    dispatchWebhookEvent('DONATION_CONFIRMED', {
      donationId: id,
      campaignId: donation.campaignId,
      amount: updated.amount,
      currency: updated.currency,
      blockchainTxHash: txHash,
    }).catch((err) => logger.error('Webhook dispatch error (donation.confirmed):', err));

    return updated;
  }

  static async getDonations(
    filters: DonationFilters = {},
    pagination: any
  ): Promise<PaginatedResponse<any>> {
    filters = filters ?? {};

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

    if (filters.startDate || filters.endDate) {
      where.createdAt = {};

      if (filters.startDate) {
        where.createdAt.gte = filters.startDate;
      }

      if (filters.endDate) {
        where.createdAt.lte = filters.endDate;
      }
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

    // Prevent negative campaign balance
    if (donation.campaign.currentAmount < donation.amount) {
      throw new AppError('Refund amount exceeds campaign current balance', 400);
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

    // Update cache: invalidate on refund
    AnalyticsService.invalidateCampaignCache(donation.campaignId).catch((err) =>
      logger.error('Failed to invalidate campaign cache on refund', err)
    );

    return updated;
  }
}
