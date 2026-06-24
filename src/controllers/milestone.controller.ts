import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { MilestoneService } from '../services/milestone.service';
import { ReviewDecision, Role } from '@prisma/client';
import { AppError } from '../middleware/error';

export class MilestoneController {
  // ─── Organization endpoints ────────────────────────────────────

  static async createSubmission(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { campaignId, milestoneId } = req.params;
      const submission = await MilestoneService.createSubmission(
        campaignId,
        milestoneId,
        req.user!.id,
        req.body
      );
      res.status(201).json({ success: true, data: submission, message: 'Submission created' });
    } catch (error) {
      next(error);
    }
  }

  static async updateSubmission(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { submissionId } = req.params;
      const submission = await MilestoneService.updateSubmission(
        submissionId,
        req.user!.id,
        req.body
      );
      res.json({ success: true, data: submission, message: 'Submission updated' });
    } catch (error) {
      next(error);
    }
  }

  static async submitForReview(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { submissionId } = req.params;
      const submission = await MilestoneService.submitForReview(submissionId, req.user!.id);
      res.json({ success: true, data: submission, message: 'Submission sent for review' });
    } catch (error) {
      next(error);
    }
  }

  static async getSubmission(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { submissionId } = req.params;
      const submission = await MilestoneService.getSubmission(
        submissionId,
        req.user!.id,
        req.user!.role
      );
      res.json({ success: true, data: submission });
    } catch (error) {
      next(error);
    }
  }

  static async listSubmissions(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { campaignId, milestoneId } = req.params;
      const submissions = await MilestoneService.listSubmissions(
        milestoneId,
        campaignId,
        req.user!.id,
        req.user!.role
      );
      res.json({ success: true, data: submissions });
    } catch (error) {
      next(error);
    }
  }

  static async getVerificationReport(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { campaignId, milestoneId } = req.params;
      const report = await MilestoneService.getVerificationReport(milestoneId, campaignId);
      res.json({ success: true, data: report });
    } catch (error) {
      next(error);
    }
  }

  // ─── Verifier / Admin endpoints ────────────────────────────────

  static async listAdminSubmissions(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const {
        status,
        campaignId,
        startDate,
        endDate,
        page,
        limit,
      } = req.query as Record<string, string>;

      const result = await MilestoneService.listAdminSubmissions({
        status: status as any,
        campaignId,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        page: page ? parseInt(page, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
      });

      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  static async getAdminSubmission(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { submissionId } = req.params;
      const submission = await MilestoneService.getSubmission(submissionId);
      res.json({ success: true, data: submission });
    } catch (error) {
      next(error);
    }
  }

  static async createReview(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { submissionId } = req.params;
      const { decision, reason, verifierNotes, metricsConfirmed, impactSummary } = req.body;

      if (!Object.values(ReviewDecision).includes(decision)) {
        throw new AppError(`Invalid decision. Must be one of: ${Object.values(ReviewDecision).join(', ')}`, 400);
      }

      const review = await MilestoneService.createReview(submissionId, req.user!.id, {
        decision,
        reason,
        verifierNotes,
        metricsConfirmed,
        impactSummary,
      });

      res.status(201).json({ success: true, data: review, message: 'Review submitted' });
    } catch (error) {
      next(error);
    }
  }

  static async listSubmissionReviews(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { submissionId } = req.params;
      const reviews = await MilestoneService.listSubmissionReviews(submissionId);
      res.json({ success: true, data: reviews });
    } catch (error) {
      next(error);
    }
  }

  static async getMilestoneVerificationStatus(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { milestoneId } = req.params;
      const status = await MilestoneService.getMilestoneVerificationStatus(milestoneId);
      res.json({ success: true, data: status });
    } catch (error) {
      next(error);
    }
  }
}
