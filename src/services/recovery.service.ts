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
import { SagaOrchestrator } from '../saga/SagaOrchestrator';
import {
  campaignSettlementSaga,
  CampaignSettlementInput,
} from '../saga/sagas/campaignSettlement.saga';

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

  // Pre-fetch donor info for notification (before transaction)
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    include: { user: { select: { id: true } } },
  });

  const rc = await prisma.$transaction(async (tx) => {
    const created = await tx.recoveryCase.create({
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

    await tx.auditLog.create({
      data: {
        userId: null,
        action: AuditAction.RECOVERY_CASE_CREATED,
        entityType: 'RecoveryCase',
        entityId: created.id,
        metadata: { type: created.type, donationId, failureReason },
      },
    });

    if (donation?.userId) {
      await tx.notification.create({
        data: {
          userId: donation.userId,
          type: NotificationType.REFUND_FAILED,
          title: 'Refund Transfer Failed',
          message: `Your refund for donation ${donationId} could not be processed: ${failureReason}. We are retrying automatically.`,
          metadata: { recoveryCaseId: created.id },
          sentVia: [],
        },
      });
    }

    return created;
  });

  logger.info(`Recovery case created [FAILED_REFUND]: ${rc.id}`);
  return rc;
}

/**
 * @notice Dead-letter case for a recurring pledge whose payment has failed
 * MAX_RETRIES times within a single billing cycle (see pledge.worker.ts).
 * Notifies the donor and creates an admin-facing recovery case, mirroring
 * createFailedRefundCase's shape.
 */
export async function createFailedPledgeCase(
  pledgeId: string,
  donorUserId: string,
  failureReason: string,
  failureMetadata?: object
) {
  const existing = await prisma.recoveryCase.findFirst({
    where: {
      pledgeId,
      type: RecoveryCaseType.FAILED_PLEDGE,
      status: { notIn: [RecoveryStatus.RECOVERED, RecoveryStatus.FAILED_PERMANENTLY] },
    },
  });
  if (existing) return existing;

  const rc = await prisma.$transaction(async (tx) => {
    const created = await tx.recoveryCase.create({
      data: {
        type: RecoveryCaseType.FAILED_PLEDGE,
        pledgeId,
        failureReason,
        ...(failureMetadata !== undefined ? { failureMetadata } : {}),
        status: RecoveryStatus.PENDING,
        maxRetries: MAX_RETRIES,
        nextRetryAt: nextRetryAt(0),
      },
    });

    await tx.auditLog.create({
      data: {
        userId: null,
        action: AuditAction.RECOVERY_CASE_CREATED,
        entityType: 'RecoveryCase',
        entityId: created.id,
        metadata: { type: created.type, pledgeId, failureReason },
      },
    });

    if (donorUserId) {
      await tx.notification.create({
        data: {
          userId: donorUserId,
          type: NotificationType.PLEDGE_PAYMENT_FAILED,
          title: 'Pledge Payment Failed',
          message: `We were unable to process your pledge payment after multiple attempts: ${failureReason}. Our team has been notified and will follow up.`,
          metadata: { recoveryCaseId: created.id, pledgeId },
          sentVia: [],
        },
      });
    }

    return created;
  });

  logger.info(`Recovery case created [FAILED_PLEDGE]: ${rc.id}`);
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

  const rc = await prisma.$transaction(async (tx) => {
    const created = await tx.recoveryCase.create({
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

    await tx.auditLog.create({
      data: {
        userId: null,
        action: AuditAction.RECOVERY_CASE_CREATED,
        entityType: 'RecoveryCase',
        entityId: created.id,
        metadata: { type: created.type, distributionId, failureReason },
      },
    });

    return created;
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
  if (!rc) throw AppError.from('RECOVERY_001');
  if (rc.type !== RecoveryCaseType.FAILED_REFUND)
    throw AppError.from('RECOVERY_002', 'Not a FAILED_REFUND case');
  if (rc.status === RecoveryStatus.RECOVERED || rc.status === RecoveryStatus.FAILED_PERMANENTLY)
    throw AppError.from('RECOVERY_003', 'Case is already resolved');

  const newCount = rc.retryCount + 1;
  const isPermanentFailure = newCount >= rc.maxRetries;

  // Pre-fetch donor info if permanent failure (before transaction)
  let donationUserId: string | undefined;
  if (isPermanentFailure && rc.donationId) {
    const donation = await prisma.donation.findUnique({
      where: { id: rc.donationId },
      include: { user: { select: { id: true } } },
    });
    donationUserId = donation?.userId;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.recoveryCase.update({
      where: { id: recoveryCaseId },
      data: {
        status: isPermanentFailure ? RecoveryStatus.FAILED_PERMANENTLY : RecoveryStatus.RETRYING,
        retryCount: newCount,
        lastRetriedAt: new Date(),
        nextRetryAt: isPermanentFailure ? null : nextRetryAt(newCount),
      },
    });

    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: AuditAction.RECOVERY_RETRIED,
        entityType: 'RecoveryCase',
        entityId: rc.id,
        metadata: { retryCount: newCount, isPermanentFailure },
      },
    });

    if (isPermanentFailure && donationUserId) {
      await tx.notification.create({
        data: {
          userId: donationUserId,
          type: NotificationType.REFUND_FAILED,
          title: 'Refund Could Not Be Completed',
          message: 'All retry attempts for your refund have been exhausted. Our team will contact you with alternate options.',
          metadata: { recoveryCaseId: rc.id },
          sentVia: [],
        },
      });
    }

    return result;
  });

  logger.info(`Refund retried: case ${rc.id}, attempt ${newCount}`);
  return updated;
}

export async function retryDistribution(recoveryCaseId: string, adminId: string) {
  const rc = await prisma.recoveryCase.findUnique({ where: { id: recoveryCaseId } });
  if (!rc) throw AppError.from('RECOVERY_001');
  if (rc.type !== RecoveryCaseType.FAILED_DISTRIBUTION)
    throw AppError.from('RECOVERY_002', 'Not a FAILED_DISTRIBUTION case');
  if (rc.status === RecoveryStatus.RECOVERED || rc.status === RecoveryStatus.FAILED_PERMANENTLY)
    throw AppError.from('RECOVERY_003', 'Case is already resolved');

  const newCount = rc.retryCount + 1;
  const isPermanentFailure = newCount >= rc.maxRetries;

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.recoveryCase.update({
      where: { id: recoveryCaseId },
      data: {
        status: isPermanentFailure ? RecoveryStatus.RECOVERY_REQUIRED : RecoveryStatus.RETRYING,
        retryCount: newCount,
        lastRetriedAt: new Date(),
        nextRetryAt: isPermanentFailure ? null : nextRetryAt(newCount),
      },
    });

    if (rc.distributionId) {
      await tx.distribution.update({
        where: { id: rc.distributionId },
        data: { status: DistributionStatus.IN_PROGRESS },
      });
    }

    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: AuditAction.RECOVERY_RETRIED,
        entityType: 'RecoveryCase',
        entityId: rc.id,
        metadata: { retryCount: newCount, isPermanentFailure },
      },
    });

    return result;
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
  if (!rc) throw AppError.from('RECOVERY_001');
  if (rc.type !== RecoveryCaseType.FAILED_REFUND)
    throw AppError.from('RECOVERY_002', 'Not a FAILED_REFUND case');

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.recoveryCase.update({
      where: { id: recoveryCaseId },
      data: {
        failureMetadata: { ...((rc.failureMetadata ?? {}) as any), updatedBankAccount: newAccount },
        status: RecoveryStatus.PENDING,
        nextRetryAt: nextRetryAt(0),
      },
    });

    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: AuditAction.RECOVERY_MANUAL_OVERRIDE,
        entityType: 'RecoveryCase',
        entityId: rc.id,
        metadata: { action: 'updateRefundDestination', newAccount },
      },
    });

    return result;
  });

  logger.info(`Refund destination updated: case ${rc.id} by admin ${adminId}`);
  return updated;
}

