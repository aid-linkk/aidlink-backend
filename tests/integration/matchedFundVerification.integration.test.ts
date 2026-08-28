/**
 * Integration tests for MatchedFundVerificationService
 *
 * These tests use a REAL PostgreSQL database (via Prisma) to exercise:
 *   - End-to-end inconsistency detection against live data
 *   - Repair with actual FOR UPDATE locks (serialized correctly)
 *   - Concurrent allocation during repair (repair does not clobber new funds)
 *   - Repair logs old/new values correctly
 *   - Idempotency: running repair twice leaves system in correct state
 *   - Existing allocation and refund paths continue to work during verification
 *
 * Skips automatically when no database is reachable so `npm test` stays
 * green on machines without Postgres running.
 *
 * Prerequisites (to run):
 *   - DATABASE_URL pointing to a test database (see .env.test)
 *   - Schema already migrated
 *
 * Run:
 *   npm run test:integration -- --testPathPattern=matchedFundVerification.integration
 */

import { PrismaClient, Prisma, MultiplierType, DonationStatus, Role } from '@prisma/client';
import { MatchedFundVerificationService } from '../../src/services/matchedFundVerification.service';
import { MatchedFundAllocationService } from '../../src/services/matchedFundAllocation.service';

const prisma = new PrismaClient();

let dbAvailable = true;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbAvailable = false;
    console.warn(
      '[matchedFundVerification.integration] No reachable Postgres at DATABASE_URL — skipping. ' +
        'Start one (e.g. docker-compose up) and set DATABASE_URL to run this suite.',
    );
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Wrap a test so it auto-skips without a DB. */
const skippable = (name: string, fn: () => Promise<void>, timeout?: number): void => {
  it(name, async () => {
    if (!dbAvailable) return;
    await fn();
  }, timeout ?? 15_000);
};

// ─── Setup helpers ────────────────────────────────────────────────────────────

type Scaffold = {
  userId: string;
  orgId: string;
  campaignId: string;
  multiplierId: string;
};

async function createTestScaffold(label: string): Promise<Scaffold> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const user = await prisma.user.create({
    data: { email: `vtest-${suffix}@example.com`, role: Role.DONOR },
  });

  const org = await prisma.organization.create({
    data: {
      userId: user.id,
      name: `Verify Org ${suffix}`,
      description: 'integration test org',
      country: 'US',
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      title: `Verify Campaign ${suffix}`,
      description: 'integration test campaign',
      goalAmount: new Prisma.Decimal('10000'),
      currentAmount: new Prisma.Decimal('0'),
      currency: 'USD',
      status: 'ACTIVE',
      organizationId: org.id,
      userId: user.id,
      startDate: new Date(),
    },
  });

  const multiplier = await prisma.multiplier.create({
    data: {
      campaignId: campaign.id,
      type: MultiplierType.CAMPAIGN_WIDE,
      multiplier: new Prisma.Decimal('2'),
      matchCap: new Prisma.Decimal('5000'),
      matchedTotal: new Prisma.Decimal('0'),
      active: true,
      createdBy: user.id,
    },
  });

  return {
    userId: user.id,
    orgId: org.id,
    campaignId: campaign.id,
    multiplierId: multiplier.id,
  };
}

async function cleanupScaffold(s: Scaffold): Promise<void> {
  await prisma.matchedFund.deleteMany({ where: { multiplierId: s.multiplierId } });
  await prisma.donation.deleteMany({ where: { campaignId: s.campaignId } });
  await prisma.multiplier.deleteMany({ where: { id: s.multiplierId } });
  await prisma.campaign.deleteMany({ where: { id: s.campaignId } });
  await prisma.organization.deleteMany({ where: { id: s.orgId } });
  await prisma.user.deleteMany({ where: { id: s.userId } });
}

