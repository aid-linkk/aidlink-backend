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
    },
    beneficiary: {
      findUnique: jest.fn(),
    },
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
import {
  checkDocumentReuse,
  checkVelocity,
  checkDeviceFingerprint,
  checkGeoAnomaly,
  getThirdPartyFraudScore,
  assessFraud,
  FraudInput,
} from '../../src/services/kycFraud.service';

const prismaMock = prisma as jest.Mocked<typeof prisma>;

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
    expect(result.fraudSignals).toHaveLength(0);
    expect(result.fraudReason).toBe('No fraud signals detected');
  });

  it('accumulates scores from multiple signals', async () => {
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
    // docReuse high=30*1.0=30, velocity high=25*1.0=25 => 55
    expect(result.fraudScore).toBe(55);
    expect(result.fraudSignals).toHaveLength(2);
    expect(result.fraudReason).not.toBe('No fraud signals detected');
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
});
