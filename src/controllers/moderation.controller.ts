import { Response, NextFunction } from 'express';
import { ModerationService } from '../services/moderation.service';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import { Role, AppealStatus } from '@prisma/client';

export class ModerationController {
  // ─── Owner / public ────────────────────────────────────────────

  static async reportCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const { type, details } = req.body;
      const report = await ModerationService.reportCampaign(id, req.user?.id, type, details);

      res.status(201).json({
        success: true,
        data: { id: report.id, createdAt: report.createdAt },
        message: 'Report submitted. Thank you for helping keep AidLink safe.',
      });
    } catch (error) {
      next(error);
    }
  }

  static async submitAppeal(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const { id } = req.params;
      const { message, attachments } = req.body;
      const appeal = await ModerationService.submitAppeal(id, req.user.id, message, attachments);

      res.status(201).json({
        success: true,
        data: appeal,
        message: 'Appeal submitted successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async getCampaignAppeals(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const { id } = req.params;
      const appeals = await ModerationService.getCampaignAppeals(id, req.user.id, req.user.role);

      res.status(200).json({ success: true, data: appeals });
    } catch (error) {
      next(error);
    }
  }

  // ─── Admin ─────────────────────────────────────────────────────

  static async suspendCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      ModerationController.requireAdmin(req);

      const { id } = req.params;
      const { reasonCode, reasonText, evidence } = req.body;
      const result = await ModerationService.suspendCampaign(id, {
        source: 'ADMIN',
        actorId: req.user!.id,
        reasonCode,
        reasonText,
        evidence,
      });

      res.status(200).json({
        success: true,
        data: { campaign: result.campaign, suspension: result.suspension },
        message: result.alreadySuspended
          ? 'Campaign is already suspended'
          : 'Campaign suspended successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async reinstateCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      ModerationController.requireAdmin(req);

      const { id } = req.params;
      const { adminNotes } = req.body;
      const campaign = await ModerationService.reinstateCampaign(id, req.user!.id, adminNotes);

      res.status(200).json({
        success: true,
        data: campaign,
        message: 'Campaign reinstated successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async getSuspensions(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      ModerationController.requireAdmin(req);

      const { id } = req.params;
      const suspensions = await ModerationService.listSuspensions(id);

      res.status(200).json({ success: true, data: suspensions });
    } catch (error) {
      next(error);
    }
  }

  static async listAppeals(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      ModerationController.requireAdmin(req);

      const filters = {
        status: req.query.status as AppealStatus | undefined,
        campaignId: req.query.campaignId as string | undefined,
      };
      const pagination = {
        page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
        sortOrder: (req.query.sortOrder as 'asc' | 'desc') || 'desc',
      };

      const result = await ModerationService.listAppeals(filters, pagination);

      res.status(200).json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  static async resolveAppeal(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      ModerationController.requireAdmin(req);

      const { id } = req.params;
      const { decision, adminNotes } = req.body;
      const appeal = await ModerationService.resolveAppeal(id, decision, req.user!.id, adminNotes);

      res.status(200).json({
        success: true,
        data: appeal,
        message: `Appeal ${decision === 'APPROVE' ? 'approved' : 'denied'} successfully`,
      });
    } catch (error) {
      next(error);
    }
  }

  private static requireAdmin(req: AuthRequest): void {
    if (!req.user) {
      throw new AppError('Authentication required', 401);
    }
    if (req.user.role !== Role.ADMIN) {
      throw new AppError('Admin access required', 403);
    }
  }
}
