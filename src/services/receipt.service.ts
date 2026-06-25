import crypto from 'crypto';
import { DonationStatus, ReceiptEmailStatus, ReceiptBatchJobStatus } from '@prisma/client';
import prisma from '../config/database';
import { config } from '../config';
import logger from '../config/logger';
import { AppError } from '../middleware/error';
import { StorageService } from './storage.service';
import { NotificationService } from './notification.service';
import { EmailTemplateService } from './emailTemplate.service';
import { generateReceiptPdf, ReceiptPdfData } from '../utils/pdf.generator';
import {
  getRegionRequirement,
  resolveRegion,
  formatCurrency,
  RECEIPT_TEMPLATE_VERSION,
} from '../config/receipt.config';

export type ReceiptDeliveryMethod = 'EMAIL' | 'DOWNLOAD' | 'MANUAL' | 'BATCH';

export interface BatchFilter {
  organizationId?: string;
  campaignId?: string;
  donationIds?: string[];
  dateRange?: { from?: Date; to?: Date };
  region?: string;
}

export interface ReceiptListFilters {
  organizationId?: string;
  donationId?: string;
  donorId?: string;
  emailStatus?: ReceiptEmailStatus;
  dateFrom?: Date;
  dateTo?: Date;
}

const donationForReceiptInclude = {
  user: true,
  taxReceipt: true,
  campaign: {
    include: {
      organization: {
        include: { user: { select: { email: true } } },
      },
    },
  },
} as const;

export class ReceiptService {
  /** Generates a unique, human-readable receipt reference number. */
  private static generateReceiptNumber(date = new Date()): string {
    const token = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `RCPT-${date.getUTCFullYear()}-${token}`;
  }

  /** Donor display name derived from the available account fields. */
  private static donorName(user: { username: string | null; email: string }): string {
    return user.username || user.email.split('@')[0];
  }

  private static toPdfData(
    donation: any,
    region: string,
    receiptNumber: string,
    generatedAt: Date,
  ): ReceiptPdfData {
    const org = donation.campaign.organization;
    return {
      receiptNumber,
      donationDate: donation.createdAt,
      generatedAt,
      amount: donation.amount.toString(),
      currency: donation.currency,
      region,
      donor: {
        name: ReceiptService.donorName(donation.user),
        email: donation.user.email,
      },
      organization: {
        name: org.name,
        taxId: org.taxId,
        website: org.website,
        contactEmail: org.user?.email ?? null,
      },
      campaign: { title: donation.campaign.title },
    };
  }

  /**
   * Generates (or returns the existing) tax receipt for a confirmed donation.
   * Idempotent: the unique donationId constraint guarantees a single receipt
   * even under concurrent generation. The PDF is rendered, stored, and a
   * TaxReceipt record is created atomically with the donation flag update.
   */
  static async generateReceipt(
    donationId: string,
    options: { region?: string; deliveryMethod?: ReceiptDeliveryMethod } = {},
  ): Promise<any> {
    const donation = await prisma.donation.findUnique({
      where: { id: donationId },
      include: donationForReceiptInclude,
    });

    if (!donation) {
      throw new AppError('Donation not found', 404);
    }

    if (donation.taxReceipt) {
      return donation.taxReceipt;
    }

    if (donation.status !== DonationStatus.CONFIRMED) {
      throw new AppError('Receipts can only be generated for confirmed donations', 400);
    }

    if (!donation.user || !donation.user.email) {
      throw new AppError(
        'Cannot generate a receipt: donation has no associated donor account',
        422,
      );
    }

    const region = resolveRegion(options.region ?? config.receipts.defaultRegion);
    const requirement = getRegionRequirement(region);
    const generatedAt = new Date();
    const receiptNumber = ReceiptService.generateReceiptNumber(generatedAt);

    const pdf = await generateReceiptPdf(
      ReceiptService.toPdfData(donation, region, receiptNumber, generatedAt),
    );

    const orgId = donation.campaign.organizationId;
    const key = `${config.receipts.storagePrefix}/${orgId}/${donationId}_${generatedAt.getTime()}.pdf`;
    const stored = await StorageService.uploadDocument(key, pdf, 'application/pdf', {
      donationId,
      organizationId: orgId,
    });

    try {
      const receipt = await prisma.$transaction(async (tx) => {
        const created = await tx.taxReceipt.create({
          data: {
            donationId,
            donorId: donation.user!.id,
            organizationId: orgId,
            amount: donation.amount,
            currency: donation.currency,
            donationDate: donation.createdAt,
            receiptNumber,
            filePath: stored.key,
            region,
            taxDeductible: requirement.taxDeductible,
            templateVersion: RECEIPT_TEMPLATE_VERSION,
            generatedAt,
            emailDeliveryStatus: ReceiptEmailStatus.PENDING,
            metadata: {
              language: requirement.language,
              campaignTitle: donation.campaign.title,
              deliveryMethod: options.deliveryMethod ?? 'EMAIL',
            },
          },
        });

        await tx.donation.update({
          where: { id: donationId },
          data: { receiptGeneratedAt: generatedAt },
        });

        return created;
      });

      logger.info(
        `Tax receipt generated: ${receipt.receiptNumber} (donation ${donationId}, region ${region})`,
      );
      return receipt;
    } catch (error: any) {
      if (error?.code === 'P2002') {
        await StorageService.delete(stored.key).catch(() => undefined);
        const existing = await prisma.taxReceipt.findUnique({ where: { donationId } });
        if (existing) {
          return existing;
        }
      }
      await StorageService.delete(stored.key).catch(() => undefined);
      throw error;
    }
  }

