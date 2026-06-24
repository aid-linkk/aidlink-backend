import prisma from '../config/database';
import {
  MilestoneSubmissionStatus,
  MilestoneVerificationStatus,
  MilestoneVerificationEvent,
  ReviewDecision,
  AuditAction,
  Role,
  Prisma,
} from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { NotificationService } from './notification.service';
import { broadcastToUser, broadcastToCampaign } from '../websocket/socket.server';

export interface SubmissionInput {
  description: string;
  evidenceUrls: string[];
  metricsData: Record<string, unknown>;
  submissionNotes?: string;
}

export interface ReviewInput {
  decision: ReviewDecision;
  reason?: string;
  verifierNotes?: string;
  metricsConfirmed?: Record<string, unknown>;
  impactSummary?: string;
}

export interface AdminSubmissionFilters {
  status?: MilestoneSubmissionStatus;
  campaignId?: string;
  verifierId?: string;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  limit?: number;
}

export class MilestoneService {
  private static async writeAuditLog(
    userId: string,
    action: AuditAction,
    entityId: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: { userId, action, entityType: 'MilestoneSubmission', entityId, metadata: metadata as Prisma.InputJsonValue },
      });
    } catch (err) {
      logger.error('Failed to write milestone audit log:', err);
    }
  }

  private static async recordHistory(
    submissionId: string,
    event: MilestoneVerificationEvent,
    actor: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await prisma.milestoneVerificationHistory.create({
      data: { submissionId, event, actor, metadata: metadata as Prisma.InputJsonValue },
    });
  }

  static async createSubmission(
    campaignId: string,
    milestoneId: string,
    userId: string,
    data: SubmissionInput
  ) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { organization: true },
    });

    if (!campaign) throw new AppError('Campaign not found', 404);
    if (campaign.userId !== userId) {
      throw new AppError('You do not own this campaign', 403);
    }

    const milestone = await prisma.milestone.findFirst({
      where: { id: milestoneId, campaignId },
    });

    if (!milestone) throw new AppError('Milestone not found in this campaign', 404);

    const active = await prisma.milestoneSubmission.findFirst({
      where: {
        milestoneId,
        status: { in: [MilestoneSubmissionStatus.SUBMITTED, MilestoneSubmissionStatus.UNDER_REVIEW, MilestoneSubmissionStatus.APPROVED] },
      },
    });

    if (active) {
      throw new AppError(
        'An active submission already exists for this milestone',
        409
      );
    }

    const submission = await prisma.milestoneSubmission.create({
      data: {
        campaignId,
        milestoneId,
        organizationId: campaign.organizationId,
        description: data.description,
        evidenceUrls: data.evidenceUrls,
        metricsData: data.metricsData as Prisma.InputJsonValue,
        submissionNotes: data.submissionNotes,
        status: MilestoneSubmissionStatus.DRAFT,
      },
    });

    await prisma.milestone.update({
      where: { id: milestoneId },
      data: { currentSubmissionId: submission.id },
    });

    logger.info(`Milestone submission created: ${submission.id} for milestone ${milestoneId}`);
    return submission;
  }

  static async updateSubmission(
    submissionId: string,
    userId: string,
    data: Partial<SubmissionInput>
  ) {
    const submission = await prisma.milestoneSubmission.findUnique({
      where: { id: submissionId },
      include: { milestone: { include: { campaign: true } } },
    });

    if (!submission) throw new AppError('Submission not found', 404);
    if (submission.milestone.campaign.userId !== userId) {
      throw new AppError('You do not own this submission', 403);
    }

    const editableStatuses: MilestoneSubmissionStatus[] = [
      MilestoneSubmissionStatus.DRAFT,
      MilestoneSubmissionStatus.REVISION_REQUESTED,
    ];

    if (!editableStatuses.includes(submission.status)) {
      throw new AppError(
        `Cannot edit a submission with status ${submission.status}`,
        400
      );
    }

    return prisma.milestoneSubmission.update({
      where: { id: submissionId },
      data: {
        ...(data.description !== undefined && { description: data.description }),
        ...(data.evidenceUrls !== undefined && { evidenceUrls: data.evidenceUrls }),
        ...(data.metricsData !== undefined && { metricsData: data.metricsData as Prisma.InputJsonValue }),
        ...(data.submissionNotes !== undefined && { submissionNotes: data.submissionNotes }),
      },
    });
  }

  static async submitForReview(submissionId: string, userId: string) {
    const submission = await prisma.milestoneSubmission.findUnique({
      where: { id: submissionId },
      include: { milestone: { include: { campaign: { include: { organization: true } } } } },
    });

    if (!submission) throw new AppError('Submission not found', 404);
    if (submission.milestone.campaign.userId !== userId) {
      throw new AppError('You do not own this submission', 403);
    }

    const submitableStatuses: MilestoneSubmissionStatus[] = [
      MilestoneSubmissionStatus.DRAFT,
      MilestoneSubmissionStatus.REVISION_REQUESTED,
    ];

    if (!submitableStatuses.includes(submission.status)) {
      throw new AppError(
        `Cannot submit a submission with status ${submission.status}`,
        400
      );
    }

    const isResubmission = submission.status === MilestoneSubmissionStatus.REVISION_REQUESTED;

    const updated = await prisma.milestoneSubmission.update({
      where: { id: submissionId },
      data: {
        status: MilestoneSubmissionStatus.SUBMITTED,
        submittedAt: new Date(),
      },
    });

    await prisma.milestone.update({
      where: { id: submission.milestoneId },
      data: { verificationStatus: MilestoneVerificationStatus.SUBMITTED },
    });

    const historyEvent = isResubmission
      ? MilestoneVerificationEvent.RESUBMITTED
      : MilestoneVerificationEvent.SUBMITTED;

    await this.recordHistory(submissionId, historyEvent, userId);

    const verifiers = await prisma.user.findMany({
      where: { role: { in: [Role.VERIFIER, Role.ADMIN] }, status: 'ACTIVE' },
      select: { id: true },
    });

    const campaignTitle = submission.milestone.campaign.title;
    const milestoneTitle = submission.milestone.title;

    await Promise.allSettled(
      verifiers.map((v) =>
        NotificationService.sendMilestoneSubmissionReceivedNotification(
          v.id,
          campaignTitle,
          milestoneTitle,
          submissionId
        )
      )
    );

    broadcastToCampaign(submission.campaignId, 'milestone:submitted', {
      submissionId,
      milestoneId: submission.milestoneId,
      campaignId: submission.campaignId,
    });

    await this.writeAuditLog(userId, AuditAction.MILESTONE_SUBMITTED, submissionId, {
      milestoneId: submission.milestoneId,
      campaignId: submission.campaignId,
      isResubmission,
    });

    logger.info(`Milestone submission ${submissionId} submitted for review`);
    return updated;
  }

  static async getSubmission(submissionId: string, requesterId?: string, requesterRole?: string) {
    const submission = await prisma.milestoneSubmission.findUnique({
      where: { id: submissionId },
      include: {
        reviews: { orderBy: { createdAt: 'desc' } },
        history: { orderBy: { timestamp: 'asc' } },
        milestone: { include: { campaign: true } },
      },
    });

    if (!submission) throw new AppError('Submission not found', 404);

    if (requesterId && requesterRole) {
      const isAdminOrVerifier = ([Role.ADMIN, Role.VERIFIER, Role.AUDITOR] as Role[]).includes(requesterRole as Role);
      if (!isAdminOrVerifier && submission.milestone.campaign.userId !== requesterId) {
        throw new AppError('Forbidden', 403);
      }
    }

    return submission;
  }

  static async listSubmissions(milestoneId: string, campaignId: string, requesterId?: string, requesterRole?: string) {
    const milestone = await prisma.milestone.findFirst({
      where: { id: milestoneId, campaignId },
      include: { campaign: true },
    });

    if (!milestone) throw new AppError('Milestone not found in this campaign', 404);

    if (requesterId && requesterRole) {
      const isAdminOrVerifier = ([Role.ADMIN, Role.VERIFIER, Role.AUDITOR] as Role[]).includes(requesterRole as Role);
      if (!isAdminOrVerifier && milestone.campaign.userId !== requesterId) {
        throw new AppError('Forbidden', 403);
      }
    }

    return prisma.milestoneSubmission.findMany({
      where: { milestoneId, campaignId },
      include: {
        reviews: { orderBy: { createdAt: 'desc' }, take: 1 },
        history: { orderBy: { timestamp: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async createReview(
    submissionId: string,
    verifierId: string,
    data: ReviewInput
  ) {
    const submission = await prisma.milestoneSubmission.findUnique({
      where: { id: submissionId },
      include: { milestone: { include: { campaign: { include: { organization: true, user: true } } } } },
    });

    if (!submission) throw new AppError('Submission not found', 404);

    const reviewableStatuses: MilestoneSubmissionStatus[] = [
      MilestoneSubmissionStatus.SUBMITTED,
      MilestoneSubmissionStatus.UNDER_REVIEW,
    ];

    if (!reviewableStatuses.includes(submission.status)) {
      throw new AppError(
        `Cannot review a submission with status ${submission.status}`,
        400
      );
    }

    const nextSubmissionStatus: Record<ReviewDecision, MilestoneSubmissionStatus> = {
      [ReviewDecision.APPROVED]: MilestoneSubmissionStatus.APPROVED,
      [ReviewDecision.REJECTED]: MilestoneSubmissionStatus.REJECTED,
      [ReviewDecision.REVISION_REQUESTED]: MilestoneSubmissionStatus.REVISION_REQUESTED,
    };

    const nextMilestoneStatus: Record<ReviewDecision, MilestoneVerificationStatus> = {
      [ReviewDecision.APPROVED]: MilestoneVerificationStatus.VERIFIED,
      [ReviewDecision.REJECTED]: MilestoneVerificationStatus.REJECTED,
      [ReviewDecision.REVISION_REQUESTED]: MilestoneVerificationStatus.SUBMITTED,
    };

    const historyEventMap: Record<ReviewDecision, MilestoneVerificationEvent> = {
      [ReviewDecision.APPROVED]: MilestoneVerificationEvent.APPROVED,
      [ReviewDecision.REJECTED]: MilestoneVerificationEvent.REJECTED,
      [ReviewDecision.REVISION_REQUESTED]: MilestoneVerificationEvent.REVISION_REQUESTED,
    };

    const review = await prisma.$transaction(async (tx) => {
      if (submission.status === MilestoneSubmissionStatus.SUBMITTED) {
        await tx.milestoneSubmission.update({
          where: { id: submissionId },
          data: { status: MilestoneSubmissionStatus.UNDER_REVIEW },
        });
        await tx.milestoneVerificationHistory.create({
          data: {
            submissionId,
            event: MilestoneVerificationEvent.REVIEW_STARTED,
            actor: verifierId,
          },
        });
      }

      const created = await tx.milestoneReview.create({
        data: {
          submissionId,
          verifierId,
          decision: data.decision,
          reason: data.reason,
          verifierNotes: data.verifierNotes,
          metricsConfirmed: data.metricsConfirmed as Prisma.InputJsonValue | undefined,
          impactSummary: data.impactSummary,
          reviewedAt: new Date(),
        },
      });

      await tx.milestoneSubmission.update({
        where: { id: submissionId },
        data: { status: nextSubmissionStatus[data.decision] },
      });

      const milestoneUpdate: Record<string, unknown> = {
        verificationStatus: nextMilestoneStatus[data.decision],
        currentReviewId: created.id,
      };

      if (data.decision === ReviewDecision.APPROVED) {
        milestoneUpdate.achieved = true;
        milestoneUpdate.achievedAt = new Date();
      }

      await tx.milestone.update({
        where: { id: submission.milestoneId },
        data: milestoneUpdate,
      });

      return created;
    });

    await this.recordHistory(submissionId, historyEventMap[data.decision], verifierId, {
      reviewId: review.id,
      decision: data.decision,
      ...(data.reason && { reason: data.reason }),
    });

    const campaign = submission.milestone.campaign;
    const orgUserId = campaign.userId;
    const milestoneTitle = submission.milestone.title;

    if (data.decision === ReviewDecision.APPROVED) {
      await NotificationService.sendMilestoneApprovedNotification(
        orgUserId,
        milestoneTitle,
        data.impactSummary
      );
    } else if (data.decision === ReviewDecision.REJECTED) {
      await NotificationService.sendMilestoneRejectedNotification(
        orgUserId,
        milestoneTitle,
        data.reason ?? 'No reason provided'
      );
    } else {
      await NotificationService.sendMilestoneRevisionRequestedNotification(
        orgUserId,
        milestoneTitle,
        data.reason ?? 'No reason provided'
      );
    }

    broadcastToUser(orgUserId, 'milestone:reviewed', {
      submissionId,
      milestoneId: submission.milestoneId,
      decision: data.decision,
    });

    broadcastToCampaign(submission.campaignId, 'milestone:reviewed', {
      submissionId,
      milestoneId: submission.milestoneId,
      decision: data.decision,
    });

    const auditActionMap: Record<ReviewDecision, AuditAction> = {
      [ReviewDecision.APPROVED]: AuditAction.MILESTONE_APPROVED,
      [ReviewDecision.REJECTED]: AuditAction.MILESTONE_REJECTED,
      [ReviewDecision.REVISION_REQUESTED]: AuditAction.MILESTONE_REVISION_REQUESTED,
    };

    await this.writeAuditLog(verifierId, auditActionMap[data.decision], submissionId, {
      milestoneId: submission.milestoneId,
      campaignId: submission.campaignId,
      decision: data.decision,
      ...(data.reason && { reason: data.reason }),
    });

    logger.info(
      `Milestone submission ${submissionId} reviewed: ${data.decision} by ${verifierId}`
    );

    return review;
  }

  static async listAdminSubmissions(filters: AdminSubmissionFilters) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (filters.status) where.status = filters.status;
    if (filters.campaignId) where.campaignId = filters.campaignId;
    if (filters.verifierId) {
      where.reviews = { some: { verifierId: filters.verifierId } };
    }
    if (filters.startDate || filters.endDate) {
      where.submittedAt = {
        ...(filters.startDate && { gte: filters.startDate }),
        ...(filters.endDate && { lte: filters.endDate }),
      };
    }

    const [data, total] = await Promise.all([
      prisma.milestoneSubmission.findMany({
        where,
        include: {
          milestone: { select: { title: true, campaignId: true } },
          reviews: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { submittedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.milestoneSubmission.count({ where }),
    ]);

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  static async listSubmissionReviews(submissionId: string) {
    const submission = await prisma.milestoneSubmission.findUnique({
      where: { id: submissionId },
    });

    if (!submission) throw new AppError('Submission not found', 404);

    return prisma.milestoneReview.findMany({
      where: { submissionId },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async getMilestoneVerificationStatus(milestoneId: string) {
    const milestone = await prisma.milestone.findUnique({
      where: { id: milestoneId },
      include: {
        submissions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: {
            reviews: { orderBy: { createdAt: 'desc' }, take: 1 },
            history: { orderBy: { timestamp: 'asc' } },
          },
        },
      },
    });

    if (!milestone) throw new AppError('Milestone not found', 404);
    return milestone;
  }

  static async getVerificationReport(milestoneId: string, campaignId: string) {
    const milestone = await prisma.milestone.findFirst({
      where: { id: milestoneId, campaignId },
      include: {
        submissions: {
          where: {
            status: { in: [MilestoneSubmissionStatus.APPROVED, MilestoneSubmissionStatus.UNDER_REVIEW, MilestoneSubmissionStatus.SUBMITTED] },
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: {
            reviews: {
              where: { decision: ReviewDecision.APPROVED },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    });

    if (!milestone) throw new AppError('Milestone not found in this campaign', 404);

    const latestSubmission = milestone.submissions[0] ?? null;
    const approvedReview = latestSubmission?.reviews[0] ?? null;

    return {
      milestoneId: milestone.id,
      title: milestone.title,
      verificationStatus: milestone.verificationStatus,
      approvedAt: approvedReview?.reviewedAt ?? null,
      metricsApproved: approvedReview?.metricsConfirmed ?? null,
      impactSummary: approvedReview?.impactSummary ?? null,
      verifierNotes: approvedReview?.verifierNotes ?? null,
    };
  }
}
