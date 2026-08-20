import prisma from '../config/database';
import { config } from '../config';
import logger from '../config/logger';
import { getOrSet, delCache, buildKey } from '../utils/cache';
import { applyCalibration as routeCalibration } from './fraudCalibration.service';

// ─── Cache key for the active model parameters ────────────────────────────────
/**
 * Exported so the recalibration worker can call delCache(FRAUD_MODEL_PARAMS_CACHE_KEY)
 * immediately after the atomic version swap, ensuring assessFraud() sees the new
 * parameters within one cache TTL (or immediately on next request if uncached).
 */
export const FRAUD_MODEL_PARAMS_CACHE_KEY = buildKey('fraud', 'active-model-params');

export interface FraudSignal {
  signal: string;
  severity: 'low' | 'medium' | 'high';
  detail: string;
}

export interface FraudAssessment {
  fraudScore: number;
  fraudScoreFloat: number;
  fraudSignals: FraudSignal[];
  fraudReason: string;
  featureSnapshot: {
    rawScore: number;
    signals: FraudSignal[];
    interactionFeatures: InteractionFeatures;
  };
}

export interface InteractionFeatures {
  geoAnomalyHighAndVelocityHigh: number; // geoAnomaly=high AND velocity=high
  deviceFingerprintSharedAndSubmissionCount: number; // deviceFingerprint shared * submission count
  documentReuseAndGeoAnomaly: number; // documentReuse AND geoAnomaly
  highSeveritySignalCount: number; // Count of high-severity signals
}

export interface FraudInput {
  submissionId: string;
  beneficiaryId: string | null;
  userId: string;
  documentUrl: string;
  documentType: string;
  selfieUrl?: string | null;
  additionalDocs?: any;
  ipAddress?: string | null;
  userAgent?: string | null;
  deviceFingerprint?: string | null;
  claimedCountry?: string | null;
  claimedCity?: string | null;
}

// ─── Document Reuse Detection ─────────────────────────────────────────────────

export async function checkDocumentReuse(input: FraudInput): Promise<FraudSignal | null> {
  // Find other submissions with the same documentUrl or from the same user with same documentType
  const duplicates = await prisma.kYCSubmission.findMany({
    where: {
      id: { not: input.submissionId },
      OR: [
        { documentUrl: input.documentUrl },
        {
          userId: { not: input.userId },
          documentType: input.documentType,
          beneficiary: {
            idDocumentNumber: await getDocumentNumber(input.beneficiaryId),
          },
        },
      ],
    },
    select: { id: true, userId: true },
    take: 5,
  });

  if (duplicates.length === 0) return null;

  const crossAccount = duplicates.some((d: { id: string; userId: string }) => d.userId !== input.userId);
  return {
    signal: 'documentReuse',
    severity: crossAccount ? 'high' : 'medium',
    detail: `Document reused across ${duplicates.length} submission(s)${crossAccount ? ' from different accounts' : ''}`,
  };
}

async function getDocumentNumber(beneficiaryId: string | null): Promise<string | undefined> {
  if (!beneficiaryId) return undefined;
  const ben = await prisma.beneficiary.findUnique({
    where: { id: beneficiaryId },
    select: { idDocumentNumber: true },
  });
  return ben?.idDocumentNumber ?? undefined;
}

// ─── Velocity Checks ──────────────────────────────────────────────────────────

export async function checkVelocity(input: FraudInput): Promise<FraudSignal | null> {
  const { velocityWindowMinutes, velocityMaxSubmissionsPerIp, velocityMaxSubmissionsPerUser } =
    config.kycFraud;
  const windowStart = new Date(Date.now() - velocityWindowMinutes * 60 * 1000);

  const [perUser, perIp] = await Promise.all([
    prisma.kYCSubmission.count({
      where: {
        userId: input.userId,
        createdAt: { gte: windowStart },
        id: { not: input.submissionId },
      },
    }),
    input.ipAddress
      ? prisma.kYCSubmission.count({
          where: {
            ipAddress: input.ipAddress,
            createdAt: { gte: windowStart },
            id: { not: input.submissionId },
          },
        })
      : Promise.resolve(0),
  ]);

  if (perIp >= velocityMaxSubmissionsPerIp) {
    return {
      signal: 'velocityRisk',
      severity: 'high',
      detail: `${perIp + 1} submissions from IP ${input.ipAddress} within ${velocityWindowMinutes}min`,
    };
  }

  if (perUser >= velocityMaxSubmissionsPerUser) {
    return {
      signal: 'velocityRisk',
      severity: 'medium',
      detail: `${perUser + 1} submissions from user within ${velocityWindowMinutes}min`,
    };
  }

  return null;
}

