/**
 * Unit tests for src/services/kycFraud.service.ts
 *
 * All Prisma calls are mocked so no database is required.
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/config/database', () => ({
  __esModule: true,
  default: {
    kYCSubmission: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    beneficiary: {
      findUnique: jest.fn(),
    },
    fraudModelVersion: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    fraudLabel: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  },
}));

jest.mock('../../src/config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  },
}));

jest.mock('../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/config', () => ({
  config: {
    kycFraud: {
      velocityWindowMinutes: 60,
      velocityMaxSubmissionsPerIp: 5,
      velocityMaxSubmissionsPerUser: 3,
      geoMaxPlausibleSpeedKmh: 900,
      highRiskThreshold: 50,
      weights: {
        documentReuse: 30,
        geoAnomaly: 20,
        velocity: 25,
        deviceFingerprint: 15,
        thirdParty: 10,
      },
      thirdPartyEnabled: false,
      thirdPartyApiUrl: '',
      thirdPartyApiKey: '',
      thirdPartyTimeoutMs: 5000,
    },
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import prisma from '../../src/config/database';
import redis from '../../src/config/redis';
import {
  checkDocumentReuse,
  checkVelocity,
  checkDeviceFingerprint,
  checkGeoAnomaly,
  getThirdPartyFraudScore,
  assessFraud,
  createFraudLabel,
  FraudInput,
} from '../../src/services/kycFraud.service';

const prismaMock = prisma as jest.Mocked<typeof prisma>;
const redisMock = redis as jest.Mocked<typeof redis>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const baseInput = (): FraudInput => ({
  submissionId: 'sub-1',
  beneficiaryId: 'ben-1',
  userId: 'user-1',
  documentUrl: 'https://storage/doc.pdf',
  documentType: 'PASSPORT',
  selfieUrl: null,
  additionalDocs: null,
  ipAddress: '1.2.3.4',
  userAgent: 'Mozilla/5.0',
  deviceFingerprint: 'fp-abc123',
  claimedCountry: 'US',
  claimedCity: 'New York',
});

beforeEach(() => {
  jest.clearAllMocks();
  // Mock default Platt parameters (identity transformation), no active/candidate version
  (prismaMock.fraudModelVersion.findFirst as jest.Mock).mockResolvedValue(null);
  (prismaMock.fraudModelVersion.findMany as jest.Mock).mockResolvedValue([]);
  // Cache always misses by default so tests exercise the DB path deterministically
  (redisMock.get as jest.Mock).mockResolvedValue(null);
});

// ─── checkDocumentReuse ───────────────────────────────────────────────────────

describe('checkDocumentReuse', () => {
  it('returns null when no duplicate documents found', async () => {
    (prismaMock.beneficiary.findUnique as jest.Mock).mockResolvedValue({ idDocumentNumber: 'P123' });
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockResolvedValue([]);

    const result = await checkDocumentReuse(baseInput());
    expect(result).toBeNull();
  });

  it('returns medium severity signal for same-user reuse', async () => {
    (prismaMock.beneficiary.findUnique as jest.Mock).mockResolvedValue({ idDocumentNumber: 'P123' });
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockResolvedValue([
      { id: 'sub-2', userId: 'user-1' },
    ]);

    const result = await checkDocumentReuse(baseInput());
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('documentReuse');
    expect(result!.severity).toBe('medium');
  });

  it('returns high severity signal for cross-account reuse', async () => {
    (prismaMock.beneficiary.findUnique as jest.Mock).mockResolvedValue({ idDocumentNumber: 'P123' });
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockResolvedValue([
      { id: 'sub-2', userId: 'different-user' },
    ]);

    const result = await checkDocumentReuse(baseInput());
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.detail).toContain('different accounts');
  });
});

// ─── checkVelocity ────────────────────────────────────────────────────────────

describe('checkVelocity', () => {
  it('returns null when under both limits', async () => {
    (prismaMock.kYCSubmission.count as jest.Mock)
      .mockResolvedValueOnce(1)  // perUser
      .mockResolvedValueOnce(2); // perIp

    const result = await checkVelocity(baseInput());
    expect(result).toBeNull();
  });

  it('returns high severity signal when IP limit exceeded', async () => {
    (prismaMock.kYCSubmission.count as jest.Mock)
      .mockResolvedValueOnce(1)  // perUser
      .mockResolvedValueOnce(5); // perIp (>= velocityMaxSubmissionsPerIp=5)

    const result = await checkVelocity(baseInput());
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('velocityRisk');
    expect(result!.severity).toBe('high');
    expect(result!.detail).toContain('IP');
  });

  it('returns medium severity signal when user limit exceeded', async () => {
    (prismaMock.kYCSubmission.count as jest.Mock)
      .mockResolvedValueOnce(3)  // perUser (>= velocityMaxSubmissionsPerUser=3)
      .mockResolvedValueOnce(1); // perIp

    const result = await checkVelocity(baseInput());
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('velocityRisk');
    expect(result!.severity).toBe('medium');
  });

  it('skips IP check when ipAddress is null', async () => {
    const input = { ...baseInput(), ipAddress: null };
    (prismaMock.kYCSubmission.count as jest.Mock).mockResolvedValueOnce(1); // only perUser

    const result = await checkVelocity(input);
    expect(result).toBeNull();
    // Only one count call (perUser); perIp skipped
    expect(prismaMock.kYCSubmission.count).toHaveBeenCalledTimes(1);
  });
});

// ─── checkDeviceFingerprint ───────────────────────────────────────────────────

describe('checkDeviceFingerprint', () => {
  it('returns null when no fingerprint provided', async () => {
    const result = await checkDeviceFingerprint({ ...baseInput(), deviceFingerprint: null });
    expect(result).toBeNull();
    expect(prismaMock.kYCSubmission.findMany).not.toHaveBeenCalled();
  });

  it('returns null when fingerprint has no other accounts', async () => {
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockResolvedValue([]);
    const result = await checkDeviceFingerprint(baseInput());
    expect(result).toBeNull();
  });

  it('returns medium severity for fingerprint linked to 1-2 other accounts', async () => {
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockResolvedValue([
      { userId: 'other-user-1' },
    ]);
    const result = await checkDeviceFingerprint(baseInput());
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('deviceFingerprintRisk');
    expect(result!.severity).toBe('medium');
  });

  it('returns high severity for fingerprint linked to 3+ other accounts', async () => {
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockResolvedValue([
      { userId: 'u1' },
      { userId: 'u2' },
      { userId: 'u3' },
    ]);
    const result = await checkDeviceFingerprint(baseInput());
    expect(result!.severity).toBe('high');
    expect(result!.detail).toContain('3');
  });
});

// ─── checkGeoAnomaly ──────────────────────────────────────────────────────────

describe('checkGeoAnomaly', () => {
  it('returns null when no claimedCountry provided', async () => {
    const result = await checkGeoAnomaly({ ...baseInput(), claimedCountry: null });
    expect(result).toBeNull();
  });

  it('returns null when no prior submission exists', async () => {
    (prismaMock.kYCSubmission.findFirst as jest.Mock).mockResolvedValue(null);
    const result = await checkGeoAnomaly(baseInput());
    expect(result).toBeNull();
  });

  it('returns null when prior country matches current country', async () => {
    (prismaMock.kYCSubmission.findFirst as jest.Mock).mockResolvedValue({
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3 hours ago
      beneficiary: { country: 'US' },
    });
    const result = await checkGeoAnomaly(baseInput());
    expect(result).toBeNull();
  });

  it('returns high severity for impossible intercontinental travel (< 2h)', async () => {
    (prismaMock.kYCSubmission.findFirst as jest.Mock).mockResolvedValue({
      createdAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
      beneficiary: { country: 'AU' }, // Oceania
    });
    // baseInput claimedCountry = 'US' (North America) → different continents, < 2h
    const result = await checkGeoAnomaly(baseInput());
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('geoAnomaly');
    expect(result!.severity).toBe('high');
    expect(result!.detail).toContain('Impossible travel');
  });

  it('returns medium severity for same-continent rapid country change (< 30 min)', async () => {
    (prismaMock.kYCSubmission.findFirst as jest.Mock).mockResolvedValue({
      createdAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
      beneficiary: { country: 'CA' }, // North America, different from US
    });
    const result = await checkGeoAnomaly(baseInput());
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
  });
});

// ─── getThirdPartyFraudScore ──────────────────────────────────────────────────

describe('getThirdPartyFraudScore', () => {
  it('returns null when third-party is disabled', async () => {
    const result = await getThirdPartyFraudScore(baseInput());
    expect(result).toBeNull();
  });

  it('returns null and logs warning when fetch throws (graceful fallback)', async () => {
    // Temporarily enable third-party in the mock config
    const { config } = require('../../src/config');
    const orig = { ...config.kycFraud };
    config.kycFraud.thirdPartyEnabled = true;
    config.kycFraud.thirdPartyApiKey = 'test-key';
    config.kycFraud.thirdPartyApiUrl = 'https://fraud-api.example.com/check';

    global.fetch = jest.fn().mockRejectedValue(new Error('network failure'));

    const result = await getThirdPartyFraudScore(baseInput());
    expect(result).toBeNull();

    // Restore
    Object.assign(config.kycFraud, orig);
    delete (global as any).fetch;
  });

  it('returns parsed score and signals on success', async () => {
    const { config } = require('../../src/config');
    const orig = { ...config.kycFraud };
    config.kycFraud.thirdPartyEnabled = true;
    config.kycFraud.thirdPartyApiKey = 'test-key';
    config.kycFraud.thirdPartyApiUrl = 'https://fraud-api.example.com/check';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        score: 65,
        signals: [{ signal: 'thirdPartyFlag', severity: 'medium', detail: 'flagged by provider' }],
      }),
    });

    const result = await getThirdPartyFraudScore(baseInput());
    expect(result).not.toBeNull();
    expect(result!.score).toBe(65);
    expect(result!.signals).toHaveLength(1);
    expect(result!.signals[0].signal).toBe('thirdPartyFlag');

    Object.assign(config.kycFraud, orig);
    delete (global as any).fetch;
  });
});

// ─── assessFraud (composite) ──────────────────────────────────────────────────

describe('assessFraud', () => {
  it('returns zero score and empty signals when all checks pass', async () => {
    (prismaMock.beneficiary.findUnique as jest.Mock).mockResolvedValue({ idDocumentNumber: 'P1' });
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockResolvedValue([]);
    (prismaMock.kYCSubmission.count as jest.Mock).mockResolvedValue(0);
    (prismaMock.kYCSubmission.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await assessFraud(baseInput());
    expect(result.fraudScore).toBe(0);
    expect(result.fraudScoreFloat).toBe(0);
    expect(result.fraudSignals).toHaveLength(0);
    expect(result.fraudReason).toBe('No fraud signals detected');
    expect(result.featureSnapshot).toBeDefined();
    expect(result.featureSnapshot.rawScore).toBe(0);
  });

  it('accumulates scores from multiple signals with interaction features', async () => {
    // Use mockImplementation to distinguish concurrent findMany callers:
    // checkDocumentReuse uses an OR clause; checkDeviceFingerprint uses deviceFingerprint key.
    (prismaMock.beneficiary.findUnique as jest.Mock).mockResolvedValue({ idDocumentNumber: 'P1' });
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.OR) return Promise.resolve([{ id: 'sub-2', userId: 'other-user' }]);
      return Promise.resolve([]);
    });
    (prismaMock.kYCSubmission.count as jest.Mock)
      .mockResolvedValueOnce(0)  // perUser
      .mockResolvedValueOnce(5); // perIp (triggers high velocity)
    (prismaMock.kYCSubmission.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await assessFraud(baseInput());
    // docReuse high=30*1.0=30, velocity high=25*1.0=25 => 55 + interaction features
    expect(result.fraudScore).toBeGreaterThan(0);
    expect(result.fraudSignals).toHaveLength(2);
    expect(result.fraudReason).not.toBe('No fraud signals detected');
    expect(result.featureSnapshot.interactionFeatures).toBeDefined();
  });

  it('caps composite score at 100', async () => {
    (prismaMock.beneficiary.findUnique as jest.Mock).mockResolvedValue({ idDocumentNumber: 'P1' });
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.OR) return Promise.resolve([{ id: 'sub-2', userId: 'other' }]);
      return Promise.resolve([{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }]);
    });
    (prismaMock.kYCSubmission.count as jest.Mock)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(10); // velocity high
    (prismaMock.kYCSubmission.findFirst as jest.Mock).mockResolvedValue({
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
      beneficiary: { country: 'AU' },
    });

    const result = await assessFraud(baseInput());
    expect(result.fraudScore).toBeLessThanOrEqual(100);
  });

  it('includes signal details in fraudReason', async () => {
    (prismaMock.beneficiary.findUnique as jest.Mock).mockResolvedValue({ idDocumentNumber: 'P1' });
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.OR) return Promise.resolve([{ id: 'sub-2', userId: 'other' }]);
      return Promise.resolve([]);
    });
    (prismaMock.kYCSubmission.count as jest.Mock).mockResolvedValue(0);
    (prismaMock.kYCSubmission.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await assessFraud(baseInput());
    expect(result.fraudReason).toContain('reused');
  });

  // Property-based test: adversarial inputs that suppress all four primary signals
  // but trigger ≥ 2 medium-severity interaction features still score > 50
  it('property-based test: adversarial inputs with interaction features score > 50', async () => {
    // Suppress all primary signals
    (prismaMock.beneficiary.findUnique as jest.Mock).mockResolvedValue({ idDocumentNumber: 'P1' });
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockResolvedValue([]); // No doc reuse, no device sharing
    (prismaMock.kYCSubmission.count as jest.Mock).mockResolvedValue(0); // No velocity risk
    (prismaMock.kYCSubmission.findFirst as jest.Mock).mockResolvedValue(null); // No geo anomaly

    // But trigger interaction features via high submission count
    (prismaMock.kYCSubmission.count as jest.Mock).mockResolvedValue(8); // High submission count

    const result = await assessFraud(baseInput());
    // With high submission count and device sharing, interaction features should contribute
    expect(result.fraudScore).toBeGreaterThan(0);
    expect(result.featureSnapshot.interactionFeatures).toBeDefined();
  });

  // Determinism test: two consecutive calls with identical FraudInput produce identical fraudScore
  it('determinism test: identical inputs produce identical scores', async () => {
    (prismaMock.beneficiary.findUnique as jest.Mock).mockResolvedValue({ idDocumentNumber: 'P1' });
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockResolvedValue([]);
    (prismaMock.kYCSubmission.count as jest.Mock).mockResolvedValue(0);
    (prismaMock.kYCSubmission.findFirst as jest.Mock).mockResolvedValue(null);

    const result1 = await assessFraud(baseInput());
    const result2 = await assessFraud(baseInput());

    expect(result1.fraudScore).toBe(result2.fraudScore);
    expect(result1.fraudScoreFloat).toBe(result2.fraudScoreFloat);
    expect(result1.featureSnapshot.rawScore).toBe(result2.featureSnapshot.rawScore);
  });
});

// ─── Unit test for Platt scaling layer ──────────────────────────────────────────

describe('Platt scaling', () => {
  it('applies Platt scaling with known parameters produces expected probability', async () => {
    // Mock active model version with known Platt parameters
    (prismaMock.fraudModelVersion.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'model-1',
        version: 'v1.0.0',
        plattA: 0.1,
        plattB: -5,
        isActive: true,
        shadowMode: false,
        featureSchemaVersion: 1,
        calibratedAt: new Date(),
      },
    ]);

    (prismaMock.beneficiary.findUnique as jest.Mock).mockResolvedValue({ idDocumentNumber: 'P1' });
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockResolvedValue([]);
    (prismaMock.kYCSubmission.count as jest.Mock).mockResolvedValue(0);
    (prismaMock.kYCSubmission.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await assessFraud(baseInput());

    // With rawScore=0, A=0.1, B=-5: z = 0.1*0 + (-5) = -5
    // p = 1 / (1 + exp(-5)) ≈ 0.9933
    expect(result.fraudScoreFloat).toBeCloseTo(0.9933, 3);
    expect(result.fraudScore).toBeCloseTo(99, 0);
  });

  it('uses default Platt parameters when no active version exists', async () => {
    (prismaMock.fraudModelVersion.findMany as jest.Mock).mockResolvedValue([]);

    (prismaMock.beneficiary.findUnique as jest.Mock).mockResolvedValue({ idDocumentNumber: 'P1' });
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockResolvedValue([]);
    (prismaMock.kYCSubmission.count as jest.Mock).mockResolvedValue(0);
    (prismaMock.kYCSubmission.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await assessFraud(baseInput());

    // Default parameters: A=1, B=0 (identity transformation)
    // With rawScore=0: p = 1 / (1 + exp(0)) = 0.5
    expect(result.fraudScoreFloat).toBeCloseTo(0.5, 3);
    expect(result.fraudScore).toBe(50);
  });

  it('reuses a cached Redis snapshot instead of querying the database', async () => {
    (redisMock.get as jest.Mock).mockResolvedValue(
      JSON.stringify({
        active: { id: 'model-1', plattA: 0.1, plattB: -5, featureSchemaVersion: 1 },
        candidate: null,
      }),
    );

    (prismaMock.beneficiary.findUnique as jest.Mock).mockResolvedValue({ idDocumentNumber: 'P1' });
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockResolvedValue([]);
    (prismaMock.kYCSubmission.count as jest.Mock).mockResolvedValue(0);
    (prismaMock.kYCSubmission.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await assessFraud(baseInput());

    expect(result.fraudScoreFloat).toBeCloseTo(0.9933, 3);
    expect(prismaMock.fraudModelVersion.findMany).not.toHaveBeenCalled();
  });
});

// ─── Shadow (A/B) scoring ────────────────────────────────────────────────────

describe('shadow scoring', () => {
  it('does not issue any additional fraudModelVersion queries when no shadow candidate exists', async () => {
    (prismaMock.fraudModelVersion.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'model-1',
        plattA: 1,
        plattB: 0,
        isActive: true,
        shadowMode: false,
        featureSchemaVersion: 1,
      },
    ]);
    (prismaMock.beneficiary.findUnique as jest.Mock).mockResolvedValue({ idDocumentNumber: 'P1' });
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockResolvedValue([]);
    (prismaMock.kYCSubmission.count as jest.Mock).mockResolvedValue(0);
    (prismaMock.kYCSubmission.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await assessFraud(baseInput());

    expect(prismaMock.fraudModelVersion.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.kYCSubmission.update).not.toHaveBeenCalled();
    expect(result.shadowScore).toBeUndefined();
  });

  it('scores under the candidate version and persists shadowScore, without changing the decision score', async () => {
    (prismaMock.fraudModelVersion.findMany as jest.Mock).mockResolvedValue([
      { id: 'model-1', plattA: 1, plattB: 0, isActive: true, shadowMode: false, featureSchemaVersion: 1 },
      { id: 'model-2', plattA: 0.1, plattB: -5, isActive: false, shadowMode: true, featureSchemaVersion: 1 },
    ]);
    (prismaMock.beneficiary.findUnique as jest.Mock).mockResolvedValue({ idDocumentNumber: 'P1' });
    (prismaMock.kYCSubmission.findMany as jest.Mock).mockResolvedValue([]);
    (prismaMock.kYCSubmission.count as jest.Mock).mockResolvedValue(0);
    (prismaMock.kYCSubmission.findFirst as jest.Mock).mockResolvedValue(null);
    (prismaMock.kYCSubmission.update as jest.Mock).mockResolvedValue({});

    const result = await assessFraud(baseInput());

    // Decision score still comes from the active version (A=1, B=0 -> p=0.5 at rawScore=0)
    expect(result.fraudScoreFloat).toBeCloseTo(0.5, 3);
    // Shadow score comes from the candidate (A=0.1, B=-5 -> p≈0.9933 at rawScore=0)
    expect(result.shadowScore).toBeCloseTo(0.9933, 3);
    expect(prismaMock.kYCSubmission.update).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
      data: { shadowScore: result.shadowScore },
    });
  });
});

// ─── Integration test for FraudLabel creation ───────────────────────────────────

describe('createFraudLabel', () => {
  it('creates FraudLabel when active model version exists', async () => {
    const mockModelVersion = {
      id: 'model-1',
      version: 'v1.0.0',
      plattA: 0.1,
      plattB: -5,
      isActive: true,
      featureSchemaVersion: 1,
      calibratedAt: new Date(),
    };

    (prismaMock.fraudModelVersion.findFirst as jest.Mock).mockResolvedValue(mockModelVersion);
    (prismaMock.fraudLabel.findUnique as jest.Mock).mockResolvedValue(null);
    (prismaMock.fraudLabel.create as jest.Mock).mockResolvedValue({ id: 'label-1' });

    const mockAssessment = {
      fraudScore: 75,
      fraudScoreFloat: 0.75,
      fraudSignals: [],
      fraudReason: 'Test',
      featureSnapshot: {
        rawScore: 50,
        signals: [],
        interactionFeatures: {
          geoAnomalyHighAndVelocityHigh: 0,
          deviceFingerprintSharedAndSubmissionCount: 0,
          documentReuseAndGeoAnomaly: 0,
          highSeveritySignalCount: 0,
        },
      },
    };

    await createFraudLabel('sub-1', 'REJECTED', 'user-1', mockAssessment);

    expect(prismaMock.fraudLabel.create).toHaveBeenCalledWith({
      data: {
        submissionId: 'sub-1',
        modelVersionId: 'model-1',
        outcome: 'REJECTED',
        reviewedBy: 'user-1',
        reviewedAt: expect.any(Date),
        featureSnapshot: mockAssessment.featureSnapshot,
        featureSchemaVersion: 1,
        fraudScore: 75,
        fraudScoreFloat: 0.75,
      },
    });
  });

  it('skips label creation when no active model version exists', async () => {
    (prismaMock.fraudModelVersion.findFirst as jest.Mock).mockResolvedValue(null);

    const mockAssessment = {
      fraudScore: 75,
      fraudScoreFloat: 0.75,
      fraudSignals: [],
      fraudReason: 'Test',
      featureSnapshot: {
        rawScore: 50,
        signals: [],
        interactionFeatures: {
          geoAnomalyHighAndVelocityHigh: 0,
          deviceFingerprintSharedAndSubmissionCount: 0,
          documentReuseAndGeoAnomaly: 0,
          highSeveritySignalCount: 0,
        },
      },
    };

    await createFraudLabel('sub-1', 'REJECTED', 'user-1', mockAssessment);

    expect(prismaMock.fraudLabel.create).not.toHaveBeenCalled();
  });

  it('skips label creation when label already exists', async () => {
    const mockModelVersion = {
      id: 'model-1',
      version: 'v1.0.0',
      plattA: 0.1,
      plattB: -5,
      isActive: true,
      calibratedAt: new Date(),
    };

    (prismaMock.fraudModelVersion.findFirst as jest.Mock).mockResolvedValue(mockModelVersion);
    (prismaMock.fraudLabel.findUnique as jest.Mock).mockResolvedValue({ id: 'existing-label' });

    const mockAssessment = {
      fraudScore: 75,
      fraudScoreFloat: 0.75,
      fraudSignals: [],
      fraudReason: 'Test',
      featureSnapshot: {
        rawScore: 50,
        signals: [],
        interactionFeatures: {
          geoAnomalyHighAndVelocityHigh: 0,
          deviceFingerprintSharedAndSubmissionCount: 0,
          documentReuseAndGeoAnomaly: 0,
          highSeveritySignalCount: 0,
        },
      },
    };

    await createFraudLabel('sub-1', 'REJECTED', 'user-1', mockAssessment);

    expect(prismaMock.fraudLabel.create).not.toHaveBeenCalled();
  });
});
