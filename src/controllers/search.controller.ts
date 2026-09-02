import { Response, NextFunction } from 'express';
import { SearchService, SearchFilters } from '../services/search.service';
import { AuthRequest } from '../types';
import { beneficiarySearchSchema, distributionSearchSchema, assignmentSearchSchema } from '../utils/validation';
import { AppError } from '../middleware/error';

export class SearchController {
  static async searchCampaigns(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters: SearchFilters = {
        query: req.query.query as string,
        dateFrom: req.query.dateFrom ? new Date(req.query.dateFrom as string) : undefined,
        dateTo: req.query.dateTo ? new Date(req.query.dateTo as string) : undefined,
        status: req.query.status as string,
        minAmount: req.query.minAmount ? parseFloat(req.query.minAmount as string) : undefined,
        maxAmount: req.query.maxAmount ? parseFloat(req.query.maxAmount as string) : undefined,
        sortBy: req.query.sortBy as string,
        sortOrder: req.query.sortOrder as 'asc' | 'desc',
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
      };

      const results = await SearchService.searchCampaigns(filters);

      res.status(200).json({
        success: true,
        ...results,
      });
    } catch (error) {
      next(error);
    }
  }

  static async searchDonations(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters: SearchFilters = {
        query: req.query.query as string,
        dateFrom: req.query.dateFrom ? new Date(req.query.dateFrom as string) : undefined,
        dateTo: req.query.dateTo ? new Date(req.query.dateTo as string) : undefined,
        status: req.query.status as string,
        minAmount: req.query.minAmount ? parseFloat(req.query.minAmount as string) : undefined,
        maxAmount: req.query.maxAmount ? parseFloat(req.query.maxAmount as string) : undefined,
        sortBy: req.query.sortBy as string,
        sortOrder: req.query.sortOrder as 'asc' | 'desc',
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
      };

      const results = await SearchService.searchDonations(filters);

      res.status(200).json({
        success: true,
        ...results,
      });
    } catch (error) {
      next(error);
    }
  }

  static async searchBeneficiaries(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = beneficiarySearchSchema.safeParse(req.query);
      if (!parsed.success) {
        const message = parsed.error.errors
          .map((e) => `${e.path.join('.') || 'query'}: ${e.message}`)
          .join('; ');
        throw new AppError(`Invalid search parameters: ${message}`, 400);
      }

      const results = await SearchService.searchBeneficiaries({
        query: parsed.data.q,
        country: parsed.data.country,
        city: parsed.data.city,
        needsCategory: parsed.data.needsCategory,
        verificationStatus: parsed.data.verificationStatus,
        riskScoreMin: parsed.data.riskScoreMin,
        riskScoreMax: parsed.data.riskScoreMax,
        ageMin: parsed.data.ageMin,
        ageMax: parsed.data.ageMax,
        familySizeMin: parsed.data.familySizeMin,
        familySizeMax: parsed.data.familySizeMax,
        sortBy: parsed.data.sortBy,
        sortOrder: parsed.data.sortOrder,
        page: parsed.data.page,
        limit: parsed.data.limit,
      });

      res.status(200).json({
        success: true,
        ...results,
      });
    } catch (error) {
      next(error);
    }
  }

  static async searchDistributions(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = distributionSearchSchema.safeParse(req.query);
      if (!parsed.success) {
        const message = parsed.error.errors
          .map((e) => `${e.path.join('.') || 'query'}: ${e.message}`)
          .join('; ');
        throw new AppError(`Invalid search parameters: ${message}`, 400);
      }

      const results = await SearchService.searchDistributions({
        query: parsed.data.q,
        distributionId: parsed.data.distributionId,
        campaignId: parsed.data.campaignId,
        campaignName: parsed.data.campaignName,
        beneficiaryId: parsed.data.beneficiaryId,
        beneficiaryName: parsed.data.beneficiaryName,
        status: parsed.data.status,
        method: parsed.data.method,
        location: parsed.data.location,
        distributedBy: parsed.data.distributedBy,
        dateFrom: parsed.data.dateFrom,
        dateTo: parsed.data.dateTo,
        minAmount: parsed.data.minAmount,
        maxAmount: parsed.data.maxAmount,
        sortBy: parsed.data.sortBy,
        sortOrder: parsed.data.sortOrder,
        page: parsed.data.page,
        limit: parsed.data.limit,
      });

      res.status(200).json({
        success: true,
        ...results,
      });
    } catch (error) {
      next(error);
    }
  }

  static async searchAssignments(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = assignmentSearchSchema.safeParse(req.query);
      if (!parsed.success) {
        const message = parsed.error.errors
          .map((e) => `${e.path.join('.') || 'query'}: ${e.message}`)
          .join('; ');
        throw new AppError(`Invalid search parameters: ${message}`, 400);
      }

      const results = await SearchService.searchAssignments({
        query: parsed.data.q,
        assignmentId: parsed.data.assignmentId,
        campaignId: parsed.data.campaignId,
        campaignName: parsed.data.campaignName,
        beneficiaryId: parsed.data.beneficiaryId,
        beneficiaryName: parsed.data.beneficiaryName,
        needsCategory: parsed.data.needsCategory,
        location: parsed.data.location,
        priorityMin: parsed.data.priorityMin,
        priorityMax: parsed.data.priorityMax,
        dateFrom: parsed.data.dateFrom,
        dateTo: parsed.data.dateTo,
        sortBy: parsed.data.sortBy,
        sortOrder: parsed.data.sortOrder,
        page: parsed.data.page,
        limit: parsed.data.limit,
      });

      res.status(200).json({
        success: true,
        ...results,
      });
    } catch (error) {
      next(error);
    }
  }

  static async globalSearch(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters: SearchFilters = {
        query: req.query.query as string,
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 10,
      };

      const results = await SearchService.globalSearch(filters);

      res.status(200).json({
        success: true,
        ...results,
      });
    } catch (error) {
      next(error);
    }
  }

  static async advancedSearch(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters: SearchFilters = {
        query: req.query.query as string,
        entityType: req.query.entityType as string,
        dateFrom: req.query.dateFrom ? new Date(req.query.dateFrom as string) : undefined,
        dateTo: req.query.dateTo ? new Date(req.query.dateTo as string) : undefined,
        status: req.query.status as string,
        country: req.query.country as string,
        minAmount: req.query.minAmount ? parseFloat(req.query.minAmount as string) : undefined,
        maxAmount: req.query.maxAmount ? parseFloat(req.query.maxAmount as string) : undefined,
        campaignId: req.query.campaignId as string,
        beneficiaryId: req.query.beneficiaryId as string,
        sortBy: req.query.sortBy as string,
        sortOrder: req.query.sortOrder as 'asc' | 'desc',
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
      };

      const results = await SearchService.advancedSearch(filters);

      res.status(200).json({
        success: true,
        ...results,
      });
    } catch (error) {
      next(error);
    }
  }
}