// ─── Device Fingerprint Risk ──────────────────────────────────────────────────

export async function checkDeviceFingerprint(input: FraudInput): Promise<FraudSignal | null> {
  if (!input.deviceFingerprint) return null;

  const distinctUsers = await prisma.kYCSubmission.findMany({
    where: {
      deviceFingerprint: input.deviceFingerprint,
      id: { not: input.submissionId },
    },
    select: { userId: true },
    distinct: ['userId'],
  });

  if (distinctUsers.length === 0) return null;

  const uniqueUserCount = distinctUsers.length;
  return {
    signal: 'deviceFingerprintRisk',
    severity: uniqueUserCount >= 3 ? 'high' : 'medium',
    detail: `Device fingerprint linked to ${uniqueUserCount} other account(s)`,
  };
}

// ─── Geographic Anomaly Detection ─────────────────────────────────────────────

export async function checkGeoAnomaly(input: FraudInput): Promise<FraudSignal | null> {
  if (!input.claimedCountry) return null;

  // Look at the most recent prior submission for this user that has a claimed country
  const prior = await prisma.kYCSubmission.findFirst({
    where: {
      userId: input.userId,
      id: { not: input.submissionId },
      beneficiary: { country: { not: '' } },
    },
    orderBy: { createdAt: 'desc' },
    include: { beneficiary: { select: { country: true } } },
  });

  if (!prior?.beneficiary?.country) return null;

  const priorCountry = prior.beneficiary.country;
  if (priorCountry === input.claimedCountry) return null;

  // Calculate time delta
  const hoursDiff =
    (Date.now() - new Date(prior.createdAt).getTime()) / (1000 * 60 * 60);

  // Rough "impossible travel": different continents in under 2 hours
  const continentMap: Record<string, string> = buildContinentMap();
  const priorContinent = continentMap[priorCountry.toUpperCase()];
  const currContinent = continentMap[input.claimedCountry.toUpperCase()];

  if (priorContinent && currContinent && priorContinent !== currContinent && hoursDiff < 2) {
    return {
      signal: 'geoAnomaly',
      severity: 'high',
      detail: `Impossible travel: ${priorCountry} → ${input.claimedCountry} in ${hoursDiff.toFixed(1)}h`,
    };
  }

  if (priorCountry !== input.claimedCountry && hoursDiff < 0.5) {
    return {
      signal: 'geoAnomaly',
      severity: 'medium',
      detail: `Country changed from ${priorCountry} to ${input.claimedCountry} in ${(hoursDiff * 60).toFixed(0)} minutes`,
    };
  }

  return null;
}

