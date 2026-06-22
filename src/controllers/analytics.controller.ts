import { Request, Response, NextFunction } from 'express';
import { AnalyticsService } from '../services/analytics.service';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';

export class AnalyticsController {
  static async getCampaignAnalytics(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { campaignId } = req.params;
      
      const analytics = await AnalyticsService.getCampaignAnalytics(campaignId);
      
      res.status(200).json({
        success: true,
        data: analytics,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getDonorAnalytics(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const analytics = await AnalyticsService.getDonorAnalytics(req.user.id);
      
      res.status(200).json({
        success: true,
        data: analytics,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getOrganizationAnalytics(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const { organizationId } = req.params;
      
      const analytics = await AnalyticsService.getOrganizationAnalytics(organizationId);
      
      res.status(200).json({
        success: true,
        data: analytics,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getPlatformAnalytics(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== 'ADMIN') {
        throw new AppError('Admin access required', 403);
      }

      const analytics = await AnalyticsService.getPlatformAnalytics();
      
      res.status(200).json({
        success: true,
        data: analytics,
      });
    } catch (error) {
      next(error);
    }
  }

  static async generateReport(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const { reportType } = req.params;
      const filters = req.body;
      
      const report = await AnalyticsService.generateReport(reportType, filters);
      
      res.status(200).json({
        success: true,
        data: report,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getTrendingCampaigns(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const period = (req.query.period as 'last24h' | 'last7d' | 'last30d') || 'last24h';
      const sortBy = (req.query.sortBy as 'trendScore' | 'donationVelocity' | 'distributionImpact') || 'trendScore';
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;

      const trending = await AnalyticsService.getTrendingCampaigns({ period, sortBy, limit });

      res.status(200).json({
        success: true,
        data: trending,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getCampaignImpactMetrics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const metrics = await AnalyticsService.getCampaignImpactMetrics(id);

      res.status(200).json({
        success: true,
        data: metrics,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getCampaignHistoricalStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const granularity = (req.query.granularity as 'hourly' | 'monthly') || 'hourly';
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

      const range = startDate && endDate ? { startDate, endDate } : undefined;

      const stats = await AnalyticsService.getCampaignHistoricalStats(id, granularity, range);

      res.status(200).json({
        success: true,
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getAggregatedCampaignAnalytics(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || req.user.role !== 'ADMIN') {
        throw new AppError('Admin access required', 403);
      }

      const filters = {
        status: req.query.status as string,
        startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
        endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      };

      const pagination = {
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 10,
        sortBy: req.query.sortBy as string || 'createdAt',
        sortOrder: (req.query.sortOrder as 'asc' | 'desc') || 'desc',
      };

      const result = await AnalyticsService.getAggregatedCampaignAnalytics(filters, pagination);

      res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }
}
