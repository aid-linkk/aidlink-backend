import prisma from '../config/database';
import redis from '../config/redis';
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
  // Calibrated probability from a shadow (candidate) FraudModelVersion, present only when
  // one exists. Never used for the decision — that's always fraudScore/fraudScoreFloat.
  shadowScore?: number;
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
  /**
   * The createdAt timestamp of the current KYC submission.
   * Used by checkGeoAnomaly() to compute time-delta against prior submissions
   * using submission timestamps rather than Date.now(), so delayed fraud-detection
   * jobs (e.g. queued during a worker outage) still see the correct delta.
   * Defaults to Date.now() if not provided, but callers should always supply it.
   */
  submittedAt?: Date;
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

/**
 * Load country centroid data at module initialisation time.
 * The JSON file is bundled in the repository so there is no external API call at
 * assessment time — the entire lookup is an in-process object property access.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const COUNTRY_CENTROIDS: Record<string, { lat: number; lng: number }> = require('../../data/country-centroids.json');

/**
 * Haversine great-circle distance between two lat/lng points (in km).
 *
 * Formula:
 *   Δlat = lat2 − lat1  (radians)
 *   Δlng = lng2 − lng1  (radians)
 *   a    = sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlng/2)
 *   c    = 2·atan2(√a, √(1−a))
 *   d    = R·c           (R = 6371 km)
 */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Check a single (from, to) country pair for impossible travel given the elapsed
 * hours between them. Returns a FraudSignal or null.
 *
 * Priority:
 * 1. Both countries have centroids → Haversine speed check (high/medium by speed).
 * 2. One or both countries missing centroids → fall back to continent-level check
 *    with severity capped at 'medium' (reduced precision).
 */
function checkCountryPair(
  fromCountry: string,
  toCountry: string,
  hoursDiff: number,
): FraudSignal | null {
  if (fromCountry === toCountry) return null;

  // Avoid division by zero; sub-second hops are treated as 0.001 h (~3.6 seconds)
  const effectiveHours = Math.max(hoursDiff, 0.001);

  const fromCentroid = COUNTRY_CENTROIDS[fromCountry.toUpperCase()];
  const toCentroid = COUNTRY_CENTROIDS[toCountry.toUpperCase()];

  if (fromCentroid && toCentroid) {
    // Primary path: Haversine speed check
    const distanceKm = haversineKm(fromCentroid.lat, fromCentroid.lng, toCentroid.lat, toCentroid.lng);
    const speedKmh = distanceKm / effectiveHours;

    if (speedKmh > config.kycFraud.geoMaxPlausibleSpeedKmh) {
      return {
        signal: 'geoAnomaly',
        severity: 'high',
        detail: `Impossible travel: ${fromCountry} → ${toCountry} in ${hoursDiff.toFixed(2)}h (~${Math.round(distanceKm)} km, ~${Math.round(speedKmh)} km/h)`,
      };
    }
    return null;
  }

  // Fallback path: one or both country codes not in centroid dataset
  // Use continent-level check with severity capped at 'medium'
  const continentMap = buildContinentMap();
  const fromContinent = continentMap[fromCountry.toUpperCase()];
  const toContinent = continentMap[toCountry.toUpperCase()];

  if (fromContinent && toContinent && fromContinent !== toContinent && hoursDiff < 2) {
    return {
      signal: 'geoAnomaly',
      severity: 'medium',
      detail: `Possible impossible travel (coarse check): ${fromCountry} → ${toCountry} in ${hoursDiff.toFixed(2)}h (centroid data unavailable)`,
    };
  }

  if (hoursDiff < 0.5) {
    return {
      signal: 'geoAnomaly',
      severity: 'medium',
      detail: `Country changed from ${fromCountry} to ${toCountry} in ${(hoursDiff * 60).toFixed(0)} minutes (centroid data unavailable)`,
    };
  }

  return null;
}