function buildContinentMap(): Record<string, string> {
  // Partial map of ISO-3166 alpha-2 codes to continents for anomaly detection
  const map: Record<string, string> = {};
  const continents: [string, string[]][] = [
    ['AF', ['DZ','AO','BJ','BW','BF','BI','CM','CV','CF','TD','KM','CD','CG','CI','DJ','EG','GQ','ER','ET','GA','GM','GH','GN','GW','KE','LS','LR','LY','MG','MW','ML','MR','MU','YT','MA','MZ','NA','NE','NG','RW','ST','SN','SL','SO','ZA','SS','SD','SZ','TZ','TG','TN','UG','EH','ZM','ZW']],
    ['AS', ['AF','AM','AZ','BH','BD','BT','BN','KH','CN','CY','GE','IN','ID','IR','IQ','IL','JP','JO','KZ','KW','KG','LA','LB','MO','MY','MV','MN','MM','NP','KP','OM','PK','PS','PH','QA','SA','SG','KR','LK','SY','TW','TJ','TH','TL','TM','AE','UZ','VN','YE']],
    ['EU', ['AL','AD','AT','BY','BE','BA','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IS','IE','IT','LV','LI','LT','LU','MT','MD','MC','ME','NL','MK','NO','PL','PT','RO','RU','SM','RS','SK','SI','ES','SE','CH','UA','GB','VA']],
    ['NA', ['AG','BS','BB','BZ','CA','CR','CU','DM','DO','SV','GD','GT','HT','HN','JM','MX','NI','PA','KN','LC','VC','TT','US']],
    ['SA', ['AR','BO','BR','CL','CO','EC','GY','PY','PE','SR','UY','VE']],
    ['OC', ['AU','FJ','KI','MH','FM','NR','NZ','PW','PG','WS','SB','TO','TV','VU']],
  ];
  for (const [continent, codes] of continents) {
    for (const code of codes) map[code] = continent;
  }
  return map;
}

// ─── Interaction Features ───────────────────────────────────────────────────────

function computeInteractionFeatures(
  signals: FraudSignal[],
  submissionCount: number
): InteractionFeatures {
  const severityMap = new Map<string, 'low' | 'medium' | 'high'>();
  for (const sig of signals) {
    severityMap.set(sig.signal, sig.severity);
  }

  const geoSeverity = severityMap.get('geoAnomaly') || 'low';
  const velocitySeverity = severityMap.get('velocityRisk') || 'low';
  const deviceSeverity = severityMap.get('deviceFingerprintRisk') || 'low';
  const docSeverity = severityMap.get('documentReuse') || 'low';

  // Binary indicators for high severity
  const geoHigh = geoSeverity === 'high' ? 1 : 0;
  const velocityHigh = velocitySeverity === 'high' ? 1 : 0;
  const deviceShared = deviceSeverity !== 'low' ? 1 : 0;
  const docReuse = docSeverity !== 'low' ? 1 : 0;

  // Interaction features
  const geoAnomalyHighAndVelocityHigh = geoHigh * velocityHigh;
  const deviceFingerprintSharedAndSubmissionCount = deviceShared * Math.min(submissionCount, 10);
  const documentReuseAndGeoAnomaly = docReuse * geoHigh;
  const highSeveritySignalCount = signals.filter(s => s.severity === 'high').length;

  return {
    geoAnomalyHighAndVelocityHigh,
    deviceFingerprintSharedAndSubmissionCount,
    documentReuseAndGeoAnomaly,
    highSeveritySignalCount,
  };
}

async function getSubmissionCount(input: FraudInput): Promise<number> {
  const count = await prisma.kYCSubmission.count({
    where: {
      userId: input.userId,
      id: { not: input.submissionId },
    },
  });
  return count;
}

// ─── Active model version cache ───────────────────────────────────────────────

interface ActiveVersionCache {
  id: string;
  plattA: number;
  plattB: number;
  calibrationType: string;
  isotonicBreakpoints: unknown | null;
}

/** Default: identity Platt transform — maps raw score directly through sigmoid */
const DEFAULT_VERSION_CACHE: ActiveVersionCache = {
  id: '',
  plattA: 1,
  plattB: 0,
  calibrationType: 'platt',
  isotonicBreakpoints: null,
};

/**
 * Fetch the active FraudModelVersion, backed by Redis.
 * TTL is config.fraudRecalibration.cacheTtlSeconds (default 300 s).
 *
 * On cache miss the DB is queried; on Redis failure the DB is used directly.
 * After a recalibration version swap the worker calls
 * delCache(FRAUD_MODEL_PARAMS_CACHE_KEY) to force an immediate refresh.
 */