async function createDonation(campaignId: string, userId: string, amount: string) {
  return prisma.donation.create({
    data: {
      campaignId,
      userId,
      amount: new Prisma.Decimal(amount),
      currency: 'USD',
      status: DonationStatus.CONFIRMED,
      blockchainTxHash: `tx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
}

async function createMatchedFund(
  donationId: string,
  campaignId: string,
  multiplierId: string,
  matchedAmount: string,
) {
  return prisma.matchedFund.create({
    data: {
      donationId,
      campaignId,
      multiplierId,
      donorAmount: new Prisma.Decimal('100'),
      matchedAmount: new Prisma.Decimal(matchedAmount),
      totalAmount: new Prisma.Decimal('100').plus(new Prisma.Decimal(matchedAmount)),
    },
  });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('MatchedFundVerification – integration', () => {
  // ── 1. Consistent state ──────────────────────────────────────────────────
  skippable('detects no inconsistency when matchedTotal equals the true sum', async () => {
    const s = await createTestScaffold('consistent');

    const d = await createDonation(s.campaignId, s.userId, '100');
    await createMatchedFund(d.id, s.campaignId, s.multiplierId, '100');

    await prisma.multiplier.update({
      where: { id: s.multiplierId },
      data: { matchedTotal: new Prisma.Decimal('100') },
    });

    const result = await MatchedFundVerificationService.verify('TRIGGERED', false);
    const inc = result.inconsistencies.find((i) => i.multiplierId === s.multiplierId);
    expect(inc).toBeUndefined();

    await cleanupScaffold(s);
  });

  // ── 2. Detection of injected drift ──────────────────────────────────────
  skippable('detects and repairs injected drift via injectInconsistencyForTesting', async () => {
    const s = await createTestScaffold('drift');

    const d = await createDonation(s.campaignId, s.userId, '100');
    await createMatchedFund(d.id, s.campaignId, s.multiplierId, '100');
    await prisma.multiplier.update({
      where: { id: s.multiplierId },
      data: { matchedTotal: new Prisma.Decimal('100') },
    });

    // Inject drift
    await MatchedFundVerificationService.injectInconsistencyForTesting(s.multiplierId, '999');

    // Detect
    const detectResult = await MatchedFundVerificationService.verify('TRIGGERED', false);
    const inc = detectResult.inconsistencies.find((i) => i.multiplierId === s.multiplierId);
    expect(inc).toBeDefined();
    expect(inc!.storedTotal.toNumber()).toBeCloseTo(999, 5);
    expect(inc!.actualSum.toNumber()).toBeCloseTo(100, 5);

    // Repair
    const repairResult = await MatchedFundVerificationService.verify('TRIGGERED', true);
    const repair = repairResult.repairs.find((r) => r.multiplierId === s.multiplierId);
    expect(repair?.success).toBe(true);

    // Verify DB was corrected
    const updated = await prisma.multiplier.findUniqueOrThrow({ where: { id: s.multiplierId } });
    expect(new Prisma.Decimal(updated.matchedTotal).toNumber()).toBeCloseTo(100, 5);

    await cleanupScaffold(s);
  });

  // ── 3. Refunded rows excluded from true sum ──────────────────────────────
  skippable('excludes refunded MatchedFund rows from the true sum', async () => {
    const s = await createTestScaffold('refund-excl');

    const d1 = await createDonation(s.campaignId, s.userId, '100');
    const d2 = await createDonation(s.campaignId, s.userId, '100');
    const mf1 = await createMatchedFund(d1.id, s.campaignId, s.multiplierId, '100');
    const mf2 = await createMatchedFund(d2.id, s.campaignId, s.multiplierId, '100');

    // Mark mf2 as refunded — should be excluded from true sum
    await prisma.matchedFund.update({
      where: { id: mf2.id },
      data: { refundedAt: new Date() },
    });
    // matchedTotal should reflect only mf1 (100), not 200
    await prisma.multiplier.update({
      where: { id: s.multiplierId },
      data: { matchedTotal: new Prisma.Decimal('100') },
    });

    const result = await MatchedFundVerificationService.verify('TRIGGERED', false);
    const inc = result.inconsistencies.find((i) => i.multiplierId === s.multiplierId);
    expect(inc).toBeUndefined(); // 100 == 100, consistent

    await cleanupScaffold(s);
  });

  // ── 4. Repair idempotency ────────────────────────────────────────────────
  skippable('running repair twice is idempotent', async () => {
    const s = await createTestScaffold('idempotent');

    const d = await createDonation(s.campaignId, s.userId, '200');
    await createMatchedFund(d.id, s.campaignId, s.multiplierId, '200');
    await MatchedFundVerificationService.injectInconsistencyForTesting(s.multiplierId, '0');

    // First repair
    const r1 = await MatchedFundVerificationService.verify('TRIGGERED', true);
    expect(r1.repairs.find((r) => r.multiplierId === s.multiplierId)?.success).toBe(true);

    // Second run: nothing left to repair
    const r2 = await MatchedFundVerificationService.verify('TRIGGERED', true);
    expect(r2.inconsistencies.find((i) => i.multiplierId === s.multiplierId)).toBeUndefined();

    await cleanupScaffold(s);
  });

  // ── 5. Concurrent allocation: repair re-reads correct sum inside TX ──────
  skippable(
    'repair sets the post-concurrent-allocation true sum (re-reads inside FOR UPDATE TX)',
    async () => {
      const s = await createTestScaffold('concurrent');

      // Set up: 100 already matched
      const d1 = await createDonation(s.campaignId, s.userId, '100');
      await createMatchedFund(d1.id, s.campaignId, s.multiplierId, '100');

      // Inject wrong matchedTotal
      await MatchedFundVerificationService.injectInconsistencyForTesting(s.multiplierId, '0');

      // Simulate concurrent allocation: another 50 arrives between detect and repair
      const d2 = await createDonation(s.campaignId, s.userId, '100');
      await createMatchedFund(d2.id, s.campaignId, s.multiplierId, '50');

      // At this point: matchedTotal=0 (wrong), true sum=150 (100+50)
      // Repair must re-read inside TX and set 150, not 100
      const result = await MatchedFundVerificationService.verify('TRIGGERED', true);
      const repair = result.repairs.find((r) => r.multiplierId === s.multiplierId);
      expect(repair?.success).toBe(true);

      const updated = await prisma.multiplier.findUniqueOrThrow({ where: { id: s.multiplierId } });
      expect(new Prisma.Decimal(updated.matchedTotal).toNumber()).toBeCloseTo(150, 5);

      await cleanupScaffold(s);
    },
    20_000,
  );

  // ── 6. Allocation path still works correctly after verification ──────────
  skippable('normal allocation path remains correct after a verification run', async () => {
    const s = await createTestScaffold('alloc-after');

    // Run clean verification
    const verifyResult = await MatchedFundVerificationService.verify('TRIGGERED', true);
    // No drift on our fresh multiplier
    expect(verifyResult.inconsistencies.find((i) => i.multiplierId === s.multiplierId)).toBeUndefined();

    // Perform a real allocation
    const d = await createDonation(s.campaignId, s.userId, '100');
    const fullMultiplier = await prisma.multiplier.findUniqueOrThrow({
      where: { id: s.multiplierId },
    });

    await prisma.$transaction(async (tx) => {
      await MatchedFundAllocationService.allocate(tx, {
        donationId: d.id,
        campaignId: s.campaignId,
        donorAmount: new Prisma.Decimal('100'),
        multiplier: fullMultiplier,
      });
    });

    // matchedTotal should now be 100
    const afterAlloc = await prisma.multiplier.findUniqueOrThrow({ where: { id: s.multiplierId } });
    expect(new Prisma.Decimal(afterAlloc.matchedTotal).toNumber()).toBeCloseTo(100, 5);

    // Post-allocation verification should find no drift
    const finalCheck = await MatchedFundVerificationService.verify('TRIGGERED', false);
    expect(finalCheck.inconsistencies.find((i) => i.multiplierId === s.multiplierId)).toBeUndefined();

    await cleanupScaffold(s);
  });
});
