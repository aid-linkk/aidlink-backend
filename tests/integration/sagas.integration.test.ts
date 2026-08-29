/**
 * Integration tests for the three AidLink sagas:
 *   - DonationConfirmationSaga
 *   - DistributionConfirmationSaga
 *   - CampaignSettlementSaga
 *
 * These tests exercise the full saga flow end-to-end by mocking only the
 * external I/O surfaces (Prisma DB, webhook dispatch, analytics service,
 * receipt worker) and verifying:
 *   - Happy-path step execution and output shape
 *   - Compensation on step failure (correct steps undone, correct order)
 *   - Crash recovery (resume from persisted STEP_COMPLETED state)
 *   - Financial consistency invariants after compensation
 */

import {
  DonationStatus,
  DistributionStatus,
  RecoveryStatus,
  SagaStatus,
  SettlementOption,
} from '@prisma/client';

// ─── Mock factories (populated inside jest.mock factories) ────────────────────
let sagaCreateMock: jest.Mock;
let sagaUpdateMock: jest.Mock;
let sagaFindUniqueMock: jest.Mock;
let sagaFindManyMock: jest.Mock;
let stepCreateMock: jest.Mock;
let stepUpdateMock: jest.Mock;
let stepFindManyMock: jest.Mock;

let donationFindUniqueMock: jest.Mock;
let donationFindUniqueOrThrowMock: jest.Mock;
let donationUpdateManyMock: jest.Mock;
let donationUpdateMock: jest.Mock;

let campaignUpdateMock: jest.Mock;
let campaignFindUniqueMock: jest.Mock;
let campaignFindUniqueOrThrowMock: jest.Mock;

let matchedFundFindUniqueMock: jest.Mock;
let matchedFundUpdateMock: jest.Mock;

let distributionFindUniqueMock: jest.Mock;
let distributionFindUniqueOrThrowMock: jest.Mock;
let distributionUpdateManyMock: jest.Mock;
let distributionUpdateMock: jest.Mock;

let notificationCreateMock: jest.Mock;
let notificationDeleteManyMock: jest.Mock;

let recoveryCaseFindUniqueMock: jest.Mock;
let recoveryCaseUpdateMock: jest.Mock;

let transactionMock: jest.Mock;
let queryRawMock: jest.Mock;

// ─── Mock: Prisma ─────────────────────────────────────────────────────────────

