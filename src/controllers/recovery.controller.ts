import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import { Role, RecoveryCaseType, RecoveryStatus, SettlementOption } from '@prisma/client';
import * as RecoveryService from '../services/recovery.service';

function requireAdmin(req: AuthRequest) {
  if (!req.user || req.user.role !== Role.ADMIN) {
    throw new AppError('Admin access required', 403);
  }
}

export class RecoveryController {
  /** GET /admin/recoveries */
  static async listCases(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      requireAdmin(req);
      const result = await RecoveryService.listRecoveryCases({
        type: req.query.type as RecoveryCaseType | undefined,
        status: req.query.status as RecoveryStatus | undefined,
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
      });
      res.status(200).json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  }

  /** GET /admin/recoveries/:id */
  static async getCase(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      requireAdmin(req);
      const data = await RecoveryService.getRecoveryCaseById(req.params.id);
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /** GET /admin/recoveries/reconciliation */
  static async reconciliation(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      requireAdmin(req);
      const data = await RecoveryService.getReconciliationReport();
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /** POST /admin/refunds/:id/retry */
  static async retryRefund(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      requireAdmin(req);
      const data = await RecoveryService.retryRefund(req.params.id, req.user!.id);
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /** POST /admin/refunds/:id/update-destination */
  static async updateRefundDestination(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      requireAdmin(req);
      const { bankName, accountNumber, routingNumber } = req.body;
      const data = await RecoveryService.updateRefundDestination(
        req.params.id,
        { bankName, accountNumber, routingNumber },
        req.user!.id
      );
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /** POST /admin/distributions/:id/retry */
  static async retryDistribution(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      requireAdmin(req);
      const data = await RecoveryService.retryDistribution(req.params.id, req.user!.id);
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /** POST /admin/distributions/:id/flag-recovery */
  static async flagDistributionRecovery(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      requireAdmin(req);
      const data = await RecoveryService.markDistributionRecoveryRequired(req.params.id, req.user!.id);
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /** POST /admin/campaigns/:id/settle */
  static async settleCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      requireAdmin(req);
      const { option, notes, targetCampaignId } = req.body;
      const data = await RecoveryService.settleCancelledCampaign(
        req.params.id,
        option as SettlementOption,
        req.user!.id,
        notes,
        targetCampaignId
      );
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /** POST /admin/recoveries/:id/donor-credit */
  static async issueDonorCredit(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      requireAdmin(req);
      const { userId, amount, currency, reason, expiresAt } = req.body;
      const data = await RecoveryService.issueDonorCredit(
        req.params.id,
        userId,
        amount,
        currency ?? 'XLM',
        reason,
        req.user!.id,
        expiresAt ? new Date(expiresAt) : undefined
      );
      res.status(201).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /** POST /admin/recoveries/failed-refund – create case manually */
  static async createFailedRefundCase(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      requireAdmin(req);
      const { donationId, failureReason, failureMetadata } = req.body;
      const data = await RecoveryService.createFailedRefundCase(donationId, failureReason, failureMetadata);
      res.status(201).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /** POST /admin/recoveries/failed-distribution – create case manually */
  static async createFailedDistributionCase(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      requireAdmin(req);
      const { distributionId, failureReason, failureMetadata } = req.body;
      const data = await RecoveryService.createFailedDistributionCase(distributionId, failureReason, failureMetadata);
      res.status(201).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
}