async function getActiveModelVersion(): Promise<ActiveVersionCache> {
  const ttl = config.fraudRecalibration.cacheTtlSeconds;

  return getOrSet<ActiveVersionCache>(
    FRAUD_MODEL_PARAMS_CACHE_KEY,
    ttl,
    async () => {
      try {
        const v = await prisma.fraudModelVersion.findFirst({
          where: { isActive: true },
          orderBy: { calibratedAt: 'desc' },
          select: {
            id: true,
            plattA: true,
            plattB: true,
            calibrationType: true,
            isotonicBreakpoints: true,
          },
        });

        if (v) {
          return {
            id: v.id,
            plattA: v.plattA,
            plattB: v.plattB,
            calibrationType: v.calibrationType,
            isotonicBreakpoints: v.isotonicBreakpoints,
          };
        }
      } catch (error) {
        logger.warn('Failed to fetch active model version, using defaults', { error });
      }

      return DEFAULT_VERSION_CACHE;
    },
  );
}

/**
 * Invalidate the active model params cache.
 * Called by the recalibration worker immediately after version swap.
 */
export async function invalidateFraudModelCache(): Promise<void> {
  await delCache(FRAUD_MODEL_PARAMS_CACHE_KEY);
}

// ─── Third-Party Fraud Service ────────────────────────────────────────────────

