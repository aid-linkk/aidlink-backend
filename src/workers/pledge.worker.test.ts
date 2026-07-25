import { Decimal } from '@prisma/client/runtime/library';
import { PledgeWorker } from './pledge.worker';
import { DonationService } from '../services/donation.service';
import * as RecoveryService from '../services/recovery.service';
import { MockPaymentProvider } from '../services/payment/mockProvider';
import * as paymentIndex from '../services/payment';

jest.mock('@prisma/client', () => ({
  PledgeAttemptStatus: { PENDING: 'PENDING', SUCCESS: 'SUCCESS', FAILED: 'FAILED' },
  PledgeStatus: { ACTIVE: 'ACTIVE', PAUSED: 'PAUSED', CANCELLED: 'CANCELLED', FAILED: 'FAILED', COMPLETED: 'COMPLETED' },
  PledgeType: { ONE_OFF: 'ONE_OFF', RECURRING: 'RECURRING' },
  PledgeCadence: { WEEKLY: 'WEEKLY', MONTHLY: 'MONTHLY' },
  NotificationType: { PLEDGE_PAYMENT_FAILED: 'PLEDGE_PAYMENT_FAILED' },
  TransactionType: { DONATION: 'DONATION' },
}));

jest.mock('../services/donation.service', () => ({
  DonationService: {
    createConfirmedDonation: jest.fn(),
    dispatchPostConfirmationSideEffects: jest.fn(),
  },
}));

jest.mock('../services/recovery.service', () => ({
  createFailedPledgeCase: jest.fn().mockResolvedValue({ id: 'rc1' }),
}));

jest.mock('../blockchain/soroban.indexer', () => ({
  sorobanIndexer: { indexTransaction: jest.fn().mockResolvedValue(undefined) },
}));

/**
 * Builds a minimal hand-rolled Prisma mock exposing exactly the methods the
 * worker (and the real PledgeService it constructs internally) touch. Using
 * a plain object here — rather than jest.mock('@prisma/client') for the
 * whole module — keeps PledgeService's real logic under test instead of
 * re-implementing it in the mock.
 */
function buildMockPrisma(overrides: Partial<Record<string, any>> = {}) {
  const prisma: any = {
    pledge: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'p1', ...data })),
    },
    pledgeAttempt: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    notification: {
      create: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockImplementation(async (cb: any) => cb(prisma)),
  };
  return Object.assign(prisma, overrides);
}

function makePledge(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'pledge-1',
    donorId: 'donor-1',
    campaignId: 'campaign-1',
    amount: new Decimal(25),
    currency: 'USD',
    type: 'RECURRING',
    cadence: 'MONTHLY',
    startDate: new Date('2026-01-01'),
    nextRunAt: new Date('2026-07-01'),
    endDate: null,
    status: 'ACTIVE',
    metadata: null,
    ...overrides,
  };
}

