import prisma from '../config/database';
import { config } from '../config';
import logger from '../config/logger';

export interface FraudSignal {
  signal: string;
  severity: 'low' | 'medium' | 'high';
  detail: string;
}

export interface FraudAssessment {
  fraudScore: number;
  fraudSignals: FraudSignal[];
  fraudReason: string;
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

// ─── Third-Party Fraud Service ────────────────────────────────────────────────

export async function getThirdPartyFraudScore(
  input: FraudInput,
): Promise<{ score: number; signals: FraudSignal[] } | null> {
  if (!config.kycFraud.thirdPartyEnabled || !config.kycFraud.thirdPartyApiKey) return null;

  try {
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

  const [docSignal, velocitySignal, deviceSignal, geoSignal] = await Promise.all([
    checkDocumentReuse(input),
    checkVelocity(input),
    checkDeviceFingerprint(input),
    checkGeoAnomaly(input),
  ]);

  const signals: FraudSignal[] = [docSignal, velocitySignal, deviceSignal, geoSignal].filter(
    (s): s is FraudSignal => s !== null,
  );

  // Per-signal score contribution = weight * severity multiplier
  const severityMult = { low: 0.4, medium: 0.7, high: 1.0 };

  let score = 0;
  for (const sig of signals) {
    const mult = severityMult[sig.severity];
    if (sig.signal === 'documentReuse') score += weights.documentReuse * mult;
    else if (sig.signal === 'velocityRisk') score += weights.velocity * mult;
    else if (sig.signal === 'deviceFingerprintRisk') score += weights.deviceFingerprint * mult;
    else if (sig.signal === 'geoAnomaly') score += weights.geoAnomaly * mult;
  }

  const fraudScore = Math.min(Math.round(score), 100);
  const fraudReason =
    signals.length > 0
      ? signals.map((s) => s.detail).join('; ')
      : 'No fraud signals detected';

  return { fraudScore, fraudSignals: signals, fraudReason };
}