export async function getThirdPartyFraudScore(
  input: FraudInput,
): Promise<{ score: number; signals: FraudSignal[] } | null> {
  if (!config.kycFraud.thirdPartyEnabled || !config.kycFraud.thirdPartyApiKey) return null;

  try {
    // Use Node.js fetch if available (Node 18+), otherwise skip
    if (typeof fetch === 'undefined') {
      logger.warn('fetch API not available, skipping third-party fraud service');
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.kycFraud.thirdPartyTimeoutMs);

    const response = await fetch(config.kycFraud.thirdPartyApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.kycFraud.thirdPartyApiKey}`,
      },
      body: JSON.stringify({
        userId: input.userId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        deviceFingerprint: input.deviceFingerprint,
        documentType: input.documentType,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      logger.warn(`Third-party fraud service returned ${response.status}`);
      return null;
    }

    const result = await response.json() as { score?: number; signals?: FraudSignal[] };
    return {
      score: result.score ?? 0,
      signals: (result.signals ?? []).map((s: any) => ({
        signal: s.signal ?? 'thirdPartyFlag',
        severity: s.severity ?? 'medium',
        detail: s.detail ?? 'Third-party fraud signal',
      })),
    };
  } catch (err: any) {
    logger.warn('Third-party fraud service unavailable, skipping', { error: err.message });
    return null;
  }
}

// ─── Composite Fraud Assessment ───────────────────────────────────────────────

export async function assessFraud(input: FraudInput): Promise<FraudAssessment> {
  const { weights } = config.kycFraud;

  const [docSignal, velocitySignal, deviceSignal, geoSignal, submissionCount] = await Promise.all([
    checkDocumentReuse(input),
    checkVelocity(input),
    checkDeviceFingerprint(input),
    checkGeoAnomaly(input),
    getSubmissionCount(input),
  ]);

  const signals: FraudSignal[] = [docSignal, velocitySignal, deviceSignal, geoSignal].filter(
    (s): s is FraudSignal => s !== null,
  );

  // Per-signal score contribution = weight * severity multiplier
  const severityMult = { low: 0.4, medium: 0.7, high: 1.0 };

  let rawScore = 0;
  for (const sig of signals) {
    const mult = severityMult[sig.severity];
    if (sig.signal === 'documentReuse') rawScore += weights.documentReuse * mult;
    else if (sig.signal === 'velocityRisk') rawScore += weights.velocity * mult;
    else if (sig.signal === 'deviceFingerprintRisk') rawScore += weights.deviceFingerprint * mult;
    else if (sig.signal === 'geoAnomaly') rawScore += weights.geoAnomaly * mult;
  }

  // Compute interaction features
  const interactionFeatures = computeInteractionFeatures(signals, submissionCount);

  // Add interaction feature contributions to raw score
  const interactionWeights = {
    geoAnomalyHighAndVelocityHigh: 15,
    deviceFingerprintSharedAndSubmissionCount: 2,
    documentReuseAndGeoAnomaly: 10,
    highSeveritySignalCount: 5,
  };

  rawScore += interactionFeatures.geoAnomalyHighAndVelocityHigh * interactionWeights.geoAnomalyHighAndVelocityHigh;
  rawScore += interactionFeatures.deviceFingerprintSharedAndSubmissionCount * interactionWeights.deviceFingerprintSharedAndSubmissionCount;
  rawScore += interactionFeatures.documentReuseAndGeoAnomaly * interactionWeights.documentReuseAndGeoAnomaly;
  rawScore += interactionFeatures.highSeveritySignalCount * interactionWeights.highSeveritySignalCount;

  // Clamp raw score to 0-100 range
  rawScore = Math.max(0, Math.min(rawScore, 100));

  // Apply calibration — routes to Platt or isotonic based on the active version
  const activeVersion = await getActiveModelVersion();
  const calibratedProbability = routeCalibration(rawScore, activeVersion.id ? activeVersion : null);

  // Convert to integer score for UI compatibility (0-100)
  const fraudScore = Math.round(calibratedProbability * 100);
  const fraudScoreFloat = calibratedProbability;

  const fraudReason =
    signals.length > 0
      ? signals.map((s) => s.detail).join('; ')
      : 'No fraud signals detected';

  return {
    fraudScore,
    fraudScoreFloat,
    fraudSignals: signals,
    fraudReason,
    featureSnapshot: {
      rawScore,
      signals,
      interactionFeatures,
    },
  };
}

// ─── Feedback Loop: Fraud Label Creation ───────────────────────────────────────

export async function createFraudLabel(
  submissionId: string,
  outcome: 'APPROVED' | 'REJECTED',
  reviewedBy: string,
  assessment: FraudAssessment
): Promise<void> {
  try {
    // Get active model version
    const activeVersion = await prisma.fraudModelVersion.findFirst({
      where: { isActive: true },
      orderBy: { calibratedAt: 'desc' },
    });

    if (!activeVersion) {
      logger.warn('No active fraud model version found, skipping label creation');
      return;
    }

    // Check if label already exists
    const existing = await prisma.fraudLabel.findUnique({
      where: { submissionId },
    });

    if (existing) {
      logger.info(`FraudLabel already exists for submission ${submissionId}, skipping`);
      return;
    }

    // Create fraud label
    await prisma.fraudLabel.create({
      data: {
        submissionId,
        modelVersionId: activeVersion.id,
        outcome,
        reviewedBy,
        reviewedAt: new Date(),
        featureSnapshot: assessment.featureSnapshot as any,
        fraudScore: assessment.fraudScore,
        fraudScoreFloat: assessment.fraudScoreFloat,
      },
    });

    logger.info(`FraudLabel created for submission ${submissionId} with outcome ${outcome}`);

    // ── Label-count trigger: enqueue recalibration if threshold crossed ──────
    // Count labels since the active version was last calibrated (non-blocking)
    const { labelTrigger } = config.fraudRecalibration;
    try {
      const labelCount = await prisma.fraudLabel.count({
        where: { modelVersionId: activeVersion.id },
      });

      // Trigger on exact multiples of labelTrigger to avoid repeated enqueueing.
      // e.g. trigger at 200, 400, 600 ... labels.
      if (labelCount > 0 && labelCount % labelTrigger === 0) {
        // Lazy import to avoid circular dependency at module load time.
        // node16 moduleResolution: use .js extension (compiled output)
        const { enqueueFraudRecalibration } = await import('../workers/fraudRecalibration.worker.js');
        await enqueueFraudRecalibration(
          `label-count-trigger:${labelCount}:version:${activeVersion.id}`,
        );
        logger.info(
          `Fraud recalibration triggered at label count ${labelCount} ` +
          `for version ${activeVersion.id}`,
        );
      }
    } catch (triggerErr) {
      // Never let trigger failure affect label creation
      logger.warn('Failed to check label trigger for recalibration', { error: triggerErr });
    }
  } catch (error) {
    logger.error('Failed to create FraudLabel', { error, submissionId });
    // Don't throw - label creation failure should not block KYC review
  }
}