export async function markDistributionRecoveryRequired(recoveryCaseId: string, adminId: string) {
  const rc = await prisma.recoveryCase.findUnique({ where: { id: recoveryCaseId } });
  if (!rc) throw AppError.from('RECOVERY_001');
  if (rc.type !== RecoveryCaseType.FAILED_DISTRIBUTION)
    throw AppError.from('RECOVERY_002', 'Not a FAILED_DISTRIBUTION case');

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.recoveryCase.update({
      where: { id: recoveryCaseId },
      data: { status: RecoveryStatus.RECOVERY_REQUIRED },
    });

    if (rc.distributionId) {
      await tx.distribution.update({
        where: { id: rc.distributionId },
        data: { status: DistributionStatus.FAILED },
      });
    }

    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: AuditAction.RECOVERY_MANUAL_OVERRIDE,
        entityType: 'RecoveryCase',
        entityId: rc.id,
        metadata: { action: 'markRecoveryRequired' },
      },
    });

    return result;
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
  if (!rc) throw AppError.from('RECOVERY_001');
  if (rc.type !== RecoveryCaseType.CANCELLED_CAMPAIGN_FUNDS)
    throw AppError.from('RECOVERY_002', 'Not a CANCELLED_CAMPAIGN_FUNDS case');
  if (rc.status === RecoveryStatus.RECOVERED) throw AppError.from('RECOVERY_003', 'Case is already settled');
  if (!rc.campaignId) throw AppError.from('RECOVERY_004', 'No campaign linked to this case');

  if (option === SettlementOption.TRANSFER_TO_CAMPAIGN) {
    if (!targetCampaignId)
      throw AppError.from('RECOVERY_004', 'targetCampaignId required for TRANSFER_TO_CAMPAIGN');
    const target = await prisma.campaign.findUnique({ where: { id: targetCampaignId } });
    if (!target || target.status !== CampaignStatus.ACTIVE)
      throw AppError.from('RECOVERY_004', 'Target campaign not found or not active');
  }

  // ─── REFUND_TO_DONOR: use the saga for durable, compensable execution ────
  if (option === SettlementOption.REFUND_TO_DONOR) {
    const sagaInput: CampaignSettlementInput = {
      recoveryCaseId,
      campaignId: rc.campaignId,
      adminId,
      notes,
      settlementOption: option,
    };

    const result = await SagaOrchestrator.execute(campaignSettlementSaga, sagaInput);

    if (!result.success) {
      throw result.error;
    }

    await writeAuditLog(adminId, AuditAction.RECOVERY_SETTLED, 'RecoveryCase', rc.id, {
      option,
      notes,
      sagaId: result.sagaId,
    });

    logger.info(
      `Campaign settlement completed (REFUND_TO_DONOR): case ${rc.id} sagaId=${result.sagaId}`,
    );

    return prisma.recoveryCase.findUnique({ where: { id: rc.id } });
  }

  // ─── TRANSFER_TO_CAMPAIGN and RETAIN_IN_ESCROW remain synchronous ────────
  // These don't involve iterating over many donations so saga wrapping is
  // not necessary. They are kept as simple transactions for simplicity.
  const campaign = await prisma.campaign.findUnique({
    where: { id: rc.campaignId },
    include: {
      donations: { where: { status: DonationStatus.CONFIRMED } },
    },
  });
  if (!campaign) throw AppError.from('CAMPAIGN_002');

  await prisma.$transaction(async (tx) => {
    if (option === SettlementOption.TRANSFER_TO_CAMPAIGN && targetCampaignId) {
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
  if (!rc) throw AppError.from('RECOVERY_001');

  const credit = await prisma.$transaction(async (tx) => {
    const created = await tx.donorCredit.create({
      data: {
        userId,
        recoveryCaseId,
        amount,
        currency,
        reason,
        expiresAt: expiresAt ?? null,
      },
    });

    await tx.notification.create({
      data: {
        userId,
        type: NotificationType.DONOR_CREDIT_ISSUED,
        title: 'Donor Credit Issued',
        message: `You have been issued a credit of ${amount} ${currency} as compensation. ${reason}`,
        metadata: { donorCreditId: created.id, recoveryCaseId },
        sentVia: [],
      },
    });

    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: AuditAction.DONOR_CREDIT_ISSUED,
        entityType: 'DonorCredit',
        entityId: created.id,
        metadata: { userId, amount, currency, reason },
      },
    });

    return created;
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
  if (!rc) throw AppError.from('RECOVERY_001');
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