  static async getReceiptForDonation(donationId: string): Promise<any | null> {
    return prisma.taxReceipt.findUnique({ where: { donationId } });
  }

  static async getReceiptById(receiptId: string): Promise<any> {
    const receipt = await prisma.taxReceipt.findUnique({
      where: { id: receiptId },
      include: {
        donor: { select: { id: true, email: true, username: true } },
        organization: { select: { id: true, name: true } },
        donation: { select: { id: true, campaignId: true } },
      },
    });

    if (!receipt) {
      throw new AppError('Receipt not found', 404);
    }

    return receipt;
  }

  static async getReceiptPdf(receipt: { filePath: string }): Promise<Buffer> {
    return StorageService.download(receipt.filePath);
  }

  /** Time-limited signed URL for direct download of the receipt PDF. */
  static async getSignedDownloadUrl(receipt: { filePath: string }): Promise<string> {
    return StorageService.getSignedUrl(receipt.filePath, config.receipts.urlExpirySeconds);
  }

  static async sendReceiptEmail(
    receiptId: string,
    options: { throwOnError?: boolean } = {},
  ): Promise<any> {
    const receipt = await prisma.taxReceipt.findUnique({
      where: { id: receiptId },
      include: {
        donor: { select: { email: true, username: true } },
        organization: { select: { name: true } },
      },
    });

    if (!receipt) {
      throw new AppError('Receipt not found', 404);
    }

    try {
      const pdf = await StorageService.download(receipt.filePath);

      const { html, text } = EmailTemplateService.render('receipt', {
        donorName: receipt.donor.username,
        receiptNumber: receipt.receiptNumber,
        amount: receipt.amount.toString(),
        currency: receipt.currency,
        organizationName: receipt.organization.name,
        donationDate: receipt.donationDate.toISOString(),
        downloadLink: `${config.email.appUrl}/receipts/${receipt.id}`,
        donorPortalLink: `${config.email.appUrl}/donor/portal`,
        subject: `Your tax receipt ${receipt.receiptNumber}`,
      });

      await NotificationService.sendEmail(
        receipt.donor.email,
        `Your tax receipt ${receipt.receiptNumber}`,
        html,
        {
          from: config.receipts.senderEmail,
          text,
          attachments: [
            {
              filename: `${receipt.receiptNumber}.pdf`,
              content: pdf,
              contentType: 'application/pdf',
            },
          ],
        },
      );

      const updated = await prisma.taxReceipt.update({
        where: { id: receiptId },
        data: { emailDeliveryStatus: ReceiptEmailStatus.SENT, emailSentAt: new Date() },
      });

      logger.info(`Receipt email sent: ${receipt.receiptNumber} -> ${receipt.donor.email}`);
      return updated;
    } catch (error) {
      logger.error(`Failed to send receipt email for ${receiptId}:`, error);
      await prisma.taxReceipt
        .update({
          where: { id: receiptId },
          data: { emailDeliveryStatus: ReceiptEmailStatus.FAILED },
        })
        .catch(() => undefined);
      if (options.throwOnError) {
        throw error;
      }
      return null;
    }
  }

  // ─── Batch generation ──────────────────────────────────────────

  private static batchWhere(filter: BatchFilter): any {
    const where: any = {
      status: DonationStatus.CONFIRMED,
      userId: { not: null },
      taxReceipt: { is: null },
    };

    if (filter.donationIds && filter.donationIds.length > 0) {
      where.id = { in: filter.donationIds };
    }
    if (filter.campaignId) {
      where.campaignId = filter.campaignId;
    }
    if (filter.organizationId) {
      where.campaign = { organizationId: filter.organizationId };
    }
    if (filter.dateRange?.from || filter.dateRange?.to) {
      where.createdAt = {};
      if (filter.dateRange.from) where.createdAt.gte = filter.dateRange.from;
      if (filter.dateRange.to) where.createdAt.lte = filter.dateRange.to;
    }

    return where;
  }

