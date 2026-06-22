import prisma from '../config/database';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import {
  RecoveryCaseType,
  RecoveryStatus,
  SettlementOption,
  AuditAction,
  NotificationType,
  DonationStatus,
  DistributionStatus,
  CampaignStatus,
} from '@prisma/client';
import { NotificationService } from './notification.service';

const MAX_RETRIES = 3;
// Exponential backoff delays in ms: 5m, 30m, 2h
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

// ─── Helpers ────────────────────────────────────────────────────

async function writeAuditLog(
  actorId: string | null,
  action: AuditAction,
  entityType: string,
  entityId: string,
  metadata?: object
) {
  await prisma.auditLog.create({
    data: {
      userId: actorId,
      action,
      entityType,
      entityId,
      ...(metadata !== undefined ? { metadata } : {}),
    },
  });
}

function nextRetryAt(retryCount: number): Date {
  const delayMs = RETRY_DELAYS_MS[retryCount] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  return new Date(Date.now() + delayMs);
}

// ─── Create Cases ────────────────────────────────────────────────

export async function createFailedRefundCase(
  donationId: string,
  failureReason: string,
  failureMetadata?: object
) {
  const existing = await prisma.recoveryCase.findFirst({
    where: {
      donationId,
      type: RecoveryCaseType.FAILED_REFUND,
      status: { notIn: [RecoveryStatus.RECOVERED, RecoveryStatus.FAILED_PERMANENTLY] },
    },
  });
  if (existing) return existing;

  const rc = await prisma.recoveryCase.create({
    data: {
      type: RecoveryCaseType.FAILED_REFUND,
      donationId,
      failureReason,
      ...(failureMetadata !== undefined ? { failureMetadata } : {}),
      status: RecoveryStatus.PENDING,
      maxRetries: MAX_RETRIES,
      nextRetryAt: nextRetryAt(0),
    },
  });

  await writeAuditLog(null, AuditAction.RECOVERY_CASE_CREATED, 'RecoveryCase', rc.id, {
    type: rc.type,
    donationId,
    failureReason,
  });

  // Notify donor
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    include: { user: { select: { id: true } } },
  });
  if (donation?.userId) {
    await NotificationService.createNotification(
      donation.userId,
      NotificationType.REFUND_FAILED,
      'Refund Transfer Failed',
      `Your refund for donation ${donationId} could not be processed: ${failureReason}. We are retrying automatically.`,
      { recoveryCaseId: rc.id }
    );
  }

  logger.info(`Recovery case created [FAILED_REFUND]: ${rc.id}`);
  return rc;
}

export async function createFailedDistributionCase(
  distributionId: string,
  failureReason: string,
  failureMetadata?: object
) {
  const existing = await prisma.recoveryCase.findFirst({
    where: {
      distributionId,
      type: RecoveryCaseType.FAILED_DISTRIBUTION,
      status: { notIn: [RecoveryStatus.RECOVERED, RecoveryStatus.FAILED_PERMANENTLY] },
    },
  });
  if (existing) return existing;

  const rc = await prisma.recoveryCase.create({
    data: {
      type: RecoveryCaseType.FAILED_DISTRIBUTION,
      distributionId,
      failureReason,
      ...(failureMetadata !== undefined ? { failureMetadata } : {}),
      status: RecoveryStatus.PENDING,
      maxRetries: MAX_RETRIES,
      nextRetryAt: nextRetryAt(0),
    },
  });

  await writeAuditLog(null, AuditAction.RECOVERY_CASE_CREATED, 'RecoveryCase', rc.id, {
    type: rc.type,
    distributionId,
    failureReason,
  });

  logger.info(`Recovery case created [FAILED_DISTRIBUTION]: ${rc.id}`);
  return rc;
}

export async function createCancelledCampaignCase(campaignId: string) {
  const existing = await prisma.recoveryCase.findFirst({
    where: {
      campaignId,
      type: RecoveryCaseType.CANCELLED_CAMPAIGN_FUNDS,
      status: { notIn: [RecoveryStatus.RECOVERED, RecoveryStatus.FAILED_PERMANENTLY] },
    },
  });
  if (existing) return existing;

  const rc = await prisma.recoveryCase.create({
    data: {
      type: RecoveryCaseType.CANCELLED_CAMPAIGN_FUNDS,
      campaignId,
      status: RecoveryStatus.RECOVERY_REQUIRED,
      maxRetries: 0,
    },
  });

  await writeAuditLog(null, AuditAction.RECOVERY_CASE_CREATED, 'RecoveryCase', rc.id, {
    type: rc.type,
    campaignId,
  });

  logger.info(`Recovery case created [CANCELLED_CAMPAIGN_FUNDS]: ${rc.id}`);
  return rc;
}

