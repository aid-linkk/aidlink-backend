import prisma from '../config/database';
import { BeneficiaryInput, BeneficiaryFilters, PaginatedResponse } from '../types';
import { BeneficiaryStatus, Role, KYCStatus, AuditAction } from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { Queue } from 'bullmq';
import { config } from '../config';
import { dispatchWebhookEvent } from '../controllers/webhook.controller';
import { getOrSet, invalidateBeneficiaryCache, buildKey } from '../utils/cache';
import { assessFraud, getThirdPartyFraudScore, createFraudLabel } from './kycFraud.service';
import { writeAuditLog } from './audit.service';

// KYC queue instance
const kycQueue = new Queue('kyc-queue', {
  connection: {
    host: config.bullmq.redisHost,
    port: config.bullmq.redisPort,
    password: config.bullmq.redisPassword,
  },
});

async function enqueueKYCJob(type: string, data: Record<string, unknown>): Promise<void> {
  await kycQueue.add(type, { type, data });
  logger.info(`KYC job enqueued: ${type}`, data);
}

export class BeneficiaryService {
  static async createBeneficiary(data: BeneficiaryInput, userId: string): Promise<any> {
    // Check if user already has a beneficiary profile
    const existing = await prisma.beneficiary.findUnique({
      where: { userId },
    });

    if (existing) {
      throw AppError.from('BENEFICIARY_002');
    }

    const beneficiary = await prisma.beneficiary.create({
      data: {
        ...data,
        userId,
        status: BeneficiaryStatus.PENDING,
      },
    });

    logger.info(`Beneficiary created: ${beneficiary.id} for user ${userId}`);

    return beneficiary;
  }