export async function checkGeoAnomaly(input: FraudInput): Promise<FraudSignal | null> {
  if (!input.claimedCountry) return null;

  const { geoAnomalyLookback } = config.kycFraud;

  // Retrieve the last N prior submissions (chronological order: oldest first)
  const priors = await prisma.kYCSubmission.findMany({
    where: {
      userId: input.userId,
      id: { not: input.submissionId },
      beneficiary: { country: { not: '' } },
    },
    orderBy: { createdAt: 'desc' },
    take: geoAnomalyLookback,
    include: { beneficiary: { select: { country: true } } },
  });

  if (priors.length === 0) return null;

  // Reverse to get chronological order (oldest → newest) for sequential pair iteration
  const chronological = [...priors].reverse();

  // The current submission's effective timestamp — use the passed-in submittedAt if available
  // so that delayed fraud-detection jobs still see the correct delta.
  const currentTs = input.submittedAt ?? new Date();

  // Build the full sequence: ...prior submissions... + current
  // Each element: { country, createdAt }
  const sequence: Array<{ country: string; createdAt: Date }> = [
    ...chronological
      .filter(p => p.beneficiary?.country)
      .map(p => ({ country: p.beneficiary!.country!, createdAt: new Date(p.createdAt) })),
    { country: input.claimedCountry, createdAt: currentTs },
  ];

  // Check each consecutive pair in the sequence for impossible travel
  for (let i = sequence.length - 2; i >= 0; i--) {
    const from = sequence[i];
    const to = sequence[i + 1];

    const hoursDiff =
      (to.createdAt.getTime() - from.createdAt.getTime()) / (1000 * 60 * 60);

    // Skip pairs where current entry is not later than prior (clock skew guard)
    if (hoursDiff < 0) continue;

    const signal = checkCountryPair(from.country, to.country, hoursDiff);
    if (signal) return signal;
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

interface ModelVersionPair {
  active: ActiveVersionCache;
  candidate: { id: string; plattA: number; plattB: number } | null;
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
 * Fetch the active FraudModelVersion and optional shadow candidate, backed by Redis.
 * TTL is config.fraudRecalibration.cacheTtlSeconds (default 300 s).
 *
 * Returns both the active version (used for the decision) and a candidate version
 * in shadow mode (used for A/B scoring only — never affects the decision).
 *
 * On cache miss the DB is queried via findMany; on Redis failure the DB is used directly.
 * After a recalibration version swap the worker calls
 * delCache(FRAUD_MODEL_PARAMS_CACHE_KEY) to force an immediate refresh.
 */
async function getModelVersions(): Promise<ModelVersionPair> {
  const ttl = config.fraudRecalibration.cacheTtlSeconds;

  return getOrSet<ModelVersionPair>(
    FRAUD_MODEL_PARAMS_CACHE_KEY,
    ttl,
    async () => {
      try {
        const versions = await prisma.fraudModelVersion.findMany({
          where: {
            OR: [{ isActive: true }, { shadowMode: true }],
          },
          orderBy: { calibratedAt: 'desc' },
          select: {
            id: true,
            plattA: true,
            plattB: true,
            calibrationType: true,
            isotonicBreakpoints: true,
            isActive: true,
            shadowMode: true,
          },
        });

        const activeRow = versions.find((v: any) => v.isActive);
        const candidateRow = versions.find((v: any) => v.shadowMode && !v.isActive);

        const active: ActiveVersionCache = activeRow
          ? {
              id: activeRow.id,
              plattA: activeRow.plattA,
              plattB: activeRow.plattB,
              calibrationType: activeRow.calibrationType,
              isotonicBreakpoints: activeRow.isotonicBreakpoints,
            }
          : DEFAULT_VERSION_CACHE;

        const candidate = candidateRow
          ? { id: candidateRow.id, plattA: candidateRow.plattA, plattB: candidateRow.plattB }
          : null;

        return { active, candidate };
      } catch (error) {
        logger.warn('Failed to fetch model versions, using defaults', { error });
        return { active: DEFAULT_VERSION_CACHE, candidate: null };
      }
    },
  );
}

/**
 * Fetch just the active model version (used by routeCalibration).
 * Delegates to getModelVersions() so we only hit the DB once per cache window.
 */
async function getActiveModelVersion(): Promise<ActiveVersionCache> {
  const pair = await getModelVersions();
  return pair.active;
}

/**
 * Invalidate the active model params cache.
 * Called by the recalibration worker immediately after version swap.
 */
export async function invalidateFraudModelCache(): Promise<void> {
  await delCache(FRAUD_MODEL_PARAMS_CACHE_KEY);
}

/**
 * Apply Platt sigmoid scaling to a raw score.
 * p = 1 / (1 + exp(-(A * rawScore + B)))
 */
function applyPlattScaling(rawScore: number, params: { A: number; B: number }): number {
  const z = params.A * rawScore + params.B;
  const clampedZ = Math.max(Math.min(z, 35), -35);
  return 1 / (1 + Math.exp(-clampedZ));
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
  const { active: activeVersion, candidate } = await getModelVersions();
  const calibratedProbability = routeCalibration(rawScore, activeVersion.id ? activeVersion : null);

  // Convert to integer score for UI compatibility (0-100)
  const fraudScore = Math.round(calibratedProbability * 100);
  const fraudScoreFloat = calibratedProbability;

  const fraudReason =
    signals.length > 0
      ? signals.map((s) => s.detail).join('; ')
      : 'No fraud signals detected';

  // Shadow scoring: score under the candidate's Platt parameters for A/B comparison, but
  // never use it for the decision. Short-circuits with zero extra work when no candidate
  // is in shadow mode.
  let shadowScore: number | undefined;
  if (candidate) {
    shadowScore = applyPlattScaling(rawScore, { A: candidate.plattA, B: candidate.plattB });
    try {
      await prisma.kYCSubmission.update({
        where: { id: input.submissionId },
        data: { shadowScore },
      });
    } catch (error) {
      logger.warn('Failed to persist shadow score', { error, submissionId: input.submissionId });
    }
  }

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
    ...(shadowScore !== undefined ? { shadowScore } : {}),
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
        featureSchemaVersion: activeVersion.featureSchemaVersion,
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