// ─── Retry Logic ─────────────────────────────────────────────────

export async function retryRefund(recoveryCaseId: string, adminId: string) {
  const rc = await prisma.recoveryCase.findUnique({ where: { id: recoveryCaseId } });
  if (!rc) throw new AppError('Recovery case not found', 404);
  if (rc.type !== RecoveryCaseType.FAILED_REFUND)
    throw new AppError('Not a FAILED_REFUND case', 400);
  if (rc.status === RecoveryStatus.RECOVERED || rc.status === RecoveryStatus.FAILED_PERMANENTLY)
    throw new AppError('Case is already resolved', 400);

  const newCount = rc.retryCount + 1;
  const isPermanentFailure = newCount >= rc.maxRetries;

  const updated = await prisma.recoveryCase.update({
    where: { id: recoveryCaseId },
    data: {
      status: isPermanentFailure ? RecoveryStatus.FAILED_PERMANENTLY : RecoveryStatus.RETRYING,
      retryCount: newCount,
      lastRetriedAt: new Date(),
      nextRetryAt: isPermanentFailure ? null : nextRetryAt(newCount),
    },
  });

  await writeAuditLog(adminId, AuditAction.RECOVERY_RETRIED, 'RecoveryCase', rc.id, {
    retryCount: newCount,
    isPermanentFailure,
  });

  if (isPermanentFailure && rc.donationId) {
    const donation = await prisma.donation.findUnique({
      where: { id: rc.donationId },
      include: { user: { select: { id: true } } },
    });
    if (donation?.userId) {
      await NotificationService.createNotification(
        donation.userId,
        NotificationType.REFUND_FAILED,
        'Refund Could Not Be Completed',
        'All retry attempts for your refund have been exhausted. Our team will contact you with alternate options.',
        { recoveryCaseId: rc.id }
      );
    }
  }

  logger.info(`Refund retried: case ${rc.id}, attempt ${newCount}`);
  return updated;
}

export async function retryDistribution(recoveryCaseId: string, adminId: string) {
  const rc = await prisma.recoveryCase.findUnique({ where: { id: recoveryCaseId } });
  if (!rc) throw new AppError('Recovery case not found', 404);
  if (rc.type !== RecoveryCaseType.FAILED_DISTRIBUTION)
    throw new AppError('Not a FAILED_DISTRIBUTION case', 400);
  if (rc.status === RecoveryStatus.RECOVERED || rc.status === RecoveryStatus.FAILED_PERMANENTLY)
    throw new AppError('Case is already resolved', 400);

  const newCount = rc.retryCount + 1;
  const isPermanentFailure = newCount >= rc.maxRetries;

  const updated = await prisma.recoveryCase.update({
    where: { id: recoveryCaseId },
    data: {
      status: isPermanentFailure ? RecoveryStatus.RECOVERY_REQUIRED : RecoveryStatus.RETRYING,
      retryCount: newCount,
      lastRetriedAt: new Date(),
      nextRetryAt: isPermanentFailure ? null : nextRetryAt(newCount),
    },
  });

  if (rc.distributionId) {
    await prisma.distribution.update({
      where: { id: rc.distributionId },
      data: { status: DistributionStatus.IN_PROGRESS },
    });
  }

  await writeAuditLog(adminId, AuditAction.RECOVERY_RETRIED, 'RecoveryCase', rc.id, {
    retryCount: newCount,
    isPermanentFailure,
  });

  logger.info(`Distribution retried: case ${rc.id}, attempt ${newCount}`);
  return updated;
}

// ─── Manual Recovery ─────────────────────────────────────────────

