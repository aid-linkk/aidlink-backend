import { Response, NextFunction } from 'express';
import { BulkBeneficiaryService } from '../services/bulkBeneficiary.service';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import { BatchJobType } from '@prisma/client';

export class BulkBeneficiaryController {

    /**
     * POST /api/v1/beneficiaries/bulk/import
     * Upload a CSV file to create beneficiaries in bulk.
     */
    static async importCSV(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);
            if (!req.file) throw AppError.from('BATCH_003');

            const result = await BulkBeneficiaryService.importFromCSV(req.file.buffer, req.user.id);

            res.status(202).json({
                success: true,
                data: result,
                message: `Import complete: ${result.successCount} created, ${result.failureCount} failed`,
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v1/beneficiaries/bulk/import/template
     * Download a CSV template for bulk import.
     */
    static async getImportTemplate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const csv = BulkBeneficiaryService.getImportTemplate();
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="beneficiary-import-template.csv"');
            res.send(csv);
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v1/beneficiaries/bulk/status
     * Batch update beneficiary statuses.
     */
    static async batchStatusUpdate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);

            const result = await BulkBeneficiaryService.batchStatusUpdate(req.body.items, req.user.id);

            res.status(202).json({
                success: true,
                data: result,
                message: `Status update complete: ${result.successCount} updated, ${result.failureCount} failed`,
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v1/beneficiaries/bulk/kyc
     * Bulk KYC submission for multiple beneficiaries.
     */
    static async bulkKYCSubmit(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);

            const result = await BulkBeneficiaryService.bulkKYCSubmit(req.body.items, req.user.id);

            res.status(202).json({
                success: true,
                data: result,
                message: `KYC bulk submit complete: ${result.successCount} submitted, ${result.failureCount} failed`,
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v1/beneficiaries/bulk/distributions
     * Batch create distributions for a campaign.
     */
    static async batchCreateDistributions(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);

            const { campaignId, items } = req.body;
            const result = await BulkBeneficiaryService.batchCreateDistributions(
                campaignId,
                items,
                req.user.id
            );

            res.status(202).json({
                success: true,
                data: result,
                message: `Batch distributions complete: ${result.successCount} created, ${result.failureCount} failed`,
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v1/beneficiaries/bulk/notify
     * Send bulk notifications/communications to beneficiaries.
     */
    static async bulkNotify(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);

            const result = await BulkBeneficiaryService.bulkSendNotifications(req.body.items, req.user.id);

            res.status(202).json({
                success: true,
                data: result,
                message: `Bulk notification complete: ${result.successCount} sent, ${result.failureCount} failed`,
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v1/beneficiaries/bulk/jobs
     * List batch jobs for the authenticated actor.
     */
    static async listJobs(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);

            const page = req.query.page ? parseInt(req.query.page as string) : 1;
            const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
            const type = req.query.type as BatchJobType | undefined;

            const result = await BulkBeneficiaryService.listJobs(req.user.id, type, page, limit);

            res.status(200).json({
                success: true,
                ...result,
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v1/beneficiaries/bulk/jobs/:jobId
     * Get batch job status and progress.
     */
    static async getJobStatus(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);

            const job = await BulkBeneficiaryService.getJobStatus(req.params.jobId);

            res.status(200).json({
                success: true,
                data: job,
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v1/beneficiaries/bulk/jobs/:jobId/rollback
     * Rollback a completed or partial batch job.
     */
    static async rollbackJob(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);

            const result = await BulkBeneficiaryService.rollbackJob(req.params.jobId, req.user.id);

            res.status(200).json({
                success: true,
                data: result,
                message: `Rollback complete: ${result.rolledBack} records reverted`,
            });
        } catch (error) {
            next(error);
        }
    }
}
