import prisma from '../config/database';
import { BeneficiaryInput, BeneficiaryFilters, PaginatedResponse } from '../types';
import { BeneficiaryStatus, Role, KYCStatus } from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { Queue } from 'bullmq';
import { config } from '../config';
import { dispatchWebhookEvent } from '../controllers/webhook.controller';
import { getOrSet, invalidateBeneficiaryCache, buildKey } from '../utils/cache';
import { assessFraud, getThirdPartyFraudScore } from './kycFraud.service';

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
      throw new AppError('Beneficiary profile already exists for this user', 400);
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
      throw new AppError('Beneficiary not found', 404);
    }

    return beneficiary;
  }

  static async updateBeneficiary(id: string, data: Partial<BeneficiaryInput>, userId: string, userRole: Role): Promise<any> {
    const beneficiary = await prisma.beneficiary.findUnique({
      where: { id },
    });

    if (!beneficiary) {
      throw new AppError('Beneficiary not found', 404);
    }

    // Check permissions
    if (beneficiary.userId !== userId && userRole !== Role.ADMIN && userRole !== Role.VERIFIER) {
      throw new AppError('You do not have permission to update this beneficiary', 403);
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
      throw new AppError('Beneficiary not found', 404);
    }

    // Check permissions
    if (userRole !== Role.ADMIN && userRole !== Role.VERIFIER) {
      throw new AppError('You do not have permission to update beneficiary status', 403);
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
      throw new AppError('Beneficiary not found', 404);
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
      throw new AppError('Beneficiary not found', 404);
    }

    if (beneficiary.userId !== userId) {
      throw new AppError('You can only submit KYC for your own profile', 403);
    }

    // Prevent duplicate active submissions
    const activeSubmission = await prisma.kYCSubmission.findFirst({
      where: {
        beneficiaryId,
        status: { in: [KYCStatus.PENDING, KYCStatus.UNDER_REVIEW] },
      },
    });

    if (activeSubmission) {
      throw new AppError('An active KYC submission already exists. Please wait for the current review to complete.', 409);
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
      throw new AppError('KYC submission not found', 404);
    }

    if (userRole !== Role.ADMIN && userRole !== Role.VERIFIER) {
      throw new AppError('You do not have permission to review KYC submissions', 403);
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

    WebhookService.dispatchEventSafely({
      type: 'kyc.status_changed',
      resource: { type: 'kyc_submission', id: updated.id },
      data: {
        submissionId: updated.id,
        beneficiaryId: submission.beneficiaryId,
        userId: submission.userId,
        previousStatus: submission.status,
        status: updated.status,
        reviewedBy: userId,
        reviewedAt: updated.reviewedAt,
        fraudScore,
      },
    });

    return updated;
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
      throw new AppError('Beneficiary profile not found', 404);
    }

    return beneficiary;
  }
}