export async function updateRefundDestination(
  recoveryCaseId: string,
  newAccount: { bankName: string; accountNumber: string; routingNumber: string },
  adminId: string
) {
  const rc = await prisma.recoveryCase.findUnique({ where: { id: recoveryCaseId } });
  if (!rc) throw new AppError('Recovery case not found', 404);
  if (rc.type !== RecoveryCaseType.FAILED_REFUND)
    throw new AppError('Not a FAILED_REFUND case', 400);

  const updated = await prisma.recoveryCase.update({
    where: { id: recoveryCaseId },
    data: {
      failureMetadata: { ...((rc.failureMetadata ?? {}) as any), updatedBankAccount: newAccount },
      status: RecoveryStatus.PENDING,
      nextRetryAt: nextRetryAt(0),
    },
  });

  await writeAuditLog(adminId, AuditAction.RECOVERY_MANUAL_OVERRIDE, 'RecoveryCase', rc.id, {
    action: 'updateRefundDestination',
    newAccount,
  });

  logger.info(`Refund destination updated: case ${rc.id} by admin ${adminId}`);
  return updated;
}

export async function markDistributionRecoveryRequired(recoveryCaseId: string, adminId: string) {
  const rc = await prisma.recoveryCase.findUnique({ where: { id: recoveryCaseId } });
  if (!rc) throw new AppError('Recovery case not found', 404);
  if (rc.type !== RecoveryCaseType.FAILED_DISTRIBUTION)
    throw new AppError('Not a FAILED_DISTRIBUTION case', 400);

  const updated = await prisma.recoveryCase.update({
    where: { id: recoveryCaseId },
    data: { status: RecoveryStatus.RECOVERY_REQUIRED },
  });

  if (rc.distributionId) {
    await prisma.distribution.update({
      where: { id: rc.distributionId },
      data: { status: DistributionStatus.FAILED },
    });
  }

  await writeAuditLog(adminId, AuditAction.RECOVERY_MANUAL_OVERRIDE, 'RecoveryCase', rc.id, {
    action: 'markRecoveryRequired',
  });

  logger.info(`Distribution flagged RECOVERY_REQUIRED: case ${rc.id}`);
  return updated;
}

// ─── Campaign Settlement ──────────────────────────────────────────

export async function settleCancelledCampaign(
  recoveryCaseId: string,
  option: SettlementOption,
  adminId: string,
  notes?: string,
  targetCampaignId?: string
) {
  const rc = await prisma.recoveryCase.findUnique({
    where: { id: recoveryCaseId },
    include: { donorCredits: true },
  });
  if (!rc) throw new AppError('Recovery case not found', 404);
  if (rc.type !== RecoveryCaseType.CANCELLED_CAMPAIGN_FUNDS)
    throw new AppError('Not a CANCELLED_CAMPAIGN_FUNDS case', 400);
  if (rc.status === RecoveryStatus.RECOVERED) throw new AppError('Case is already settled', 400);
  if (!rc.campaignId) throw new AppError('No campaign linked to this case', 400);

  if (option === SettlementOption.TRANSFER_TO_CAMPAIGN) {
    if (!targetCampaignId)
      throw new AppError('targetCampaignId required for TRANSFER_TO_CAMPAIGN', 400);
    const target = await prisma.campaign.findUnique({ where: { id: targetCampaignId } });
    if (!target || target.status !== CampaignStatus.ACTIVE)
      throw new AppError('Target campaign not found or not active', 400);
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: rc.campaignId },
    include: {
      donations: { where: { status: DonationStatus.CONFIRMED } },
    },
  });
  if (!campaign) throw new AppError('Campaign not found', 404);

  await prisma.$transaction(async (tx) => {
    if (option === SettlementOption.REFUND_TO_DONOR) {
      // Mark each donation as refunded and notify donors
      for (const donation of campaign.donations) {
        await tx.donation.update({
          where: { id: donation.id },
          data: { status: DonationStatus.REFUNDED },
        });
        await tx.campaign.update({
          where: { id: campaign.id },
          data: { currentAmount: { decrement: donation.amount } },
        });
        if (donation.userId) {
          await tx.notification.create({
            data: {
              userId: donation.userId,
              type: NotificationType.CAMPAIGN_SETTLEMENT,
              title: 'Campaign Cancelled – Refund Issued',
              message: `Campaign "${campaign.title}" was cancelled. Your donation of ${donation.amount} ${donation.currency} has been refunded.`,
              metadata: { recoveryCaseId: rc.id, campaignId: campaign.id },
            },
          });
        }
      }
    } else if (option === SettlementOption.TRANSFER_TO_CAMPAIGN && targetCampaignId) {
      await tx.campaign.update({
        where: { id: targetCampaignId },
        data: { currentAmount: { increment: campaign.currentAmount } },
      });
      await tx.campaign.update({ where: { id: campaign.id }, data: { currentAmount: 0 } });
    }
    // RETAIN_IN_ESCROW – no balance movement, just record the decision

    await tx.recoveryCase.update({
      where: { id: rc.id },
      data: {
        status: RecoveryStatus.RECOVERED,
        settlementOption: option,
        settlementNotes: notes,
        settledAt: new Date(),
        settledBy: adminId,
        resolvedAt: new Date(),
      },
    });
  });

  await writeAuditLog(adminId, AuditAction.RECOVERY_SETTLED, 'RecoveryCase', rc.id, {
    option,
    notes,
    targetCampaignId,
  });

  logger.info(`Campaign settlement completed: case ${rc.id}, option ${option}`);
  return prisma.recoveryCase.findUnique({ where: { id: rc.id } });
}

