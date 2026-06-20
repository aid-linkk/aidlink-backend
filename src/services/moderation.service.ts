import prisma from '../config/database';
import {
  CampaignStatus,
  SuspensionSource,
  SuspensionReasonCode,
  AppealStatus,
  FraudReportType,
  AuditAction,
  OrganizationStatus,
  DonationStatus,
  Role,
} from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { config } from '../config';
import { NotificationService } from './notification.service';
import {
  sendCampaignSuspended,
  sendCampaignReinstated,
  sendAppealUpdate,
} from '../websocket/socket.server';

export interface SuspendOptions {
  source: SuspensionSource;
  actorId?: string | null;
  reasonCode: SuspensionReasonCode;
  reasonText?: string;
  evidence?: string[];
}

const REASON_SUMMARIES: Record<SuspensionReasonCode, string> = {
  LOW_VERIFICATION: 'Insufficient organization verification',
  FRAUD_REPORTS: 'Multiple fraud reports received',
  POLICY_VIOLATION: 'Policy violation detected',
  MANUAL_REVIEW: 'Flagged for manual review',
  OTHER: 'Moderation action',
};

// Reason codes that should also notify donors when configured.
const FRAUD_RELATED_REASONS: SuspensionReasonCode[] = [
  SuspensionReasonCode.FRAUD_REPORTS,
  SuspensionReasonCode.POLICY_VIOLATION,
];

