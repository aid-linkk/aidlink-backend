/**
 * Unit tests for src/services/fraudModelVersion.service.ts
 *
 * All Prisma calls are mocked so no database is required.
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/config/database', () => ({
  __esModule: true,
  default: {
    fraudModelVersion: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock('../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import prisma from '../../src/config/database';
import redis from '../../src/config/redis';
import { createCandidateVersion, promoteVersion } from '../../src/services/fraudModelVersion.service';

const prismaMock = prisma as jest.Mocked<typeof prisma>;
const redisMock = redis as jest.Mocked<typeof redis>;

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── createCandidateVersion ─────────────────────────────────────────────────

describe('createCandidateVersion', () => {
  it('creates a version with isActive=false and shadowMode=true', async () => {
    (prismaMock.fraudModelVersion.findFirst as jest.Mock).mockResolvedValue({ featureSchemaVersion: 2 });
    (prismaMock.fraudModelVersion.create as jest.Mock).mockResolvedValue({
      id: 'candidate-1',
      isActive: false,
      shadowMode: true,
      featureSchemaVersion: 2,
    });

    const result = await createCandidateVersion({ plattA: 0.2, plattB: -3 });

    expect(prismaMock.fraudModelVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        plattA: 0.2,
        plattB: -3,
        isActive: false,
        shadowMode: true,
        featureSchemaVersion: 2,
      }),
    });
    expect(result.isActive).toBe(false);
    expect(result.shadowMode).toBe(true);
  });

  it('inherits featureSchemaVersion from the active version when not explicitly provided', async () => {
    (prismaMock.fraudModelVersion.findFirst as jest.Mock).mockResolvedValue({ featureSchemaVersion: 3 });
    (prismaMock.fraudModelVersion.create as jest.Mock).mockResolvedValue({ id: 'candidate-1' });

    await createCandidateVersion({ plattA: 0.2, plattB: -3 });

    expect(prismaMock.fraudModelVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ featureSchemaVersion: 3 }),
    });
  });

  it('defaults featureSchemaVersion to 1 when no active version exists', async () => {
    (prismaMock.fraudModelVersion.findFirst as jest.Mock).mockResolvedValue(null);
    (prismaMock.fraudModelVersion.create as jest.Mock).mockResolvedValue({ id: 'candidate-1' });

    await createCandidateVersion({ plattA: 0.2, plattB: -3 });

    expect(prismaMock.fraudModelVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ featureSchemaVersion: 1 }),
    });
  });

  it('uses an explicit featureSchemaVersion over the active version, without querying it', async () => {
    (prismaMock.fraudModelVersion.create as jest.Mock).mockResolvedValue({ id: 'candidate-1' });

    await createCandidateVersion({ plattA: 0.2, plattB: -3, featureSchemaVersion: 5 });

    expect(prismaMock.fraudModelVersion.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.fraudModelVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ featureSchemaVersion: 5 }),
    });
  });

  it('invalidates the fraud model Redis cache', async () => {
    (prismaMock.fraudModelVersion.findFirst as jest.Mock).mockResolvedValue(null);
    (prismaMock.fraudModelVersion.create as jest.Mock).mockResolvedValue({ id: 'candidate-1' });

    await createCandidateVersion({ plattA: 0.2, plattB: -3 });

    expect(redisMock.del).toHaveBeenCalledWith('fraud:model:active_candidate');
  });
});

// ─── promoteVersion ──────────────────────────────────────────────────────────

describe('promoteVersion', () => {
  const readyCandidate = {
    id: 'candidate-1',
    ece: 0.02,
    auc: 0.9,
    isActive: false,
    shadowMode: true,
  };

  function mockTransaction() {
    const tx = {
      fraudModelVersion: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({
          id: 'candidate-1',
          isActive: true,
          shadowMode: false,
        }),
      },
    };
    (prismaMock.$transaction as jest.Mock).mockImplementation((cb: any) => cb(tx));
    return tx;
  }

  it('throws FRAUD_MODEL_VERSION_NOT_READY when ECE >= 0.05', async () => {
    (prismaMock.fraudModelVersion.findUnique as jest.Mock).mockResolvedValue({
      ...readyCandidate,
      ece: 0.1,
    });

    await expect(promoteVersion('candidate-1')).rejects.toThrow('FRAUD_MODEL_VERSION_NOT_READY');
    await expect(promoteVersion('candidate-1')).rejects.toMatchObject({ errorCode: 'FRAUD_001' });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('throws FRAUD_MODEL_VERSION_NOT_READY when AUC <= 0.75', async () => {
    (prismaMock.fraudModelVersion.findUnique as jest.Mock).mockResolvedValue({
      ...readyCandidate,
      auc: 0.6,
    });

    await expect(promoteVersion('candidate-1')).rejects.toThrow('FRAUD_MODEL_VERSION_NOT_READY');
  });

  it('throws FRAUD_MODEL_VERSION_NOT_READY when metrics have not been computed yet', async () => {
    (prismaMock.fraudModelVersion.findUnique as jest.Mock).mockResolvedValue({
      ...readyCandidate,
      ece: null,
      auc: null,
    });

    await expect(promoteVersion('candidate-1')).rejects.toThrow('FRAUD_MODEL_VERSION_NOT_READY');
  });

  it('throws a not-found error for an unknown candidate ID', async () => {
    (prismaMock.fraudModelVersion.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(promoteVersion('missing')).rejects.toMatchObject({ errorCode: 'FRAUD_002' });
  });

  it('atomically deactivates all active versions and activates the candidate', async () => {
    (prismaMock.fraudModelVersion.findUnique as jest.Mock).mockResolvedValue(readyCandidate);
    const tx = mockTransaction();

    await promoteVersion('candidate-1');

    expect(tx.fraudModelVersion.updateMany).toHaveBeenCalledWith({
      where: { isActive: true },
      data: { isActive: false },
    });
    expect(tx.fraudModelVersion.update).toHaveBeenCalledWith({
      where: { id: 'candidate-1' },
      data: expect.objectContaining({ isActive: true, shadowMode: false }),
    });
  });

  it('rolls back without promoting when the transaction fails partway through', async () => {
    (prismaMock.fraudModelVersion.findUnique as jest.Mock).mockResolvedValue(readyCandidate);
    const tx = {
      fraudModelVersion: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockRejectedValue(new Error('constraint violation')),
      },
    };
    (prismaMock.$transaction as jest.Mock).mockImplementation((cb: any) => cb(tx));

    await expect(promoteVersion('candidate-1')).rejects.toThrow('constraint violation');
    // The cache must not be invalidated for a promotion that never committed.
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it('invalidates the fraud model Redis cache after a successful promotion', async () => {
    (prismaMock.fraudModelVersion.findUnique as jest.Mock).mockResolvedValue(readyCandidate);
    mockTransaction();

    await promoteVersion('candidate-1');

    expect(redisMock.del).toHaveBeenCalledWith('fraud:model:active_candidate');
  });
});