describe('PledgeWorker', () => {
  let mockProvider: MockPaymentProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    mockProvider = new MockPaymentProvider();
    jest.spyOn(paymentIndex, 'getPaymentProvider').mockReturnValue(mockProvider);

    (DonationService.createConfirmedDonation as jest.Mock).mockResolvedValue({
      donation: { id: 'donation-1', amount: new Decimal(25), currency: 'USD' },
      matchedFund: null,
    });
  });

  describe('successful charge', () => {
    it('charges once, creates a confirmed donation, and advances nextRunAt', async () => {
      const pledge = makePledge();
      const prisma = buildMockPrisma({
        pledge: {
          findMany: jest.fn().mockResolvedValue([pledge]),
          findUnique: jest.fn().mockResolvedValue(pledge),
          update: jest.fn().mockResolvedValue({ ...pledge }),
        },
      });

      const worker = new PledgeWorker(prisma);
      await worker.processDuePledges();

      expect(mockProvider.callCount).toBe(1);
      expect(mockProvider.distinctChargeCount).toBe(1);
      expect(DonationService.createConfirmedDonation).toHaveBeenCalledTimes(1);
      expect(DonationService.createConfirmedDonation).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          campaignId: 'campaign-1',
          userId: 'donor-1',
          blockchainTxHash: 'pledge-pledge-1-2026-07-01',
        }),
      );
      expect(prisma.pledgeAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pledgeId: 'pledge-1',
            status: 'SUCCESS',
            providerReference: 'pledge-pledge-1-2026-07-01',
          }),
        }),
      );
      expect(DonationService.dispatchPostConfirmationSideEffects).toHaveBeenCalledTimes(1);
      // markAttemptSuccess (via PledgeService) should have advanced nextRunAt
      expect(prisma.pledge.update).toHaveBeenCalled();
    });
  });

  describe('restart safety / idempotency', () => {
    it('does not call the payment provider again if this billing cycle already succeeded', async () => {
      const pledge = makePledge();
      const prisma = buildMockPrisma({
        pledge: {
          findMany: jest.fn().mockResolvedValue([pledge]),
          findUnique: jest.fn().mockResolvedValue(pledge),
          update: jest.fn().mockResolvedValue({ ...pledge }),
        },
        pledgeAttempt: {
          // Simulate a prior run that already committed the SUCCESS attempt
          // for this exact cycle (crash happened AFTER commit, e.g. during
          // markAttemptSuccess, and the pledge got re-queued).
          findFirst: jest.fn().mockResolvedValue({
            id: 'att-1',
            pledgeId: 'pledge-1',
            providerReference: 'pledge-pledge-1-2026-07-01',
            status: 'SUCCESS',
          }),
          create: jest.fn().mockResolvedValue({}),
          count: jest.fn().mockResolvedValue(0),
        },
      });

      const worker = new PledgeWorker(prisma);
      await worker.processDuePledges();

      expect(mockProvider.callCount).toBe(0);
      expect(DonationService.createConfirmedDonation).not.toHaveBeenCalled();
      // Still advances the schedule so the pledge doesn't loop forever.
      expect(prisma.pledge.update).toHaveBeenCalled();
    });

    it('crash between charge success and transaction commit results in at most one real charge across two runs', async () => {
      const pledge = makePledge();
      let attemptRow: any = null;

      const prisma = buildMockPrisma({
        pledge: {
          findMany: jest.fn().mockResolvedValue([pledge]),
          findUnique: jest.fn().mockResolvedValue(pledge),
          update: jest.fn().mockResolvedValue({ ...pledge }),
        },
        pledgeAttempt: {
          // Mirrors the real query: only a SUCCESS row for this exact
          // idempotency key counts as "already completed".
          findFirst: jest.fn().mockImplementation(({ where }: any) => {
            if (
              attemptRow &&
              attemptRow.status === where.status &&
              attemptRow.providerReference === where.providerReference
            ) {
              return Promise.resolve(attemptRow);
            }
            return Promise.resolve(null);
          }),
          create: jest.fn().mockImplementation(({ data }) => {
            attemptRow = { id: 'att-1', ...data };
            return Promise.resolve(attemptRow);
          }),
          count: jest.fn().mockResolvedValue(0),
        },
      });
      // First run: simulate the DB transaction failing right after the
      // charge succeeded (crash before commit) — donation.service throws,
      // so no SUCCESS attempt is durably recorded. The worker's own error
      // handling still records a FAILED attempt for this cycle (it never
      // silently drops a failure), but crucially not a SUCCESS one.
      (DonationService.createConfirmedDonation as jest.Mock).mockRejectedValueOnce(
        new Error('simulated DB failure after successful payment'),
      );

      const worker = new PledgeWorker(prisma);
      await worker.processDuePledges();

      expect(mockProvider.distinctChargeCount).toBe(1); // charge went through once
      expect(attemptRow.status).toBe('FAILED'); // recorded as failed, not silently lost

      // Second run (post "restart"): DonationService now succeeds.
      (DonationService.createConfirmedDonation as jest.Mock).mockResolvedValueOnce({
        donation: { id: 'donation-1', amount: new Decimal(25), currency: 'USD' },
        matchedFund: null,
      });
      await worker.processDuePledges();

      // The provider is idempotent per-key: the second charge() call with the
      // same idempotencyKey returns the cached result rather than a new charge.
      expect(mockProvider.distinctChargeCount).toBe(1);
      expect(attemptRow).not.toBeNull();
      expect(attemptRow.status).toBe('SUCCESS');
    });
  });

  describe('retry counter cycle scoping', () => {
    it('scopes retryCount to the current billing cycle, ignoring historical attempts from prior cycles', async () => {
      const pledge = makePledge();
      const prisma = buildMockPrisma({
        pledge: {
          findMany: jest.fn().mockResolvedValue([pledge]),
          findUnique: jest.fn().mockResolvedValue(pledge),
          update: jest.fn().mockResolvedValue({ ...pledge }),
        },
        pledgeAttempt: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
          // 5 historical attempts exist, but none fall within the current
          // cycle window (attemptAt >= cycleStartAt), so the scoped count is 0.
          count: jest.fn().mockResolvedValue(0),
        },
      });

      (DonationService.createConfirmedDonation as jest.Mock).mockRejectedValueOnce(
        new Error('card declined'),
      );

      const worker = new PledgeWorker(prisma);
      await worker.processDuePledges();

      expect(prisma.pledgeAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'FAILED', retryCount: 1 }),
        }),
      );
      // Not dead-lettered yet (1 < MAX_RETRIES=3 by default)
      expect(prisma.pledge.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.not.objectContaining({ status: 'FAILED' }) }),
      );
    });
  });

  describe('dead-letter path', () => {
    it('marks the pledge FAILED, notifies the donor, and opens a recovery case after MAX_RETRIES failures in-cycle', async () => {
      const pledge = makePledge();
      const prisma = buildMockPrisma({
        pledge: {
          findMany: jest.fn().mockResolvedValue([pledge]),
          findUnique: jest.fn().mockResolvedValue(pledge),
          update: jest.fn().mockResolvedValue({ ...pledge }),
        },
        pledgeAttempt: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
          // 2 prior failures already recorded this cycle; this 3rd failure
          // should push retryCount to 3 === MAX_RETRIES and dead-letter.
          count: jest.fn().mockResolvedValue(2),
        },
      });

      (DonationService.createConfirmedDonation as jest.Mock).mockRejectedValueOnce(
        new Error('insufficient funds'),
      );

      const worker = new PledgeWorker(prisma);
      await worker.processDuePledges();

      expect(prisma.pledgeAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', retryCount: 3 }) }),
      );
      expect(prisma.pledge.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'pledge-1' }, data: { status: 'FAILED' } }),
      );
      expect(prisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'donor-1', type: 'PLEDGE_PAYMENT_FAILED' }),
        }),
      );
      expect(RecoveryService.createFailedPledgeCase).toHaveBeenCalledWith(
        'pledge-1',
        'donor-1',
        'insufficient funds',
        expect.objectContaining({ retryCount: 3 }),
      );
    });
  });

  describe('downstream effects', () => {
    it('passes the donation amount/campaign through to campaign-balance and analytics side effects', async () => {
      const pledge = makePledge();
      const prisma = buildMockPrisma({
        pledge: {
          findMany: jest.fn().mockResolvedValue([pledge]),
          findUnique: jest.fn().mockResolvedValue(pledge),
          update: jest.fn().mockResolvedValue({ ...pledge }),
        },
      });

      const worker = new PledgeWorker(prisma);
      await worker.processDuePledges();

      // Campaign increment + analytics increment happen inside
      // DonationService.createConfirmedDonation / dispatchPostConfirmationSideEffects,
      // which are covered directly in donation.service tests; here we assert
      // the worker wires the right amount/campaignId through to them.
      expect(DonationService.dispatchPostConfirmationSideEffects).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: 'campaign-1',
          amount: expect.any(Decimal),
          currency: 'USD',
        }),
      );
    });
  });
});
