import { Response, NextFunction } from 'express';
import { Role, ReceiptEmailStatus } from '@prisma/client';
import prisma from '../config/database';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import { ReceiptService } from '../services/receipt.service';
import { enqueueBatchProcessing } from '../workers/receipt.worker';
import logger from '../config/logger';

export class ReceiptController {

  private static async canAccess(
    user: NonNullable<AuthRequest['user']>,
    receipt: { donorId: string; organizationId: string },
  ): Promise<boolean> {
    if (user.role === Role.ADMIN || user.role === Role.AUDITOR) {
      return true;
    }
    if (receipt.donorId === user.id) {
      return true;
    }
    if (user.role === Role.ORGANIZATION) {
      const org = await prisma.organization.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      return org?.id === receipt.organizationId;
    }
    return false;
  }

  static async downloadDonationReceipt(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const { donationId } = req.params;
      const receipt = await ReceiptService.getReceiptForDonation(donationId);

      if (!receipt) {
        throw new AppError('Receipt not yet generated for this donation', 404);
      }

      if (!(await ReceiptController.canAccess(req.user, receipt))) {
        throw new AppError('You do not have permission to access this receipt', 403);
      }

      let pdf: Buffer;
      try {
        pdf = await ReceiptService.getReceiptPdf(receipt);
      } catch (error) {
        logger.error(`Receipt file missing for ${receipt.id}:`, error);
        throw new AppError('Receipt file is no longer available', 410);
      }

      const filename = `${receipt.receiptNumber}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Accept-Ranges', 'bytes');

      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match) {
          const start = match[1] ? parseInt(match[1], 10) : 0;
          const end = match[2] ? parseInt(match[2], 10) : pdf.length - 1;
          if (start > end || start >= pdf.length) {
            res.setHeader('Content-Range', `bytes */${pdf.length}`);
            res.status(416).end();
            return;
          }
          const chunk = pdf.subarray(start, end + 1);
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${pdf.length}`);
          res.setHeader('Content-Length', chunk.length);
          res.end(chunk);
          return;
        }
      }

      res.setHeader('Content-Length', pdf.length);
      res.status(200).end(pdf);
    } catch (error) {
      next(error);
    }
  }

  static async getDonationReceiptStatus(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const { donationId } = req.params;
      const receipt = await ReceiptService.getReceiptForDonation(donationId);

      if (!receipt) {
        res.status(200).json({
          success: true,
          data: { generated: false, emailSent: false },
        });
        return;
      }

      if (!(await ReceiptController.canAccess(req.user, receipt))) {
        throw new AppError('You do not have permission to access this receipt', 403);
      }

      const fileUrl = await ReceiptService.getSignedDownloadUrl(receipt).catch(() => undefined);

      res.status(200).json({
        success: true,
        data: {
          generated: true,
          generatedAt: receipt.generatedAt,
          emailSent: receipt.emailDeliveryStatus === ReceiptEmailStatus.SENT,
          emailSentAt: receipt.emailSentAt,
          emailDeliveryStatus: receipt.emailDeliveryStatus,
          receiptNumber: receipt.receiptNumber,
          fileUrl,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // ─── Admin ─────────────────────────────────────────────────────

  /** GET /admin/receipts */
  static async listReceipts(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters = {
        organizationId: req.query.organizationId as string | undefined,
        donationId: req.query.donationId as string | undefined,
        donorId: req.query.donorId as string | undefined,
        emailStatus: req.query.emailStatus as ReceiptEmailStatus | undefined,
        dateFrom: req.query.dateFrom ? new Date(req.query.dateFrom as string) : undefined,
        dateTo: req.query.dateTo ? new Date(req.query.dateTo as string) : undefined,
      };
      const pagination = {
        page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
      };

      const result = await ReceiptService.listReceipts(filters, pagination);
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  /** GET /admin/receipts/:receiptId */
  static async getReceiptById(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const receipt = await ReceiptService.getReceiptById(req.params.receiptId);
      res.status(200).json({ success: true, data: receipt });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/receipts/generate-batch */
  static async generateBatch(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const body = req.body as {
        organizationId?: string;
        campaignId?: string;
        donationIds?: string[];
        dateRange?: { from?: string | Date; to?: string | Date };
        region?: string;
      };

      const filter = {
        organizationId: body.organizationId,
        campaignId: body.campaignId,
        donationIds: body.donationIds,
        region: body.region,
        dateRange: body.dateRange
          ? {
              from: body.dateRange.from ? new Date(body.dateRange.from) : undefined,
              to: body.dateRange.to ? new Date(body.dateRange.to) : undefined,
            }
          : undefined,
      };

      const { job, totalMatched } = await ReceiptService.createBatchJob(filter, req.user.id);

      // Kick off async processing; if the queue is unavailable, the job stays
      // PENDING and can be retried.
      await enqueueBatchProcessing(job.id).catch((error) =>
        logger.error(`Failed to enqueue batch processing for job ${job.id}:`, error),
      );

      res.status(202).json({
        success: true,
        data: { jobId: job.id, status: job.status, totalMatched },
      });
    } catch (error) {
      next(error);
    }
  }

  /** GET /admin/receipts/batch-jobs/:jobId */
  static async getBatchJob(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const job = await ReceiptService.getBatchJob(req.params.jobId);
      res.status(200).json({ success: true, data: job });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/receipts/:receiptId/resend-email */
  static async resendEmail(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // Ensure the receipt exists (throws 404 otherwise).
      await ReceiptService.getReceiptById(req.params.receiptId);
      const result = await ReceiptService.sendReceiptEmail(req.params.receiptId);

      res.status(200).json({
        success: true,
        data: { sent: Boolean(result), timestamp: new Date().toISOString() },
      });
    } catch (error) {
      next(error);
    }
  }
}