// ─── Donor Compensation ──────────────────────────────────────────

export async function issueDonorCredit(
  recoveryCaseId: string,
  userId: string,
  amount: number,
  currency: string,
  reason: string,
  adminId: string,
  expiresAt?: Date
) {
  const rc = await prisma.recoveryCase.findUnique({ where: { id: recoveryCaseId } });
  if (!rc) throw new AppError('Recovery case not found', 404);

  const credit = await prisma.donorCredit.create({
    data: {
      userId,
      recoveryCaseId,
      amount,
      currency,
      reason,
      expiresAt: expiresAt ?? null,
    },
  });

  await NotificationService.createNotification(
    userId,
    NotificationType.DONOR_CREDIT_ISSUED,
    'Donor Credit Issued',
    `You have been issued a credit of ${amount} ${currency} as compensation. ${reason}`,
    { donorCreditId: credit.id, recoveryCaseId }
  );

  await writeAuditLog(adminId, AuditAction.DONOR_CREDIT_ISSUED, 'DonorCredit', credit.id, {
    userId,
    amount,
    currency,
    reason,
  });

  logger.info(`Donor credit issued: ${credit.id} to user ${userId}`);
  return credit;
}

// ─── Query / Reconciliation ──────────────────────────────────────

export async function listRecoveryCases(filters: {
  type?: RecoveryCaseType;
  status?: RecoveryStatus;
  page?: number;
  limit?: number;
}) {
  const { type, status, page = 1, limit = 20 } = filters;
  const skip = (page - 1) * limit;
  const where: any = {};
  if (type) where.type = type;
  if (status) where.status = status;

  const [data, total] = await Promise.all([
    prisma.recoveryCase.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { donorCredits: true },
    }),
    prisma.recoveryCase.count({ where }),
  ]);

  return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getRecoveryCaseById(id: string) {
  const rc = await prisma.recoveryCase.findUnique({
    where: { id },
    include: { donorCredits: true },
  });
  if (!rc) throw new AppError('Recovery case not found', 404);
  return rc;
}

export async function getReconciliationReport() {
  const [byStatus, byType, pendingDue, totalCredits] = await Promise.all([
    prisma.recoveryCase.groupBy({ by: ['status'], _count: { id: true } }),
    prisma.recoveryCase.groupBy({ by: ['type'], _count: { id: true } }),
    prisma.recoveryCase.count({
      where: { nextRetryAt: { lte: new Date() }, status: RecoveryStatus.RETRYING },
    }),
    prisma.donorCredit.aggregate({ _sum: { amount: true }, _count: { id: true } }),
  ]);

  return {
    byStatus: byStatus.map((r) => ({ status: r.status, count: r._count.id })),
    byType: byType.map((r) => ({ type: r.type, count: r._count.id })),
    retriesDue: pendingDue,
    donorCredits: {
      total: totalCredits._count.id,
      totalAmount: totalCredits._sum.amount ?? 0,
    },
  };
}

// ─── Scheduled Retry Runner (called by a worker/cron) ────────────

export async function processScheduledRetries() {
  const due = await prisma.recoveryCase.findMany({
    where: {
      status: RecoveryStatus.RETRYING,
      nextRetryAt: { lte: new Date() },
    },
  });

  for (const rc of due) {
    try {
      if (rc.type === RecoveryCaseType.FAILED_REFUND) {
        await retryRefund(rc.id, 'system');
      } else if (rc.type === RecoveryCaseType.FAILED_DISTRIBUTION) {
        await retryDistribution(rc.id, 'system');
      }
    } catch (err) {
      logger.error(`Auto-retry failed for case ${rc.id}:`, err);
    }
  }

  logger.info(`Processed ${due.length} scheduled recovery retries`);
}
