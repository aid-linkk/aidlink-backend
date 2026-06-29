import { Request, Response, NextFunction } from 'express';
import { DonationService } from '../services/donation.service';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import logger from '../config/logger';

export class DonationController {
  static async createDonation(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.id;
      const result = await DonationService.createDonation(req.body, userId);

      res.status(201).json({
        success: true,
        data: result,
        message: 'Donation created successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async confirmDonation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const { txHash } = req.body;

      if (!txHash) {
        throw new AppError('Transaction hash is required', 400);
      }

      const result = await DonationService.confirmDonation(id, txHash);

      res.status(200).json({
        success: true,
        data: result,
        message: 'Donation confirmed successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async getDonations(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters = {
        campaignId: req.query.campaignId as string,
        userId: req.query.userId as string,
        status: req.query.status as string,
        startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
        endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      };

      const pagination = {
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 10,
        sortBy: (req.query.sortBy as string) || 'createdAt',
        sortOrder: (req.query.sortOrder as string) || 'desc',
      };

      const result = await DonationService.getDonations(
        filters,
        pagination,
        req.user?.id,
        req.user?.role,
      );

      res.status(200).json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  static async getDonationById(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const result = await DonationService.getDonationById(id, req.user?.id, req.user?.role);

      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  static async revealIdentity(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const { id } = req.params;
      const result = await DonationService.revealIdentity(id, req.user.id);

      res.status(200).json({
        success: true,
        data: result,
        message: 'Identity revealed successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async refundDonation(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const { id } = req.params;
      const result = await DonationService.refundDonation(id, req.user.id, req.user.role);

      res.status(200).json({
        success: true,
        data: result,
        message: 'Donation refunded successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async getMyDonations(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const filters = {
        userId: req.user.id,
        campaignId: req.query.campaignId as string,
        status: req.query.status as string,
        startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
        endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      };

      const pagination = {
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 10,
        sortBy: (req.query.sortBy as string) || 'createdAt',
        sortOrder: (req.query.sortOrder as string) || 'desc',
      };

      // Pass the requesting user's id so their own anonymous donations are visible to them
      const result = await DonationService.getDonations(filters, pagination, req.user.id, req.user.role);

      res.status(200).json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  static async getCampaignDonations(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { campaignId } = req.params;

      const filters = {
        campaignId,
        status: req.query.status as string,
        startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
        endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      };

      const pagination = {
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 10,
        sortBy: (req.query.sortBy as string) || 'createdAt',
        sortOrder: (req.query.sortOrder as string) || 'desc',
      };

      // Public campaign donation feeds: pass requester context for identity gating
      const result = await DonationService.getDonations(
        filters,
        pagination,
        req.user?.id,
        req.user?.role,
      );

      res.status(200).json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }
}
