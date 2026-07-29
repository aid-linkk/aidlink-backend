import { Response, NextFunction } from 'express';
import { BeneficiaryPortalService } from '../services/beneficiaryPortal.service';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import { DistributionStatus } from '@prisma/client';

export class BeneficiaryPortalController {

    /**
     * GET /api/v1/beneficiaries/portal/profile
     * Full self-service profile with KYC summary + distribution totals.
     */
    static async getProfile(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);
            const data = await BeneficiaryPortalService.getMyProfile(req.user.id);
            res.status(200).json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    /**
     * PATCH /api/v1/beneficiaries/portal/profile
     * Update mutable contact/needs fields. Identity fields are immutable.
     */
    static async updateProfile(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);
            const data = await BeneficiaryPortalService.updateProfile(req.user.id, req.body);
            res.status(200).json({ success: true, data, message: 'Profile updated successfully' });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v1/beneficiaries/portal/verification
     * KYC status, latest submission details, and whether a new submission is allowed.
     */
    static async getVerificationStatus(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);
            const data = await BeneficiaryPortalService.getVerificationStatus(req.user.id);
            res.status(200).json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v1/beneficiaries/portal/kyc/document
     * Upload KYC document (identity doc or selfie). Multipart form — field `file`.
     * Query param ?field=selfie to target selfie; default is primary document.
     */
    static async uploadKYCDocument(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);
            if (!req.file?.buffer) throw new AppError('No file attached', 400);

            const field = req.query.field === 'selfie' ? 'selfie' : 'document';

            const data = await BeneficiaryPortalService.uploadKYCDocument(
                req.user.id,
                req.file.buffer,
                field,
                {
                    documentType: req.body.documentType ?? 'GOVERNMENT_ID',
                    submissionType: req.body.submissionType ?? 'INDIVIDUAL',
                    ipAddress: req.ip ?? undefined,
                    userAgent: req.get('user-agent') ?? undefined,
                    deviceFingerprint: req.body.deviceFingerprint,
                }
            );

            res.status(201).json({
                success: true,
                data,
                message: field === 'document'
                    ? 'KYC document uploaded. Your submission is now pending review.'
                    : 'Selfie uploaded to your active KYC submission.',
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v1/beneficiaries/portal/campaigns
     * Campaigns the beneficiary is currently assigned to.
     */
    static async getMyCampaigns(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);
            const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
            const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
            const data = await BeneficiaryPortalService.getMyCampaigns(req.user.id, page, limit);
            res.status(200).json({ success: true, ...data });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v1/beneficiaries/portal/distributions
     * All distributions received, with per-currency aggregate summary.
     * Optional query param: ?status=COMPLETED|PENDING|FAILED etc.
     */
    static async getMyDistributions(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);
            const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
            const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
            const statusFilter = req.query.status as DistributionStatus | undefined;
            const data = await BeneficiaryPortalService.getMyDistributions(
                req.user.id, page, limit, statusFilter
            );
            res.status(200).json({ success: true, ...data });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v1/beneficiaries/portal/support
     * Submit a support ticket. Sends confirmation to beneficiary + alert to support team.
     */
    static async contactSupport(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);
            const data = await BeneficiaryPortalService.contactSupport(req.user.id, req.body);
            res.status(201).json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }
}
