import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import prisma from '../config/database';
import { getCacheMetrics } from '../utils/cache';
import { Role, UserStatus, CampaignStatus, DonationStatus, DistributionStatus, KYCStatus } from '@prisma/client';

export class AdminController {
  static async getDashboardStats(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== Role.ADMIN) {
        throw new AppError('Admin access required', 403);
      }

      const [
        totalUsers,
        activeUsers,
        pendingUsers,
        totalCampaigns,
        activeCampaigns,
        totalDonations,
        confirmedDonations,
        totalDistributions,
        completedDistributions,
        totalBeneficiaries,
        verifiedBeneficiaries,
        pendingKYC,
      ] = await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { status: UserStatus.ACTIVE } }),
        prisma.user.count({ where: { status: UserStatus.PENDING_VERIFICATION } }),
        prisma.campaign.count(),
        prisma.campaign.count({ where: { status: CampaignStatus.ACTIVE } }),
        prisma.donation.count(),
        prisma.donation.count({ where: { status: DonationStatus.CONFIRMED } }),
        prisma.distribution.count(),
        prisma.distribution.count({ where: { status: DistributionStatus.COMPLETED } }),
        prisma.beneficiary.count(),
        prisma.beneficiary.count({ where: { status: 'VERIFIED' } }),
        prisma.kYCSubmission.count({ where: { status: KYCStatus.PENDING } }),
      ]);

      // Calculate total funds raised and distributed
      const [fundsRaised, fundsDistributed] = await Promise.all([
        prisma.donation.aggregate({
          where: { status: DonationStatus.CONFIRMED },
          _sum: { amount: true },
        }),
        prisma.distribution.aggregate({
          where: { status: DistributionStatus.COMPLETED },
          _sum: { amount: true },
        }),
      ]);

      res.status(200).json({
        success: true,
        data: {
          users: {
            total: totalUsers,
            active: activeUsers,
            pending: pendingUsers,
          },
          campaigns: {
            total: totalCampaigns,
            active: activeCampaigns,
          },
          donations: {
            total: totalDonations,
            confirmed: confirmedDonations,
            totalRaised: fundsRaised._sum.amount || 0,
          },
          distributions: {
            total: totalDistributions,
            completed: completedDistributions,
            totalDistributed: fundsDistributed._sum.amount || 0,
          },
          beneficiaries: {
            total: totalBeneficiaries,
            verified: verifiedBeneficiaries,
          },
          kyc: {
            pending: pendingKYC,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  static async getRecentActivity(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== Role.ADMIN) {
        throw new AppError('Admin access required', 403);
      }

      const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;

      const [recentDonations, recentDistributions, recentUsers, recentCampaigns] = await Promise.all([
        prisma.donation.findMany({
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            user: {
              select: {
                id: true,
                username: true,
                email: true,
              },
            },
            campaign: {
              select: {
                id: true,
                title: true,
              },
            },
          },
        }),
        prisma.distribution.findMany({
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            beneficiary: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
            campaign: {
              select: {
                id: true,
                title: true,
              },
            },
          },
        }),
        prisma.user.findMany({
          take: limit,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            email: true,
            username: true,
            role: true,
            status: true,
            createdAt: true,
          },
        }),
        prisma.campaign.findMany({
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            organization: {
              select: {
                name: true,
              },
            },
          },
        }),
      ]);

      res.status(200).json({
        success: true,
        data: {
          recentDonations,
          recentDistributions,
          recentUsers,
          recentCampaigns,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  static async getAllUsers(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== Role.ADMIN) {
        throw new AppError('Admin access required', 403);
      }

      const page = req.query.page ? parseInt(req.query.page as string) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
      const skip = (page - 1) * limit;
      const status = req.query.status as UserStatus;
      const role = req.query.role as Role;

      const where: any = {};
      if (status) where.status = status;
      if (role) where.role = role;

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            email: true,
            username: true,
            role: true,
            status: true,
            emailVerified: true,
            walletAddress: true,
            createdAt: true,
            lastLogin: true,
          },
        }),
        prisma.user.count({ where }),
      ]);

      res.status(200).json({
        success: true,
        data: users,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateUserStatus(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== Role.ADMIN) {
        throw new AppError('Admin access required', 403);
      }

      const { id } = req.params;
      const { status } = req.body;

      const user = await prisma.user.update({
        where: { id },
        data: { status },
      });

      res.status(200).json({
        success: true,
        data: user,
        message: 'User status updated successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateUserRole(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== Role.ADMIN) {
        throw new AppError('Admin access required', 403);
      }

      const { id } = req.params;
      const { role } = req.body;

      const user = await prisma.user.update({
        where: { id },
        data: { role },
      });

      res.status(200).json({
        success: true,
        data: user,
        message: 'User role updated successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async getAuditLogs(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== Role.ADMIN) {
        throw new AppError('Admin access required', 403);
      }

      const page = req.query.page ? parseInt(req.query.page as string) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const skip = (page - 1) * limit;
      const action = req.query.action as string;
      const entityType = req.query.entityType as string;

      const where: any = {};
      if (action) where.action = action;
      if (entityType) where.entityType = entityType;

      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            user: {
              select: {
                id: true,
                email: true,
                username: true,
              },
            },
          },
        }),
        prisma.auditLog.count({ where }),
      ]);

      res.status(200).json({
        success: true,
        data: logs,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  static async getSystemHealth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== Role.ADMIN) {
        throw new AppError('Admin access required', 403);
      }

      // Get database connection status
      const dbStatus = await prisma.$queryRaw`SELECT 1`;

      // Get queue job stats
      const [pendingJobs, processingJobs, failedJobs] = await Promise.all([
        prisma.queueJob.count({ where: { status: 'PENDING' } }),
        prisma.queueJob.count({ where: { status: 'PROCESSING' } }),
        prisma.queueJob.count({ where: { status: 'FAILED' } }),
      ]);

      // Get blockchain transaction stats
      const [pendingTx, confirmedTx] = await Promise.all([
        prisma.blockchainTransaction.count({ where: { status: 'PENDING' } }),
        prisma.blockchainTransaction.count({ where: { status: 'CONFIRMED' } }),
      ]);

      res.status(200).json({
        success: true,
        data: {
          database: {
            status: 'connected',
            latency: Date.now(),
          },
          queue: {
            pending: pendingJobs,
            processing: processingJobs,
            failed: failedJobs,
          },
          blockchain: {
            pendingTransactions: pendingTx,
            confirmedTransactions: confirmedTx,
          },
          cache: await getCacheMetrics(),
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      next(error);
    }
  }
}