  /**
   * Creates a batch job record for the matching donations and returns it along
   * with the matched count. The heavy lifting is done asynchronously by
   * {@link processBatchJob}.
   */
  static async createBatchJob(
    filter: BatchFilter,
    createdBy: string,
  ): Promise<{ job: any; totalMatched: number }> {
    const where = ReceiptService.batchWhere(filter);
    const matched = await prisma.donation.count({ where });
    const totalMatched = Math.min(matched, config.receipts.maxBatchSize);

    const job = await prisma.receiptBatchJob.create({
      data: {
        organizationId: filter.organizationId ?? null,
        createdBy,
        status: ReceiptBatchJobStatus.PENDING,
        totalCount: totalMatched,
        jobMetadata: {
          filter: {
            organizationId: filter.organizationId,
            campaignId: filter.campaignId,
            donationIds: filter.donationIds,
            dateRange: filter.dateRange
              ? {
                  from: filter.dateRange.from?.toISOString(),
                  to: filter.dateRange.to?.toISOString(),
                }
              : undefined,
            region: filter.region,
          },
        },
      },
    });

    logger.info(`Receipt batch job created: ${job.id} (${totalMatched} matched)`);
    return { job, totalMatched };
  }

  /** Reconstructs the {@link BatchFilter} stored on a job record. */
  private static filterFromJob(job: any): BatchFilter {
    const stored = (job.jobMetadata?.filter ?? {}) as any;
    return {
      organizationId: stored.organizationId,
      campaignId: stored.campaignId,
      donationIds: stored.donationIds,
      region: stored.region,
      dateRange: stored.dateRange
        ? {
            from: stored.dateRange.from ? new Date(stored.dateRange.from) : undefined,
            to: stored.dateRange.to ? new Date(stored.dateRange.to) : undefined,
          }
        : undefined,
    };
  }

  static async processBatchJob(jobId: string): Promise<any> {
    const job = await prisma.receiptBatchJob.findUnique({ where: { id: jobId } });
    if (!job) {
      throw new AppError('Batch job not found', 404);
    }

    await prisma.receiptBatchJob.update({
      where: { id: jobId },
      data: { status: ReceiptBatchJobStatus.PROCESSING },
    });

    const filter = ReceiptService.filterFromJob(job);
    const where = ReceiptService.batchWhere(filter);

    let generatedCount = 0;
    let failedCount = 0;

    try {
      const donations = await prisma.donation.findMany({
        where,
        select: { id: true },
        take: config.receipts.maxBatchSize,
        orderBy: { createdAt: 'asc' },
      });

      for (const { id } of donations) {
        try {
          const receipt = await ReceiptService.generateReceipt(id, {
            region: filter.region,
            deliveryMethod: 'BATCH',
          });
          generatedCount += 1;
          await ReceiptService.sendReceiptEmail(receipt.id).catch(() => undefined);
        } catch (error) {
          failedCount += 1;
          logger.error(`Batch ${jobId}: failed to generate receipt for donation ${id}:`, error);
        }

        // Persist progress incrementally so the status endpoint stays live.
        await prisma.receiptBatchJob
          .update({
            where: { id: jobId },
            data: { generatedCount, failedCount },
          })
          .catch(() => undefined);
      }

      const completed = await prisma.receiptBatchJob.update({
        where: { id: jobId },
        data: {
          status: ReceiptBatchJobStatus.COMPLETED,
          generatedCount,
          failedCount,
          completedAt: new Date(),
        },
      });

      logger.info(
        `Receipt batch job completed: ${jobId} (generated ${generatedCount}, failed ${failedCount})`,
      );
      return completed;
    } catch (error) {
      logger.error(`Receipt batch job failed: ${jobId}:`, error);
      return prisma.receiptBatchJob.update({
        where: { id: jobId },
        data: {
          status: ReceiptBatchJobStatus.FAILED,
          generatedCount,
          failedCount,
          completedAt: new Date(),
        },
      });
    }
  }

  static async getBatchJob(jobId: string): Promise<any> {
    const job = await prisma.receiptBatchJob.findUnique({ where: { id: jobId } });
    if (!job) {
      throw new AppError('Batch job not found', 404);
    }

    const total = job.totalCount || 0;
    const processed = job.generatedCount + job.failedCount;
    const progress = total > 0 ? Math.round((processed / total) * 100) : 0;

    return {
      id: job.id,
      status: job.status,
      progress,
      totalCount: job.totalCount,
      generatedCount: job.generatedCount,
      failedCount: job.failedCount,
      organizationId: job.organizationId,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    };
  }

  // ─── Admin queries ─────────────────────────────────────────────

  static async listReceipts(
    filters: ReceiptListFilters,
    pagination: { page?: number; limit?: number } = {},
  ): Promise<any> {
    const page = Math.max(1, pagination.page ?? 1);
    const limit = Math.min(100, Math.max(1, pagination.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filters.organizationId) where.organizationId = filters.organizationId;
    if (filters.donationId) where.donationId = filters.donationId;
    if (filters.donorId) where.donorId = filters.donorId;
    if (filters.emailStatus) where.emailDeliveryStatus = filters.emailStatus;
    if (filters.dateFrom || filters.dateTo) {
      where.donationDate = {};
      if (filters.dateFrom) where.donationDate.gte = filters.dateFrom;
      if (filters.dateTo) where.donationDate.lte = filters.dateTo;
    }

    const [data, total] = await prisma.$transaction([
      prisma.taxReceipt.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          donor: { select: { id: true, email: true, username: true } },
          organization: { select: { id: true, name: true } },
        },
      }),
      prisma.taxReceipt.count({ where }),
    ]);

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
