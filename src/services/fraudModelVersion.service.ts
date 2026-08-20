import prisma from '../config/database';
import logger from '../config/logger';
import { AppError } from '../middleware/error';
import { invalidateFraudModelCache } from './kycFraud.service';

// Promotion gate (see fraudCalibration.service.evaluateCalibration()).
const ECE_PROMOTION_THRESHOLD = 0.05;
const AUC_PROMOTION_THRESHOLD = 0.75;

export interface CreateCandidateVersionInput {
  plattA: number;
  plattB: number;
  /** Inherited from the current active version's featureSchemaVersion when omitted. */
  featureSchemaVersion?: number;
  /** Explicit version label, e.g. "v1.1.0-candidate". Auto-generated when omitted. */
  version?: string;
  calibratedBy?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Creates a new FraudModelVersion in the CANDIDATE state (isActive=false, shadowMode=true).
 * Once assessFraud() has shadow-scored enough live traffic and
 * fraudCalibration.updateModelVersionMetrics() has recorded its ECE/AUC, promoteVersion()
 * can move it to ACTIVE.
 */
export async function createCandidateVersion(input: CreateCandidateVersionInput) {
  let featureSchemaVersion = input.featureSchemaVersion;

  if (featureSchemaVersion === undefined) {
    const activeVersion = await prisma.fraudModelVersion.findFirst({
      where: { isActive: true },
      orderBy: { calibratedAt: 'desc' },
      select: { featureSchemaVersion: true },
    });
    featureSchemaVersion = activeVersion?.featureSchemaVersion ?? 1;
  }

  const candidate = await prisma.fraudModelVersion.create({
    data: {
      version: input.version ?? `candidate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      plattA: input.plattA,
      plattB: input.plattB,
      isActive: false,
      shadowMode: true,
      featureSchemaVersion,
      calibratedBy: input.calibratedBy,
      metadata: input.metadata as any,
    },
  });

  // A new shadow candidate changes what assessFraud() should shadow-score against.
  await invalidateFraudModelCache();

  logger.info(`Created candidate FraudModelVersion ${candidate.id} (${candidate.version})`, {
    featureSchemaVersion,
  });

  return candidate;
}

/**
 * Atomically promotes a candidate FraudModelVersion to ACTIVE:
 *  1. Validates ece < 0.05 and auc > 0.75 (must already have been computed).
 *  2. In one transaction: deactivates every currently active version, then activates the
 *     candidate and clears its shadowMode flag, so a concurrent reader never observes zero
 *     or more than one active version.
 *  3. Invalidates the Platt-params Redis cache so the next assessFraud() call picks up the
 *     new version immediately instead of waiting out the TTL.
 */
export async function promoteVersion(candidateVersionId: string) {
  const candidate = await prisma.fraudModelVersion.findUnique({
    where: { id: candidateVersionId },
  });

  if (!candidate) {
    throw AppError.from('FRAUD_002', `FraudModelVersion ${candidateVersionId} not found`);
  }

  if (
    candidate.ece === null ||
    candidate.ece === undefined ||
    candidate.auc === null ||
    candidate.auc === undefined ||
    candidate.ece >= ECE_PROMOTION_THRESHOLD ||
    candidate.auc <= AUC_PROMOTION_THRESHOLD
  ) {
    throw AppError.from(
      'FRAUD_001',
      `FRAUD_MODEL_VERSION_NOT_READY: candidate ${candidateVersionId} has ece=${candidate.ece ?? 'null'} ` +
        `(must be < ${ECE_PROMOTION_THRESHOLD}), auc=${candidate.auc ?? 'null'} (must be > ${AUC_PROMOTION_THRESHOLD})`,
    );
  }

  const promotedAt = new Date();

  const promoted = await prisma.$transaction(async (tx: any) => {
    await tx.fraudModelVersion.updateMany({
      where: { isActive: true },
      data: { isActive: false },
    });

    return tx.fraudModelVersion.update({
      where: { id: candidateVersionId },
      data: {
        isActive: true,
        shadowMode: false,
        calibratedAt: promotedAt,
      },
    });
  });

  await invalidateFraudModelCache();

  logger.info(`Promoted FraudModelVersion ${candidateVersionId} to active`, {
    ece: candidate.ece,
    auc: candidate.auc,
    promotedAt,
  });

  return promoted;
}