  static async getBeneficiaries(filters: BeneficiaryFilters, pagination: any): Promise<PaginatedResponse<any>> {
    const { page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = pagination;

    const cacheKey = buildKey('beneficiaries', `list:${JSON.stringify({ filters, page, limit, sortBy, sortOrder })}`);

    return getOrSet(cacheKey, 600, async () => {
      const skip = (page - 1) * limit;

      const where: any = {};

      if (filters.status) {
        where.status = filters.status;
      }

      if (filters.country) {
        where.country = filters.country;
      }

      if (filters.city) {
        where.city = filters.city;
      }

      if (filters.riskScore !== undefined) {
        where.riskScore = { lte: filters.riskScore };
      }

      if (filters.search) {
        where.OR = [
          { firstName: { contains: filters.search, mode: 'insensitive' } },
          { lastName: { contains: filters.search, mode: 'insensitive' } },
          { idDocumentNumber: { contains: filters.search, mode: 'insensitive' } },
        ];
      }

      const [beneficiaries, total] = await Promise.all([
        prisma.beneficiary.findMany({
          where,
          skip,
          take: limit,
          orderBy: { [sortBy]: sortOrder },
          include: {
            user: {
              select: {
                id: true,
                email: true,
                status: true,
              },
            },
            _count: {
              select: {
                assignments: true,
                distributions: true,
              },
            },
          },
        }),
        prisma.beneficiary.count({ where }),
      ]);

      return {
        data: beneficiaries,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    });
  }
  static async getBeneficiaryById(id: string): Promise<any> {
    const beneficiary = await prisma.beneficiary.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            status: true,
          },
        },
        assignments: {
          include: {
            campaign: {
              select: {
                id: true,
                title: true,
                status: true,
              },
            },
          },
        },
        distributions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        kycSubmissions: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });

    if (!beneficiary) {
      throw AppError.from('BENEFICIARY_001');
    }

    return beneficiary;
  }

  static async updateBeneficiary(id: string, data: Partial<BeneficiaryInput>, userId: string, userRole: Role): Promise<any> {
    const beneficiary = await prisma.beneficiary.findUnique({
      where: { id },
    });

    if (!beneficiary) {
      throw AppError.from('BENEFICIARY_001');
    }

    // Check permissions
    if (beneficiary.userId !== userId && userRole !== Role.ADMIN && userRole !== Role.VERIFIER) {
      throw AppError.from('COMMON_001', 'You do not have permission to update this beneficiary');
    }

    const updated = await prisma.beneficiary.update({
      where: { id },
      data,
    });

    logger.info(`Beneficiary updated: ${id} by user ${userId}`);

    await invalidateBeneficiaryCache(id);

    return updated;
  }

  static async updateBeneficiaryStatus(id: string, status: BeneficiaryStatus, userId: string, userRole: Role): Promise<any> {
    const beneficiary = await prisma.beneficiary.findUnique({
      where: { id },
    });

    if (!beneficiary) {
      throw AppError.from('BENEFICIARY_001');
    }

    // Check permissions
    if (userRole !== Role.ADMIN && userRole !== Role.VERIFIER) {
      throw AppError.from('COMMON_001', 'You do not have permission to update beneficiary status');
    }

    const updated = await prisma.beneficiary.update({
      where: { id },
      data: {
        status,
        verifiedAt: status === BeneficiaryStatus.VERIFIED ? new Date() : null,
        verifiedBy: status === BeneficiaryStatus.VERIFIED ? userId : null,
      },
    });

    logger.info(`Beneficiary status updated: ${id} to ${status} by user ${userId}`);

    return updated;
  }

  static async calculateRiskScore(beneficiaryId: string): Promise<number> {
    const beneficiary = await prisma.beneficiary.findUnique({
      where: { id: beneficiaryId },
      include: {
        kycSubmissions: {
          where: {
            status: {
              in: [KYCStatus.REJECTED, KYCStatus.EXPIRED],
            },
          },
        },
      },
    });

    if (!beneficiary) {
      throw AppError.from('BENEFICIARY_001');
    }

    let riskScore = 0;

    // Risk factors
    if (beneficiary.kycSubmissions.length > 2) {
      riskScore += 20;
    }

    if (beneficiary.familySize > 10) {
      riskScore += 10;
    }

    // Additional risk factors can be added here

    const updated = await prisma.beneficiary.update({
      where: { id: beneficiaryId },
      data: { riskScore },
    });

    return updated.riskScore;
  }

  static async submitKYC(beneficiaryId: string, data: any, userId: string): Promise<any> {
    const beneficiary = await prisma.beneficiary.findUnique({
      where: { id: beneficiaryId },
    });

    if (!beneficiary) {
      throw AppError.from('BENEFICIARY_001');
    }

    if (beneficiary.userId !== userId) {
      throw AppError.from('COMMON_001', 'You can only submit KYC for your own profile');
    }

    // Prevent duplicate active submissions
    const activeSubmission = await prisma.kYCSubmission.findFirst({
      where: {
        beneficiaryId,
        status: { in: [KYCStatus.PENDING, KYCStatus.UNDER_REVIEW] },
      },
    });

    if (activeSubmission) {
      throw AppError.from('BENEFICIARY_003');
    }

    const submission = await prisma.kYCSubmission.create({
      data: {
        userId,
        beneficiaryId,
        ...data,
        status: KYCStatus.PENDING,
      },
    });

    logger.info(`KYC submitted: ${submission.id} for beneficiary ${beneficiaryId}`);

    // Enqueue background jobs for async processing
    await enqueueKYCJob('CALCULATE_RISK_SCORE', { beneficiaryId });
    await enqueueKYCJob('AUTO_REVIEW_KYC', {
      beneficiaryId,
      submissionId: submission.id,
      systemUserId: userId,
    });

    return submission;
  }

  static async reviewKYC(
    submissionId: string,
    status: KYCStatus,
    reviewNotes: string,
    userId: string,
    userRole: Role
  ): Promise<any> {
    const submission = await prisma.kYCSubmission.findUnique({
      where: { id: submissionId },
      include: { beneficiary: true },
    });

    if (!submission) {
      throw AppError.from('BENEFICIARY_004');
    }

    if (userRole !== Role.ADMIN && userRole !== Role.VERIFIER) {
      throw AppError.from('COMMON_001', 'You do not have permission to review KYC submissions');
    }

    // Compute fraud score and signals before persisting
    const fraudAssessment = await BeneficiaryService.computeFraudScore(submission);

    const updated = await prisma.$transaction(async (tx: any) => {
      const updatedSubmission = await tx.kYCSubmission.update({
        where: { id: submissionId },
        data: {
          status,
          reviewNotes,
          reviewedBy: userId,
          reviewedAt: new Date(),
          fraudScore: fraudAssessment.fraudScore,
          fraudSignals: fraudAssessment.fraudSignals,
          fraudReason: fraudAssessment.fraudReason,
        },
      });

      // Status transition mapping
      if (status === KYCStatus.APPROVED && submission.beneficiary) {
        await tx.beneficiary.update({
          where: { id: submission.beneficiaryId! },
          data: {
            status: BeneficiaryStatus.VERIFIED,
            verifiedAt: new Date(),
            verifiedBy: userId,
          },
        });
      } else if (status === KYCStatus.REJECTED && submission.beneficiary) {
        await tx.beneficiary.update({
          where: { id: submission.beneficiaryId! },
          data: { status: BeneficiaryStatus.REJECTED },
        });
      } else if (status === KYCStatus.EXPIRED && submission.beneficiary) {
        // Reset to PENDING so beneficiary can re-submit
        await tx.beneficiary.update({
          where: { id: submission.beneficiaryId! },
          data: { status: BeneficiaryStatus.PENDING },
        });
      }

      return updatedSubmission;
    });

    // Enqueue fraud detection for high-risk submissions
    if (fraudAssessment.fraudScore > 50) {
      await enqueueKYCJob('FRAUD_DETECTION', {
        beneficiaryId: submission.beneficiaryId,
        submissionId,
        fraudScore: fraudAssessment.fraudScore,
      });
    }

    logger.info(`KYC reviewed: ${submissionId} with status ${status} by user ${userId}, fraudScore: ${fraudAssessment.fraudScore}`);

    dispatchWebhookEvent('KYC_STATUS_CHANGED', {
      submissionId,
      beneficiaryId: submission.beneficiaryId,
      userId: submission.userId,
      status,
      fraudScore: fraudAssessment.fraudScore,
    }).catch((err) => logger.error('Webhook dispatch error (kyc.status_changed):', err));

    // Create fraud label for feedback loop when status transitions to APPROVED or REJECTED
    if (status === KYCStatus.APPROVED || status === KYCStatus.REJECTED) {
      await createFraudLabel(submissionId, status, userId, fraudAssessment);
    }

    return updated;
  }

  // ── KYC Expiration Automation ────────────────────────────────────────
  //
  // Called periodically by kyc.worker.ts (see EXPIRE_KYC_SUBMISSIONS job /
  // scheduleKYCExpirationJob). Scans for approved KYC submissions whose
  // validity window has ended and transitions them to EXPIRED. Returns the
  // list of newly-expired submissions so the caller can dispatch beneficiary
  // (and, for high-risk cases, admin/reviewer) notifications — kept out of
  // this service to avoid pulling the notification/email/websocket stack
  // into beneficiary.service's dependency graph.
  //
  // Idempotency: the scan query only ever matches status === APPROVED, so a
  // submission that was already transitioned to EXPIRED (by this job or a
  // concurrent run) is never picked up again. The per-record transaction
  // re-checks status/expiresAt immediately before writing, closing the race
  // window between the scan query and the update — safe to run repeatedly
  // or concurrently without double-processing or duplicate notifications.
  static async expireKYCSubmissions(
    batchSize: number = config.kycExpiration.batchSize
  ): Promise<{
    scanned: number;
    expired: number;
    errors: number;
    expiredSubmissions: Array<{
      id: string;
      userId: string;
      beneficiaryId: string | null;
      expiresAt: Date;
      fraudScore: number;
    }>;
  }> {
    if (!config.kycExpiration.enabled) {
      logger.info('KYC expiration automation disabled; skipping scan');
      return { scanned: 0, expired: 0, errors: 0, expiredSubmissions: [] };
    }

    const now = new Date();
    let scanned = 0;
    let errors = 0;
    let cursor: string | undefined;
    const expiredSubmissions: Array<{
      id: string;
      userId: string;
      beneficiaryId: string | null;
      expiresAt: Date;
      fraudScore: number;
    }> = [];

    // Keyset pagination so a large backlog doesn't require one giant query.
    for (;;) {
      // Eligible = currently APPROVED with a defined, past expiresAt.
      // PENDING/UNDER_REVIEW/REJECTED/already-EXPIRED rows never match.
      const submissions = await prisma.kYCSubmission.findMany({
        where: {
          status: KYCStatus.APPROVED,
          expiresAt: { lte: now },
        },
        take: batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          userId: true,
          beneficiaryId: true,
          expiresAt: true,
          fraudScore: true,
        },
      });

      if (submissions.length === 0) break;

      for (const submission of submissions) {
        scanned += 1;
        try {
          const expiredAt = await this.expireSingleKYCSubmission(submission, now);
          if (expiredAt) {
            expiredSubmissions.push({ ...submission, expiresAt: expiredAt });
          }
        } catch (error) {
          errors += 1;
          logger.error(`KYC expiration failed for submission ${submission.id}:`, error);
        }
      }

      if (submissions.length < batchSize) break;
      cursor = submissions[submissions.length - 1].id;
    }

    logger.info(
      `KYC expiration scan complete: ${scanned} scanned, ${expiredSubmissions.length} expired, ${errors} errors`
    );

    return { scanned, expired: expiredSubmissions.length, errors, expiredSubmissions };
  }

  /**
   * Transitions a single eligible submission to EXPIRED inside a
   * transaction, writes the audit trail entry, and dispatches the
   * KYC_STATUS_CHANGED webhook. Returns the submission's expiresAt on
   * success, or null if it was no longer eligible by the time the
   * transaction ran (already reviewed/expired concurrently) — keeping
   * concurrent/repeated invocations safe and non-duplicating.
   */
  private static async expireSingleKYCSubmission(
    submission: { id: string; userId: string; beneficiaryId: string | null },
    now: Date
  ): Promise<Date | null> {
    const updated = await prisma.$transaction(async (tx: any) => {
      // Re-check immediately before writing to close the race window
      // between the scan query and this transaction.
      const current = await tx.kYCSubmission.findUnique({
        where: { id: submission.id },
        select: { status: true, expiresAt: true },
      });

      if (!current || current.status !== KYCStatus.APPROVED || !current.expiresAt || current.expiresAt > now) {
        return null;
      }

      const expiredSubmission = await tx.kYCSubmission.update({
        where: { id: submission.id },
        data: {
          status: KYCStatus.EXPIRED,
          reviewedAt: now,
          reviewNotes: `Automatically expired: KYC validity window ended on ${current.expiresAt.toISOString()}.`,
        },
      });

      if (submission.beneficiaryId) {
        // Reset to PENDING so the beneficiary can re-submit, mirroring the
        // manual EXPIRED transition in reviewKYC().
        await tx.beneficiary.update({
          where: { id: submission.beneficiaryId },
          data: { status: BeneficiaryStatus.PENDING },
        });
      }

      return expiredSubmission;
    });

    if (!updated) {
      return null;
    }

    await writeAuditLog(
      AuditAction.KYC_EXPIRED,
      'KYCSubmission',
      submission.id,
      undefined,
      {
        previousStatus: KYCStatus.APPROVED,
        newStatus: KYCStatus.EXPIRED,
        expiresAt: updated.expiresAt,
        reason: 'expiresAt <= now (automated scan)',
      }
    );

    dispatchWebhookEvent('KYC_STATUS_CHANGED', {
      submissionId: submission.id,
      beneficiaryId: submission.beneficiaryId,
      userId: submission.userId,
      status: KYCStatus.EXPIRED,
    }).catch((err) => logger.error('Webhook dispatch error (kyc.status_changed / expired):', err));

    logger.info(`KYC submission expired: ${submission.id} (beneficiary ${submission.beneficiaryId ?? 'n/a'})`);

    return updated.expiresAt as Date;
  }

  private static async computeFraudScore(submission: any): Promise<any> {
    const input = {
      submissionId: submission.id,
      beneficiaryId: submission.beneficiaryId,
      userId: submission.userId,
      documentUrl: submission.documentUrl,
      documentType: submission.documentType,
      selfieUrl: submission.selfieUrl,
      additionalDocs: submission.additionalDocs,
      ipAddress: submission.ipAddress,
      userAgent: submission.userAgent,
      claimedCountry: submission.beneficiary?.country,
      claimedCity: submission.beneficiary?.city,
    };

    // Get internal fraud assessment
    const assessment = await assessFraud(input);

    // Attempt third-party enrichment (graceful fallback if unavailable)
    const thirdParty = await getThirdPartyFraudScore(input);
    if (thirdParty && thirdParty.score > 0) {
      // Blend internal and third-party scores (70% internal, 30% third-party)
      assessment.fraudScore = Math.min(
        Math.round(assessment.fraudScore * 0.7 + thirdParty.score * 0.3),
        100,
      );
      assessment.fraudSignals.push(...thirdParty.signals);
      assessment.fraudReason += ' (enriched with third-party data)';
    }

    return assessment;
  }

  static async getBeneficiaryByUserId(userId: string): Promise<any> {
    const beneficiary = await prisma.beneficiary.findUnique({
      where: { userId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            status: true,
          },
        },
        assignments: {
          include: {
            campaign: {
              select: {
                id: true,
                title: true,
                status: true,
              },
            },
          },
        },
        distributions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        kycSubmissions: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });

    if (!beneficiary) {
      throw AppError.from('BENEFICIARY_001', 'Beneficiary profile not found');
    }

    return beneficiary;
  }
}
