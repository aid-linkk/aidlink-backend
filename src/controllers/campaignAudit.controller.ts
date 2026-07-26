import { Response, NextFunction } from 'express';
import { CampaignAuditService } from '../services/campaignAudit.service';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import { AuditAction } from '@prisma/client';

export class CampaignAuditController {
    /**
     * GET /api/v1/campaigns/:id/audit-log
     *
     * Returns paginated audit trail for a campaign. Accessible by:
     *   - The campaign owner
     *   - ADMIN role
     *   - AUDITOR role
     *
     * Query params:
     *   page, limit, action, entityType, actorId, startDate, endDate
     */
    static async getAuditLog(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);

            const campaignId = req.params.id;

            const filters = {
                page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
                limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 25,
                action: req.query.action as AuditAction | undefined,
                entityType: req.query.entityType as string | undefined,
                actorId: req.query.actorId as string | undefined,
                startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
                endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
            };

            const result = await CampaignAuditService.getCampaignAuditLog(
                campaignId,
                req.user.id,
                req.user.role,
                filters
            );

            res.status(200).json({
                success: true,
                ...result,
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v1/campaigns/:id/audit-log/:entryId
     *
     * Fetch a single audit log entry by ID. Same access rules as list.
     */
    static async getAuditEntry(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);

            const entry = await CampaignAuditService.getAuditEntry(
                req.params.entryId,
                req.user.id,
                req.user.role
            );

            res.status(200).json({
                success: true,
                data: entry,
            });
        } catch (error) {
            next(error);
        }
    }
}