jest.mock('../../src/config/database', () => {
  sagaCreateMock = jest.fn();
  sagaUpdateMock = jest.fn();
  sagaFindUniqueMock = jest.fn();
  sagaFindManyMock = jest.fn();
  stepCreateMock = jest.fn();
  stepUpdateMock = jest.fn();
  stepFindManyMock = jest.fn();
  donationFindUniqueMock = jest.fn();
  donationFindUniqueOrThrowMock = jest.fn();
  donationUpdateManyMock = jest.fn();
  donationUpdateMock = jest.fn();
  campaignUpdateMock = jest.fn();
  campaignFindUniqueMock = jest.fn();
  campaignFindUniqueOrThrowMock = jest.fn();
  matchedFundFindUniqueMock = jest.fn();
  matchedFundUpdateMock = jest.fn();
  distributionFindUniqueMock = jest.fn();
  distributionFindUniqueOrThrowMock = jest.fn();
  distributionUpdateManyMock = jest.fn();
  distributionUpdateMock = jest.fn();
  notificationCreateMock = jest.fn();
  notificationDeleteManyMock = jest.fn();
  recoveryCaseFindUniqueMock = jest.fn();
  recoveryCaseUpdateMock = jest.fn();
  queryRawMock = jest.fn();

  const db: any = {
    sagaInstance: {
      create: (...a: any[]) => sagaCreateMock(...a),
      update: (...a: any[]) => sagaUpdateMock(...a),
      findUnique: (...a: any[]) => sagaFindUniqueMock(...a),
      findMany: (...a: any[]) => sagaFindManyMock(...a),
    },
    sagaStepExecution: {
      create: (...a: any[]) => stepCreateMock(...a),
      update: (...a: any[]) => stepUpdateMock(...a),
      findMany: (...a: any[]) => stepFindManyMock(...a),
    },
    donation: {
      findUnique: (...a: any[]) => donationFindUniqueMock(...a),
      findUniqueOrThrow: (...a: any[]) => donationFindUniqueOrThrowMock(...a),
      updateMany: (...a: any[]) => donationUpdateManyMock(...a),
      update: (...a: any[]) => donationUpdateMock(...a),
    },
    campaign: {
      findUnique: (...a: any[]) => campaignFindUniqueMock(...a),
      findUniqueOrThrow: (...a: any[]) => campaignFindUniqueOrThrowMock(...a),
      update: (...a: any[]) => campaignUpdateMock(...a),
    },
    matchedFund: {
      findUnique: (...a: any[]) => matchedFundFindUniqueMock(...a),
      update: (...a: any[]) => matchedFundUpdateMock(...a),
    },
    distribution: {
      findUnique: (...a: any[]) => distributionFindUniqueMock(...a),
      findUniqueOrThrow: (...a: any[]) => distributionFindUniqueOrThrowMock(...a),
      updateMany: (...a: any[]) => distributionUpdateManyMock(...a),
      update: (...a: any[]) => distributionUpdateMock(...a),
    },
    notification: {
      create: (...a: any[]) => notificationCreateMock(...a),
      deleteMany: (...a: any[]) => notificationDeleteManyMock(...a),
    },
    recoveryCase: {
      findUnique: (...a: any[]) => recoveryCaseFindUniqueMock(...a),
      update: (...a: any[]) => recoveryCaseUpdateMock(...a),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    $queryRaw: (...a: any[]) => queryRawMock(...a),
  };

  // $transaction: executes fn(db) for callback-form, Promise.all for array-form
  transactionMock = jest.fn().mockImplementation(async (fn: any) => {
    if (typeof fn === 'function') return fn(db);
    return Promise.all(fn);
  });
  db.$transaction = transactionMock;

  return { __esModule: true, default: db };
});

// ─── Mock: logger ─────────────────────────────────────────────────────────────

jest.mock('../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ─── Mock: webhook ─────────────────────────────────────────────────────────────

let webhookDispatchMock: jest.Mock;
jest.mock('../../src/controllers/webhook.controller', () => {
  webhookDispatchMock = jest.fn().mockResolvedValue(undefined);
  return { dispatchWebhookEvent: (...a: any[]) => webhookDispatchMock(...a) };
});

// ─── Mock: analytics ──────────────────────────────────────────────────────────

let incrementStatsMock: jest.Mock;
let decrementStatsMock: jest.Mock;
let invalidateCacheMock: jest.Mock;
jest.mock('../../src/services/analytics.service', () => {
  incrementStatsMock = jest.fn().mockResolvedValue(undefined);
  decrementStatsMock = jest.fn().mockResolvedValue(undefined);
  invalidateCacheMock = jest.fn().mockResolvedValue(undefined);
  return {
    AnalyticsService: {
      incrementDonationStats: (...a: any[]) => incrementStatsMock(...a),
      decrementDonationStats: (...a: any[]) => decrementStatsMock(...a),
      invalidateCampaignCache: (...a: any[]) => invalidateCacheMock(...a),
    },
  };
});

// ─── Mock: receipt worker ─────────────────────────────────────────────────────

let enqueueReceiptMock: jest.Mock;
jest.mock('../../src/workers/receipt.worker', () => {
  enqueueReceiptMock = jest.fn().mockResolvedValue(undefined);
  return { enqueueReceiptGeneration: (...a: any[]) => enqueueReceiptMock(...a) };
});

// ─── Mock: multiplier + matched fund services ─────────────────────────────────

let evalMultiplierMock: jest.Mock;
let allocateMock: jest.Mock;
jest.mock('../../src/services/multiplier.service', () => {
  evalMultiplierMock = jest.fn().mockResolvedValue(null);
  return { MultiplierService: { evaluateMultiplierAtDonation: (...a: any[]) => evalMultiplierMock(...a) } };
});
jest.mock('../../src/services/matchedFundAllocation.service', () => {
  allocateMock = jest.fn().mockResolvedValue(null);
  return { MatchedFundAllocationService: { allocate: (...a: any[]) => allocateMock(...a) } };
});

// ─── Mock: campaign audit ────────────────────────────────────────────────────

jest.mock('../../src/services/campaignAudit.service', () => ({
  CampaignAuditService: { log: jest.fn() },
}));

// ─── Mock: config ────────────────────────────────────────────────────────────

jest.mock('../../src/config', () => ({
  config: { receipts: { enabled: false } }, // receipts disabled keeps step 7 a no-op in tests
}));

// ─── Mock: error codes (allow AppError.from to work) ─────────────────────────

jest.mock('../../src/constants/errorCodes', () => ({
  ErrorCodes: {
    DONATION_001: { message: 'Donation not found', httpStatus: 404 },
    DONATION_002: { message: 'Donation already confirmed', httpStatus: 409 },
    DISTRIBUTION_001: { message: 'Distribution not found', httpStatus: 404 },
    DISTRIBUTION_002: { message: 'Distribution already completed', httpStatus: 409 },
    RECOVERY_001: { message: 'Recovery case not found', httpStatus: 404 },
    RECOVERY_002: { message: 'Invalid recovery case type', httpStatus: 400 },
    RECOVERY_003: { message: 'Case already resolved', httpStatus: 409 },
    RECOVERY_004: { message: 'Missing required field', httpStatus: 422 },
    CAMPAIGN_002: { message: 'Campaign not found', httpStatus: 404 },
    COMMON_001: { message: 'Forbidden', httpStatus: 403 },
  },
}));

// Import AFTER all mocks
import { DonationService } from '../../src/services/donation.service';
import { DistributionService } from '../../src/services/distribution.service';
import { settleCancelledCampaign } from '../../src/services/recovery.service';
import { SagaOrchestrator } from '../../src/saga/SagaOrchestrator';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let sagaIdCounter = 0;
let stepIdCounter = 0;
const SAGA_ID = 'saga-test-001';

function freshSagaId() { return `saga-${++sagaIdCounter}`; }
function freshStepId() { return `step-${++stepIdCounter}`; }

const PENDING_DONATION = {
  id: 'don-001',
  campaignId: 'camp-001',
  userId: 'user-001',
  amount: { toString: () => '100', toFixed: () => '100.00000000' } as any,
  currency: 'XLM',
  status: DonationStatus.PENDING,
  isAnonymous: false,
  blockchainTxHash: null,
};

const CONFIRMED_DONATION = { ...PENDING_DONATION, status: DonationStatus.CONFIRMED };

const PENDING_DIST = {
  id: 'dist-001',
  campaignId: 'camp-001',
  beneficiaryId: 'ben-001',
  amount: { toString: () => '50' } as any,
  currency: 'XLM',
  status: DistributionStatus.PENDING,
  blockchainTxHash: null,
  distributedAt: null,
  distributedBy: null,
  campaign: { id: 'camp-001', userId: 'org-001' },
};

const COMPLETED_DIST = {
  ...PENDING_DIST,
  status: DistributionStatus.COMPLETED,
  blockchainTxHash: 'tx-dist',
};

function makeRc(overrides: any = {}) {
  return {
    id: 'rc-001',
    type: 'CANCELLED_CAMPAIGN_FUNDS',
    status: RecoveryStatus.RECOVERY_REQUIRED,
    campaignId: 'camp-001',
    donorCredits: [],
    ...overrides,
  };
}

/** Wire up default saga table mocks (all succeed). */
function setupSagaMocks() {
  // Re-wire $transaction after resetAllMocks() clears its implementation.
  // The db object itself is imported from the mock, so we re-implement via the
  // module-level transactionMock reference.
  const db = require('../../src/config/database').default;
  transactionMock.mockImplementation(async (fn: any) => {
    if (typeof fn === 'function') return fn(db);
    return Promise.all(fn);
  });
  db.$transaction = (...a: any[]) => transactionMock(...a);

  sagaCreateMock.mockImplementation((args: any) => Promise.resolve({
    id: freshSagaId(),
    name: args?.data?.name ?? 'TestSaga',
    status: 'STARTED',
    currentStep: 0,
    input: args?.data?.input ?? {},
    output: null,
    error: null,
    compensationTimeoutMs: 30_000,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  sagaUpdateMock.mockResolvedValue({});
  sagaFindUniqueMock.mockResolvedValue({ compensationTimeoutMs: 30_000 });
  stepCreateMock.mockImplementation((args: any) => Promise.resolve({
    id: freshStepId(),
    sagaId: SAGA_ID,
    stepName: args?.data?.stepName ?? 'step',
    stepIndex: args?.data?.stepIndex ?? 0,
    status: 'RUNNING',
    input: null, output: null, error: null,
    executedAt: new Date(), completedAt: null, compensatedAt: null,
  }));
  stepUpdateMock.mockResolvedValue({});
  stepFindManyMock.mockResolvedValue([]);
  queryRawMock.mockResolvedValue([]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DONATION CONFIRMATION SAGA
// ═══════════════════════════════════════════════════════════════════════════════

describe('DonationConfirmationSaga — integration', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    sagaIdCounter = 0;
    stepIdCounter = 0;
    setupSagaMocks();
  });

  describe('happy path', () => {
    /** Set up the minimal chain of calls for a successful donation confirmation. */
    function setupHappyDonation() {
      // Service pre-check: donation exists and is PENDING
      donationFindUniqueMock
        .mockResolvedValueOnce(PENDING_DONATION)  // service guard read
        .mockResolvedValueOnce(CONFIRMED_DONATION); // post-saga response read

      // Inside saga step 1 (inside tx):
      donationUpdateManyMock.mockResolvedValue({ count: 1 }); // status guard
      donationFindUniqueOrThrowMock.mockResolvedValue(CONFIRMED_DONATION);

      // Steps 2-4 (multiplier, matched fund, campaign balance)
      evalMultiplierMock.mockResolvedValue(null);
      allocateMock.mockResolvedValue(null);
      campaignUpdateMock.mockResolvedValue({});

      // Post-saga read in DonationService
      matchedFundFindUniqueMock.mockResolvedValue(null);
    }

    it('returns backwards-compatible response shape', async () => {
      setupHappyDonation();
      const result = await DonationService.confirmDonation('don-001', 'tx-hash-abc');
      expect(result).toMatchObject({
        id: 'don-001',
        multiplierApplied: null,
      });
    });

    it('marks donation as CONFIRMED via updateMany guard', async () => {
      setupHappyDonation();
      await DonationService.confirmDonation('don-001', 'tx-abc');
      expect(donationUpdateManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'don-001' }),
          data: expect.objectContaining({ status: DonationStatus.CONFIRMED }),
        }),
      );
    });

    it('fires webhook asynchronously (saga async step 5)', async () => {
      setupHappyDonation();
      await DonationService.confirmDonation('don-001', 'tx-abc');
      // Give the async step's optimistic-complete callback a tick
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(webhookDispatchMock).toHaveBeenCalledWith(
        'DONATION_CONFIRMED',
        expect.objectContaining({ donationId: 'don-001' }),
      );
    });

    it('increments analytics cache asynchronously (saga async step 6)', async () => {
      setupHappyDonation();
      await DonationService.confirmDonation('don-001', 'tx-abc');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(incrementStatsMock).toHaveBeenCalled();
    });

    it('throws DONATION_001 when donation not found', async () => {
      donationFindUniqueMock.mockResolvedValue(null);
      await expect(DonationService.confirmDonation('nonexistent', 'tx')).rejects.toThrow();
    });

    it('throws DONATION_002 when donation already confirmed', async () => {
      donationFindUniqueMock.mockResolvedValue(CONFIRMED_DONATION);
      await expect(DonationService.confirmDonation('don-001', 'tx')).rejects.toThrow();
    });
  });

  describe('compensation — transactional step failure', () => {
    it('reverts donation status when campaign balance step fails', async () => {
      // Service guard: donation is PENDING
      donationFindUniqueMock.mockResolvedValue(PENDING_DONATION);

      // Step 1 succeeds (inside tx)
      donationUpdateManyMock.mockResolvedValue({ count: 1 });
      donationFindUniqueOrThrowMock.mockResolvedValue(CONFIRMED_DONATION);
      evalMultiplierMock.mockResolvedValue(null);
      allocateMock.mockResolvedValue(null);

      // Step 4 (campaign balance) fails
      campaignUpdateMock.mockRejectedValue(new Error('DB: campaign not found'));

      // Compensation: step 1 (confirmDonationStatus) is COMPLETED
      stepFindManyMock.mockResolvedValue([
        {
          id: 's1', sagaId: SAGA_ID, stepName: 'confirmDonationStatus', stepIndex: 0,
          status: 'COMPLETED',
          input: { donationId: 'don-001', campaignId: 'camp-001', txHash: 'tx-abc' },
          output: { donationId: 'don-001', campaignId: 'camp-001', donorAmount: 100 },
          error: null, executedAt: new Date(), completedAt: new Date(), compensatedAt: null,
        },
      ]);

      // Allow compensation's updateMany call to succeed
      donationUpdateManyMock.mockResolvedValue({ count: 1 });

      await expect(DonationService.confirmDonation('don-001', 'tx-abc')).rejects.toThrow();

      // Compensation must revert donation to PENDING
      const revertCall = donationUpdateManyMock.mock.calls.find(
        (call) =>
          call[0]?.where?.id === 'don-001' &&
          call[0]?.data?.status === DonationStatus.PENDING,
      );
      expect(revertCall).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DISTRIBUTION CONFIRMATION SAGA
// ═══════════════════════════════════════════════════════════════════════════════

describe('DistributionConfirmationSaga — integration', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    sagaIdCounter = 0;
    stepIdCounter = 0;
    setupSagaMocks();
  });

  describe('happy path', () => {
    function setupHappyDistribution() {
      // Service pre-check: distribution exists and is PENDING
      distributionFindUniqueMock
        .mockResolvedValueOnce(PENDING_DIST)   // service guard
        .mockResolvedValueOnce(PENDING_DIST);  // inside saga step 1 (findUnique)

      // Step 1: update distribution status
      distributionUpdateMock.mockResolvedValue(COMPLETED_DIST);
      // Step 2: decrement campaign balance
      campaignUpdateMock.mockResolvedValue({});
      // Post-saga read for response
      distributionFindUniqueOrThrowMock.mockResolvedValue(COMPLETED_DIST);
    }

    it('confirms distribution and returns the updated record', async () => {
      setupHappyDistribution();
      const result = await DistributionService.confirmDistribution('dist-001', 'tx-dist', 'user-001');
      expect(result.status).toBe(DistributionStatus.COMPLETED);
    });

    it('decrements campaign balance inside the transaction', async () => {
      setupHappyDistribution();
      await DistributionService.confirmDistribution('dist-001', 'tx-dist', 'user-001');
      expect(campaignUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'camp-001' },
          data: expect.objectContaining({ currentAmount: expect.objectContaining({ decrement: expect.anything() }) }),
        }),
      );
    });

    it('dispatches webhook asynchronously', async () => {
      setupHappyDistribution();
      await DistributionService.confirmDistribution('dist-001', 'tx-dist', 'user-001');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(webhookDispatchMock).toHaveBeenCalledWith(
        'DISTRIBUTION_COMPLETED',
        expect.objectContaining({ distributionId: 'dist-001' }),
      );
    });

    it('invalidates analytics cache asynchronously', async () => {
      setupHappyDistribution();
      await DistributionService.confirmDistribution('dist-001', 'tx-dist', 'user-001');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(invalidateCacheMock).toHaveBeenCalledWith('camp-001');
    });

    it('throws DISTRIBUTION_001 when distribution not found', async () => {
      distributionFindUniqueMock.mockResolvedValue(null);
      await expect(
        DistributionService.confirmDistribution('nonexistent', 'tx', 'user-001'),
      ).rejects.toThrow();
    });

    it('throws when distribution already completed', async () => {
      distributionFindUniqueMock.mockResolvedValue(COMPLETED_DIST);
      await expect(
        DistributionService.confirmDistribution('dist-001', 'tx', 'user-001'),
      ).rejects.toThrow();
    });
  });

  describe('compensation', () => {
    it('restores distribution status when campaign decrement fails', async () => {
      // Service guard: PENDING
      distributionFindUniqueMock
        .mockResolvedValueOnce(PENDING_DIST)  // service guard
        .mockResolvedValueOnce(PENDING_DIST); // inside step 1

      distributionUpdateMock.mockResolvedValue(COMPLETED_DIST);
      // Step 2 fails
      campaignUpdateMock.mockRejectedValue(new Error('campaign locked'));

      // Compensation: step 1 was COMPLETED
      stepFindManyMock.mockResolvedValue([
        {
          id: 's1', sagaId: SAGA_ID, stepName: 'confirmDistributionStatus', stepIndex: 0,
          status: 'COMPLETED',
          input: { distributionId: 'dist-001', txHash: 'tx', userId: 'u' },
          output: {
            distributionId: 'dist-001', campaignId: 'camp-001',
            beneficiaryId: 'ben-001', amount: 50, currency: 'XLM',
            txHash: 'tx', prevStatus: DistributionStatus.PENDING,
          },
          error: null, executedAt: new Date(), completedAt: new Date(), compensatedAt: null,
        },
      ]);

      distributionUpdateManyMock.mockResolvedValue({ count: 1 });

      await expect(
        DistributionService.confirmDistribution('dist-001', 'tx', 'user-001'),
      ).rejects.toThrow();

      // Compensation: distribution should be reverted to PENDING via updateMany
      const revertCall = distributionUpdateManyMock.mock.calls.find(
        (call) => call[0]?.data?.status === DistributionStatus.PENDING,
      );
      expect(revertCall).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CAMPAIGN SETTLEMENT SAGA
// ═══════════════════════════════════════════════════════════════════════════════

describe('CampaignSettlementSaga — integration', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    sagaIdCounter = 0;
    stepIdCounter = 0;
    setupSagaMocks();
  });

  const DONATIONS = [
    { id: 'don-1', amount: 50, currency: 'XLM', userId: 'u1', status: DonationStatus.CONFIRMED },
    { id: 'don-2', amount: 50, currency: 'XLM', userId: 'u2', status: DonationStatus.CONFIRMED },
  ];

  function setupHappySettlement() {
    recoveryCaseFindUniqueMock.mockResolvedValue(makeRc());

    // Step 1 (refundDonations): campaign.findUnique with donations included
    campaignFindUniqueMock.mockResolvedValue({
      id: 'camp-001',
      title: 'Test Campaign',
      currentAmount: 100,
      donations: DONATIONS,
    });
    // Step 2 (decrementCampaignBalance): findUniqueOrThrow for balance snapshot
    campaignFindUniqueOrThrowMock.mockResolvedValue({ currentAmount: 100 });

    donationUpdateManyMock.mockResolvedValue({ count: 2 });
    campaignUpdateMock.mockResolvedValue({});
    notificationCreateMock.mockResolvedValue({ id: 'notif-1' });
    recoveryCaseUpdateMock.mockResolvedValue({});
  }

  describe('REFUND_TO_DONOR — happy path', () => {
    it('marks all confirmed donations as REFUNDED via batch updateMany', async () => {
      setupHappySettlement();
      await settleCancelledCampaign('rc-001', SettlementOption.REFUND_TO_DONOR, 'admin-1');
      expect(donationUpdateManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ campaignId: 'camp-001', status: DonationStatus.CONFIRMED }),
          data: { status: DonationStatus.REFUNDED },
        }),
      );
    });

    it('decrements campaign balance for each donation', async () => {
      setupHappySettlement();
      await settleCancelledCampaign('rc-001', SettlementOption.REFUND_TO_DONOR, 'admin-1');
      const decrementCalls = campaignUpdateMock.mock.calls.filter(
        (call) => call[0]?.data?.currentAmount?.decrement !== undefined,
      );
      expect(decrementCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('creates notifications for donors async', async () => {
      setupHappySettlement();
      await settleCancelledCampaign('rc-001', SettlementOption.REFUND_TO_DONOR, 'admin-1');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(notificationCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'CAMPAIGN_SETTLEMENT' }),
        }),
      );
    });

    it('marks recovery case as RECOVERED', async () => {
      setupHappySettlement();
      await settleCancelledCampaign('rc-001', SettlementOption.REFUND_TO_DONOR, 'admin-1');
      const recoveredCall = recoveryCaseUpdateMock.mock.calls.find(
        (call) => call[0]?.data?.status === RecoveryStatus.RECOVERED,
      );
      expect(recoveredCall).toBeDefined();
    });
  });

  describe('REFUND_TO_DONOR — compensation', () => {
    it('reverts REFUNDED donations to CONFIRMED when a later step fails', async () => {
      recoveryCaseFindUniqueMock.mockResolvedValue(makeRc());
      campaignFindUniqueMock.mockResolvedValue({ id: 'camp-001', title: 'Test', currentAmount: 100, donations: DONATIONS });
      donationUpdateManyMock.mockResolvedValue({ count: 2 });
      // Step 2 fails
      campaignFindUniqueOrThrowMock.mockRejectedValue(new Error('snapshot failed'));

      // Compensation: step 0 (refundDonations) is COMPLETED
      stepFindManyMock.mockResolvedValue([
        {
          id: 's0', sagaId: SAGA_ID, stepName: 'refundDonations', stepIndex: 0,
          status: 'COMPLETED',
          input: { recoveryCaseId: 'rc-001', campaignId: 'camp-001', adminId: 'admin-1', settlementOption: 'REFUND_TO_DONOR' },
          output: {
            campaignTitle: 'Test',
            refundedDonations: DONATIONS.map(d => ({ donationId: d.id, amount: d.amount, currency: d.currency, userId: d.userId })),
            totalRefunded: 100,
          },
          error: null, executedAt: new Date(), completedAt: new Date(), compensatedAt: null,
        },
      ]);

      await expect(
        settleCancelledCampaign('rc-001', SettlementOption.REFUND_TO_DONOR, 'admin-1'),
      ).rejects.toThrow();

      // Compensation: donations reverted back to CONFIRMED
      const revertCall = donationUpdateManyMock.mock.calls.find(
        (call) =>
          call[0]?.where?.id?.in?.includes('don-1') &&
          call[0]?.data?.status === DonationStatus.CONFIRMED,
      );
      expect(revertCall).toBeDefined();
    });

    it('deletes created notifications when recovery case update fails', async () => {
      recoveryCaseFindUniqueMock.mockResolvedValue(makeRc());
      campaignFindUniqueMock.mockResolvedValue({ id: 'camp-001', title: 'Test', currentAmount: 50, donations: [DONATIONS[0]] });
      campaignFindUniqueOrThrowMock.mockResolvedValue({ currentAmount: 50 });
      donationUpdateManyMock.mockResolvedValue({ count: 1 });
      campaignUpdateMock.mockResolvedValue({});
      notificationCreateMock.mockResolvedValue({ id: 'notif-created-x' });
      // Step 4 (updateRecoveryCase) fails
      recoveryCaseUpdateMock.mockRejectedValue(new Error('case update failed'));
      notificationDeleteManyMock.mockResolvedValue({ count: 1 });

      // Compensation: step 2 (createDonorNotifications) is COMPLETED with notification IDs
      stepFindManyMock.mockResolvedValue([
        {
          id: 's2', sagaId: SAGA_ID, stepName: 'createDonorNotifications', stepIndex: 2,
          status: 'COMPLETED',
          input: {},
          output: ['notif-created-x'],
          error: null, executedAt: new Date(), completedAt: new Date(), compensatedAt: null,
        },
      ]);

      await expect(
        settleCancelledCampaign('rc-001', SettlementOption.REFUND_TO_DONOR, 'admin-1'),
      ).rejects.toThrow();

      await new Promise((r) => setImmediate(r));

      expect(notificationDeleteManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: ['notif-created-x'] } }),
        }),
      );
    });
  });

  describe('TRANSFER_TO_CAMPAIGN (non-saga path)', () => {
    it('executes transfer without creating a saga instance', async () => {
      const rc = makeRc();
      const targetCampaign = { id: 'target-camp', status: 'ACTIVE' };
      const sourceCampaign = { id: 'camp-001', title: 'Source', currentAmount: 100, donations: [], status: 'ACTIVE' };

      recoveryCaseFindUniqueMock.mockResolvedValue(rc);
      // Service calls campaign.findUnique twice:
      //   1) to validate target campaign
      //   2) to load source campaign with donations
      campaignFindUniqueMock
        .mockResolvedValueOnce(targetCampaign)
        .mockResolvedValueOnce(sourceCampaign);
      campaignUpdateMock.mockResolvedValue({});
      recoveryCaseUpdateMock.mockResolvedValue({});

      await settleCancelledCampaign(
        'rc-001',
        SettlementOption.TRANSFER_TO_CAMPAIGN,
        'admin-1',
        undefined,
        'target-camp',
      );

      // No saga should be created for this path
      expect(sagaCreateMock).not.toHaveBeenCalled();
    });
  });

  describe('error cases', () => {
    it('throws RECOVERY_001 when case not found', async () => {
      recoveryCaseFindUniqueMock.mockResolvedValue(null);
      await expect(
        settleCancelledCampaign('nonexistent', SettlementOption.REFUND_TO_DONOR, 'admin-1'),
      ).rejects.toThrow();
    });

    it('throws when case already settled', async () => {
      recoveryCaseFindUniqueMock.mockResolvedValue(makeRc({ status: RecoveryStatus.RECOVERED }));
      await expect(
        settleCancelledCampaign('rc-001', SettlementOption.REFUND_TO_DONOR, 'admin-1'),
      ).rejects.toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CRASH RECOVERY
// ═══════════════════════════════════════════════════════════════════════════════

describe('SagaOrchestrator.resume() — crash recovery', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    sagaIdCounter = 0;
    stepIdCounter = 0;
    setupSagaMocks();
  });

  it('resumes a STEP_COMPLETED saga without re-running already-completed steps', async () => {
    const s1Execute = jest.fn().mockResolvedValue({ s1: true });
    const s2Execute = jest.fn().mockResolvedValue({ s2: true });

    const definition = {
      name: 'TestSaga',
      compensationTimeoutMs: 5_000,
      steps: [
        { name: 's1', execute: s1Execute, isTransactional: false, isAsync: false },
        { name: 's2', execute: s2Execute, isTransactional: false, isAsync: false },
      ],
    };

    sagaFindUniqueMock.mockResolvedValue({
      id: 'saga-crashed',
      name: 'TestSaga',
      status: SagaStatus.STEP_COMPLETED,
      currentStep: 1,
      input: { data: 'x' },
      output: null,
      error: null,
      compensationTimeoutMs: 5_000,
      createdAt: new Date(),
      updatedAt: new Date(),
      steps: [{
        id: 'step-0', sagaId: 'saga-crashed', stepName: 's1', stepIndex: 0,
        status: 'COMPLETED', input: { data: 'x' }, output: { s1: true },
        error: null, executedAt: new Date(), completedAt: new Date(), compensatedAt: null,
      }],
    });

    const result = await SagaOrchestrator.resume('saga-crashed', definition as any);

    expect(result.success).toBe(true);
    // s1 was already done — must NOT execute again (idempotent)
    expect(s1Execute).not.toHaveBeenCalled();
    // s2 executes with s1's output as its input
    expect(s2Execute).toHaveBeenCalledWith({ s1: true }, undefined);
  });

  it('resumes a COMPENSATING saga and runs remaining compensations', async () => {
    const s1Comp = jest.fn().mockResolvedValue(undefined);

    const definition = {
      name: 'TestSaga',
      compensationTimeoutMs: 5_000,
      steps: [
        {
          name: 's1', execute: jest.fn(), compensate: s1Comp,
          isTransactional: false, isAsync: false,
        },
      ],
    };

    sagaFindUniqueMock.mockResolvedValue({
      id: 'saga-comp',
      name: 'TestSaga',
      status: SagaStatus.COMPENSATING,
      currentStep: 0,
      input: {},
      output: null,
      error: 'step 2 failed',
      compensationTimeoutMs: 5_000,
      createdAt: new Date(),
      updatedAt: new Date(),
      steps: [{
        id: 'step-0', sagaId: 'saga-comp', stepName: 's1', stepIndex: 0,
        status: 'COMPLETED', input: {}, output: { compensate: true },
        error: null, executedAt: new Date(), completedAt: new Date(), compensatedAt: null,
      }],
    });

    const result = await SagaOrchestrator.resume('saga-comp', definition as any);

    expect(result.success).toBe(false);
    expect(s1Comp).toHaveBeenCalledWith({ compensate: true }, expect.anything());

    const finalStatus = sagaUpdateMock.mock.calls.find(
      (c) => c[0]?.data?.status === SagaStatus.COMPENSATED || c[0]?.data?.status === SagaStatus.FAILED,
    );
    expect(finalStatus?.[0]?.data?.status).toBe(SagaStatus.COMPENSATED);
  });

  it('throws when saga not found', async () => {
    sagaFindUniqueMock.mockResolvedValue(null);
    await expect(
      SagaOrchestrator.resume('missing-id', { name: 'X', steps: [] } as any),
    ).rejects.toThrow('missing-id');
  });
});