export class ModerationService {
  // ──────────────────────────────────────────────────────────────
  // Audit helper — append-only trail via AuditLog + logger.
  // ──────────────────────────────────────────────────────────────
  private static async writeAudit(
    action: AuditAction,
    entityType: string,
    entityId: string,
    actorId?: string | null,
    changes?: any
  ): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          userId: actorId ?? undefined,
          action,
          entityType,
          entityId,
          changes,
        },
      });
    } catch (error) {
      logger.error('Failed to write moderation audit log:', error);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Fraud reports
  // ──────────────────────────────────────────────────────────────
  static async reportCampaign(
    campaignId: string,
    reporterId: string | undefined,
    type: FraudReportType,
    details?: string
  ): Promise<any> {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      throw new AppError('Campaign not found', 404);
    }

    const report = await prisma.fraudReport.create({
      data: {
        campaignId,
        reporterId: reporterId ?? null,
        type,
        details,
      },
    });

    await this.writeAudit(AuditAction.FRAUD_REPORTED, 'Campaign', campaignId, reporterId, {
      reportId: report.id,
      type,
    });

    logger.info(`Fraud report ${report.id} filed against campaign ${campaignId} (type: ${type})`);

    // Near-real-time handling for the critical fraud threshold.
    try {
      await this.evaluateFraudReports(campaignId);
    } catch (error) {
      logger.error(`Fraud evaluation failed for campaign ${campaignId}:`, error);
    }

    return report;
  }

  // ──────────────────────────────────────────────────────────────
  // Suspension (manual admin action or automatic)
  // ──────────────────────────────────────────────────────────────
  static async suspendCampaign(
    campaignId: string,
    opts: SuspendOptions
  ): Promise<{ campaign: any; suspension: any; alreadySuspended: boolean }> {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      throw new AppError('Campaign not found', 404);
    }

    // Idempotent: a campaign already suspended is not re-suspended and no
    // duplicate suspension record is created.
    if (campaign.status === CampaignStatus.SUSPENDED) {
      const existing = await prisma.suspension.findFirst({
        where: { campaignId, active: true },
        orderBy: { createdAt: 'desc' },
      });
      logger.info(`Campaign ${campaignId} already suspended; suspend is a no-op`);
      return { campaign, suspension: existing, alreadySuspended: true };
    }

    const metadata = {
      reasonCode: opts.reasonCode,
      reasonText: opts.reasonText ?? null,
      source: opts.source,
      actorId: opts.actorId ?? null,
      evidenceCount: opts.evidence?.length ?? 0,
      suspendedAt: new Date().toISOString(),
    };

    const { campaign: updatedCampaign, suspension } = await prisma.$transaction(async (tx) => {
      const suspension = await tx.suspension.create({
        data: {
          campaignId,
          actorId: opts.actorId ?? null,
          source: opts.source,
          reasonCode: opts.reasonCode,
          reasonText: opts.reasonText,
          evidence: opts.evidence ? { links: opts.evidence } : undefined,
          active: true,
        },
      });

      const updated = await tx.campaign.update({
        where: { id: campaignId },
        data: {
          status: CampaignStatus.SUSPENDED,
          suspendedAt: new Date(),
          suspensionMetadata: metadata,
        },
      });

      return { campaign: updated, suspension };
    });

    await this.writeAudit(AuditAction.CAMPAIGN_SUSPENDED, 'Campaign', campaignId, opts.actorId, {
      suspensionId: suspension.id,
      reasonCode: opts.reasonCode,
      source: opts.source,
    });

    logger.info(
      `Campaign ${campaignId} suspended (source: ${opts.source}, reason: ${opts.reasonCode}, ` +
      `actor: ${opts.actorId ?? 'system'})`
    );

    await this.notifySuspension(updatedCampaign, opts);

    sendCampaignSuspended(campaignId, updatedCampaign.userId, {
      campaignId,
      status: CampaignStatus.SUSPENDED,
      reasonCode: opts.reasonCode,
      suspendedAt: updatedCampaign.suspendedAt,
    });

    return { campaign: updatedCampaign, suspension, alreadySuspended: false };
  }

  private static async notifySuspension(campaign: any, opts: SuspendOptions): Promise<void> {
    const reasonSummary = REASON_SUMMARIES[opts.reasonCode];

    try {
      await NotificationService.sendCampaignSuspendedNotification(
        campaign.userId,
        campaign.title,
        reasonSummary,
        {
          canAppeal: true,
          evidenceSummary: opts.evidence?.length
            ? `${opts.evidence.length} item(s) provided`
            : undefined,
          metadata: { campaignId: campaign.id, reasonCode: opts.reasonCode },
        }
      );
    } catch (error) {
      logger.error(`Failed to notify owner of suspension for campaign ${campaign.id}:`, error);
    }

    // Optional donor notifications for fraud-related suspensions.
    if (
      config.moderation.notifyDonorsOnFraudSuspension &&
      FRAUD_RELATED_REASONS.includes(opts.reasonCode)
    ) {
      await this.notifyDonors(campaign);
    }
  }

  private static async notifyDonors(campaign: any): Promise<void> {
    try {
      const donations = await prisma.donation.findMany({
        where: {
          campaignId: campaign.id,
          status: DonationStatus.CONFIRMED,
          userId: { not: null },
        },
        select: { userId: true },
        distinct: ['userId'],
      });

      await Promise.all(
        donations
          .map((d) => d.userId)
          .filter((id): id is string => Boolean(id))
          .map((userId) =>
            NotificationService.sendDonorFraudSuspensionNotification(userId, campaign.title).catch(
              (error) => logger.error(`Failed to notify donor ${userId}:`, error)
            )
          )
      );
    } catch (error) {
      logger.error(`Failed to notify donors for campaign ${campaign.id}:`, error);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Reinstatement (admin action / approved appeal)
  // ──────────────────────────────────────────────────────────────
  static async reinstateCampaign(
    campaignId: string,
    actorId: string | null,
    adminNotes?: string
  ): Promise<any> {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      throw new AppError('Campaign not found', 404);
    }

    if (campaign.status !== CampaignStatus.SUSPENDED) {
      throw new AppError('Campaign is not suspended', 400);
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Mark the active suspension(s) as lifted — append-only, never deleted.
      await tx.suspension.updateMany({
        where: { campaignId, active: true },
        data: {
          active: false,
          liftedAt: new Date(),
          liftedBy: actorId ?? undefined,
          liftNotes: adminNotes,
        },
      });

      return tx.campaign.update({
        where: { id: campaignId },
        data: {
          status: CampaignStatus.ACTIVE,
          suspendedAt: null,
          suspensionMetadata: undefined,
        },
      });
    });

    await this.writeAudit(AuditAction.CAMPAIGN_REINSTATED, 'Campaign', campaignId, actorId, {
      adminNotes,
    });

    logger.info(`Campaign ${campaignId} reinstated by ${actorId ?? 'system'}`);

    try {
      await NotificationService.sendCampaignReinstatedNotification(
        updated.userId,
        updated.title,
        adminNotes
      );
    } catch (error) {
      logger.error(`Failed to notify owner of reinstatement for campaign ${campaignId}:`, error);
    }

    sendCampaignReinstated(campaignId, updated.userId, {
      campaignId,
      status: CampaignStatus.ACTIVE,
    });

    return updated;
  }

  // ──────────────────────────────────────────────────────────────
  // Appeals (owner)
  // ──────────────────────────────────────────────────────────────
  static async submitAppeal(
    campaignId: string,
    ownerId: string,
    message: string,
    attachments?: string[]
  ): Promise<any> {
    if (!message || typeof message !== 'string' || message.trim().length < 10) {
      throw new AppError('Appeal message must be at least 10 characters long', 400);
    }

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      throw new AppError('Campaign not found', 404);
    }

    if (campaign.userId !== ownerId) {
      throw new AppError('Only the campaign owner can submit an appeal', 403);
    }

    if (campaign.status !== CampaignStatus.SUSPENDED) {
      throw new AppError('Only suspended campaigns can be appealed', 400);
    }

    const suspension = await prisma.suspension.findFirst({
      where: { campaignId, active: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!suspension) {
      throw new AppError('No active suspension found for this campaign', 400);
    }

    // One open appeal per suspension at a time.
    const pending = await prisma.appeal.findFirst({
      where: {
        suspensionId: suspension.id,
        status: { in: [AppealStatus.OPEN, AppealStatus.UNDER_REVIEW] },
      },
    });

    if (pending) {
      throw new AppError('An appeal is already in progress for this suspension', 409);
    }

    const appeal = await prisma.appeal.create({
      data: {
        suspensionId: suspension.id,
        campaignId,
        campaignOwnerId: ownerId,
        message: message.trim(),
        attachments: attachments?.length ? { links: attachments } : undefined,
        status: AppealStatus.OPEN,
      },
    });

    await this.writeAudit(AuditAction.APPEAL_SUBMITTED, 'Appeal', appeal.id, ownerId, {
      campaignId,
      suspensionId: suspension.id,
    });

    logger.info(`Appeal ${appeal.id} submitted for campaign ${campaignId} by owner ${ownerId}`);

    return appeal;
  }

  static async getCampaignAppeals(
    campaignId: string,
    userId: string,
    role: Role
  ): Promise<any[]> {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      throw new AppError('Campaign not found', 404);
    }

    if (campaign.userId !== userId && role !== Role.ADMIN) {
      throw new AppError('You do not have permission to view these appeals', 403);
    }

    return prisma.appeal.findMany({
      where: { campaignId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Appeals (admin)
  // ──────────────────────────────────────────────────────────────
  static async resolveAppeal(
    appealId: string,
    decision: 'APPROVE' | 'DENY',
    adminId: string,
    adminNotes?: string
  ): Promise<any> {
    const appeal = await prisma.appeal.findUnique({
      where: { id: appealId },
      include: { campaign: true },
    });

    if (!appeal) {
      throw new AppError('Appeal not found', 404);
    }

    if (appeal.status === AppealStatus.APPROVED || appeal.status === AppealStatus.DENIED) {
      throw new AppError('Appeal has already been resolved', 400);
    }

    const newStatus = decision === 'APPROVE' ? AppealStatus.APPROVED : AppealStatus.DENIED;

    const updatedAppeal = await prisma.appeal.update({
      where: { id: appealId },
      data: {
        status: newStatus,
        adminNotes,
        resolvedBy: adminId,
        resolvedAt: new Date(),
      },
    });

    // Approving an appeal reinstates the campaign (if still suspended).
    if (decision === 'APPROVE' && appeal.campaign.status === CampaignStatus.SUSPENDED) {
      await this.reinstateCampaign(appeal.campaignId, adminId, adminNotes);
    }

    await this.writeAudit(AuditAction.APPEAL_RESOLVED, 'Appeal', appealId, adminId, {
      decision,
      campaignId: appeal.campaignId,
    });

    logger.info(`Appeal ${appealId} resolved as ${newStatus} by admin ${adminId}`);

    try {
      await NotificationService.sendAppealResolvedNotification(
        appeal.campaignOwnerId,
        appeal.campaign.title,
        newStatus === AppealStatus.APPROVED ? 'APPROVED' : 'DENIED',
        adminNotes
      );
    } catch (error) {
      logger.error(`Failed to notify owner of appeal resolution ${appealId}:`, error);
    }

    sendAppealUpdate(appeal.campaignOwnerId, {
      appealId,
      campaignId: appeal.campaignId,
      status: newStatus,
    });

    return updatedAppeal;
  }

  static async listAppeals(
    filters: { status?: AppealStatus; campaignId?: string },
    pagination: any
  ): Promise<any> {
    const { page = 1, limit = 20, sortOrder = 'desc' } = pagination;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.campaignId) where.campaignId = filters.campaignId;

    const [appeals, total] = await Promise.all([
      prisma.appeal.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: sortOrder },
        include: {
          campaign: { select: { id: true, title: true, status: true } },
        },
      }),
      prisma.appeal.count({ where }),
    ]);

    return {
      data: appeals,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  static async listSuspensions(campaignId: string): Promise<any> {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      throw new AppError('Campaign not found', 404);
    }

    return prisma.suspension.findMany({
      where: { campaignId },
      orderBy: { createdAt: 'desc' },
      include: {
        appeals: { orderBy: { createdAt: 'desc' } },
      },
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Summary helpers (consumed by GET /campaigns/:id)
  // ──────────────────────────────────────────────────────────────
  static async getModerationView(
    campaign: { id: string; status: CampaignStatus; suspendedAt?: Date | null }
  ): Promise<{ suspensionSummary: any; canAppeal: boolean }> {
    if (campaign.status !== CampaignStatus.SUSPENDED) {
      return { suspensionSummary: null, canAppeal: false };
    }

    const suspension = await prisma.suspension.findFirst({
      where: { campaignId: campaign.id, active: true },
      orderBy: { createdAt: 'desc' },
      include: {
        appeals: {
          where: { status: { in: [AppealStatus.OPEN, AppealStatus.UNDER_REVIEW] } },
          select: { id: true, status: true },
        },
      },
    });

    if (!suspension) {
      return { suspensionSummary: null, canAppeal: false };
    }

    const hasOpenAppeal = suspension.appeals.length > 0;

    const suspensionSummary = {
      reasonCode: suspension.reasonCode,
      reason: REASON_SUMMARIES[suspension.reasonCode],
      reasonText: suspension.reasonText,
      source: suspension.source,
      suspendedAt: campaign.suspendedAt ?? suspension.createdAt,
      hasOpenAppeal,
      appealStatus: hasOpenAppeal ? suspension.appeals[0].status : null,
    };

    return { suspensionSummary, canAppeal: !hasOpenAppeal };
  }

  // ──────────────────────────────────────────────────────────────
  // Rule evaluation (used by the moderation worker)
  // ──────────────────────────────────────────────────────────────

  // Independent fraud reports within the rolling window. Distinct identified
  // reporters collapse to one each; anonymous reports each count as independent.
  static async countIndependentFraudReports(campaignId: string): Promise<number> {
    const windowStart = new Date(
      Date.now() - config.moderation.fraudReportWindowHours * 60 * 60 * 1000
    );

    const reports = await prisma.fraudReport.findMany({
      where: { campaignId, createdAt: { gte: windowStart } },
      select: { reporterId: true },
    });

    const distinctReporters = new Set<string>();
    let anonymous = 0;
    for (const r of reports) {
      if (r.reporterId) distinctReporters.add(r.reporterId);
      else anonymous += 1;
    }
    return distinctReporters.size + anonymous;
  }

  static async evaluateFraudReports(campaignId: string): Promise<boolean> {
    if (!config.moderation.autoSuspendEnabled) {
      return false;
    }

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.status === CampaignStatus.SUSPENDED) {
      return false;
    }

    const count = await this.countIndependentFraudReports(campaignId);
    if (count >= config.moderation.fraudReportThreshold) {
      await this.suspendCampaign(campaignId, {
        source: SuspensionSource.AUTO,
        actorId: null,
        reasonCode: SuspensionReasonCode.FRAUD_REPORTS,
        reasonText: `${count} independent fraud report(s) within ${config.moderation.fraudReportWindowHours}h`,
      });
      return true;
    }
    return false;
  }

  // Verification proxy: derive a 0–100 score from the owning organization's
  // verification status. A low score sustained past the grace period triggers
  // auto-suspension. Campaign age is used as the lower bound for "sustained".
  static computeVerificationScore(orgStatus: OrganizationStatus | undefined): number {
    switch (orgStatus) {
      case OrganizationStatus.APPROVED:
        return 100;
      case OrganizationStatus.PENDING:
        return 30;
      case OrganizationStatus.SUSPENDED:
      case OrganizationStatus.REJECTED:
        return 0;
      default:
        return 0;
    }
  }

  static async evaluateVerification(campaignId: string): Promise<boolean> {
    if (!config.moderation.autoSuspendEnabled) {
      return false;
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { organization: { select: { status: true } } },
    });

    if (!campaign || campaign.status !== CampaignStatus.ACTIVE) {
      return false;
    }

    const score = this.computeVerificationScore(campaign.organization?.status);
    if (score >= config.moderation.verificationScoreThreshold) {
      return false;
    }

    const graceMs = config.moderation.verificationGraceDays * 24 * 60 * 60 * 1000;
    const lowSinceCutoff = Date.now() - graceMs;
    if (campaign.createdAt.getTime() > lowSinceCutoff) {
      // Still within the grace period.
      return false;
    }

    await this.suspendCampaign(campaignId, {
      source: SuspensionSource.AUTO,
      actorId: null,
      reasonCode: SuspensionReasonCode.LOW_VERIFICATION,
      reasonText: `Verification score ${score} below threshold ${config.moderation.verificationScoreThreshold} for over ${config.moderation.verificationGraceDays} day(s)`,
    });
    return true;
  }

  static async evaluateCampaign(campaignId: string): Promise<boolean> {
    // Fraud check first (more severe), then verification.
    const suspended = await this.evaluateFraudReports(campaignId);
    if (suspended) return true;
    return this.evaluateVerification(campaignId);
  }

  // Batched evaluation of all active campaigns for the periodic job.
  static async evaluateAllCampaigns(batchSize = 100): Promise<{ evaluated: number; suspended: number }> {
    if (!config.moderation.autoSuspendEnabled) {
      logger.info('Auto-suspension disabled; skipping batch evaluation');
      return { evaluated: 0, suspended: 0 };
    }

    let evaluated = 0;
    let suspended = 0;
    let cursor: string | undefined;

    // Keyset pagination over active campaigns.
    for (;;) {
      const campaigns = await prisma.campaign.findMany({
        where: { status: CampaignStatus.ACTIVE },
        take: batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: { id: true },
      });

      if (campaigns.length === 0) break;

      for (const c of campaigns) {
        evaluated += 1;
        try {
          if (await this.evaluateCampaign(c.id)) suspended += 1;
        } catch (error) {
          logger.error(`Evaluation failed for campaign ${c.id}:`, error);
        }
      }

      if (campaigns.length < batchSize) break;
      cursor = campaigns[campaigns.length - 1].id;
    }

    logger.info(`Moderation batch evaluation complete: ${evaluated} evaluated, ${suspended} suspended`);
    return { evaluated, suspended };
  }
}
