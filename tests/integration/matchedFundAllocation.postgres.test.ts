/**
 * Integration test for matched-fund allocation against a real PostgreSQL
 * instance. Unlike the other integration tests in this directory (which run
 * against an in-memory Prisma fake), concurrency safety here depends on
 * Postgres row locking (`FOR UPDATE`) that a single-threaded JS fake cannot
 * exercise. Requires DATABASE_URL to point at a real, disposable Postgres
 * database (see .env.test / docker-compose.yml) — every test truncates its
 * tables, so do not point this at a database with data worth keeping.
 *
 * Skips automatically when no database is reachable so `npm test` stays
 * green on machines without Postgres running.
 *
 * ─── Acceptance-Criteria Tests ────────────────────────────────────────────
 *
 * AC-1 (50-parallel, round cap):
 *   50 parallel confirmDonation calls targeting the same multiplier with
 *   matchCap=1000 and per-donation amount=100. After all settle,
 *   SUM(matchedAmount) = exactly 1000, never > 1000.
 *
 * AC-2 (50-parallel, non-round cap):
 *   Same test with matchCap=333.33333333 to verify Decimal precision.
 */

import { PrismaClient, MultiplierType, DonationStatus, Prisma } from '@prisma/client';
import { MultiplierService } from '../../src/services/multiplier.service';
import { MatchedFundAllocationService } from '../../src/services/matchedFundAllocation.service';

const prisma = new PrismaClient();

let dbAvailable = true;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbAvailable = false;
    // eslint-disable-next-line no-console
    console.warn(
      '[matchedFundAllocation.postgres.test] No reachable Postgres at DATABASE_URL — skipping. ' +
        'Start one (e.g. docker-compose up) and set DATABASE_URL to run this suite.',
    );
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

const skippable = (name: string, fn: () => Promise<void>, timeout?: number) => {
  it(name, async () => {
    if (!dbAvailable) return;
    await fn();
  }, timeout);
};

/**
 * Helper: confirms a single donation and allocates matched funds within
 * a single atomic transaction. Returns { confirmed, matchedFund } so callers
 * can verify idempotency guards.
 */
const confirmAndAllocate = async (
  donationId: string,
  donorAmount: Prisma.Decimal,
  campaignId: string,
) =>
  prisma.$transaction(async (tx) => {
    const confirmResult = await tx.donation.updateMany({
      where: { id: donationId, status: { not: DonationStatus.CONFIRMED } },
      data: { status: DonationStatus.CONFIRMED },
    });
    if (confirmResult.count === 0) return { confirmed: false, matchedFund: null };

    const multiplier = await MultiplierService.evaluateMultiplierAtDonation(
      { campaignId, donationTime: new Date() },
      tx,
    );
    const matchedFund = await MatchedFundAllocationService.allocate(tx, {
      donationId,
      campaignId,
      donorAmount,
      multiplier,
    });
    return { confirmed: true, matchedFund };
  });

describe('Matched-fund allocation under real Postgres concurrency', () => {
  let campaignId: string;
  let donorId: string;

  beforeEach(async () => {
    if (!dbAvailable) return;

    await prisma.matchedFund.deleteMany();
    await prisma.multiplier.deleteMany();
    await prisma.donation.deleteMany();
    await prisma.campaign.deleteMany();
    await prisma.organization.deleteMany();
    await prisma.user.deleteMany();

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const orgOwner = await prisma.user.create({
      data: { email: `org-${suffix}@test.com`, role: 'ORGANIZATION' },
    });
    const organization = await prisma.organization.create({
      data: { userId: orgOwner.id, name: 'Test Org' },
    });
    const campaign = await prisma.campaign.create({
      data: {
        organizationId: organization.id,
        userId: orgOwner.id,
        title: 'Test Campaign',
        description: 'desc',
        targetAmount: new Prisma.Decimal(1_000_000),
        startDate: new Date(),
        status: 'ACTIVE',
      },
    });
    const donor = await prisma.user.create({ data: { email: `donor-${suffix}@test.com` } });

    campaignId = campaign.id;
    donorId = donor.id;
  });

  // ─── Acceptance Criterion 1: 50-parallel, round matchCap ────────────────

  skippable(
    '[AC-1] 50 parallel confirmations never exceed matchCap=1000 (per-donation match=100)',
    async () => {
      const matchCap = new Prisma.Decimal(1000);
      const donorAmount = new Prisma.Decimal(100); // multiplier=2 → desired match=100 each
      const concurrency = 50;

      const multiplier = await prisma.multiplier.create({
        data: {
          campaignId,
          type: MultiplierType.CAMPAIGN_WIDE,
          multiplier: new Prisma.Decimal(2),
          matchCap,
          createdBy: 'admin',
          active: true,
        },
      });

      const donations = await Promise.all(
        Array.from({ length: concurrency }).map(() =>
          prisma.donation.create({
            data: {
              campaignId,
              userId: donorId,
              amount: donorAmount,
              currency: 'USD',
            },
          }),
        ),
      );

      // Fire all 50 confirmations concurrently — the core race condition.
      await Promise.all(
        donations.map((d) => confirmAndAllocate(d.id, donorAmount, campaignId)),
      );

      const rows = await prisma.matchedFund.findMany({ where: { multiplierId: multiplier.id } });
      const totalMatched = rows.reduce(
        (sum, r) => sum.plus(r.matchedAmount),
        new Prisma.Decimal(0),
      );

      // Invariant: total MUST NOT exceed matchCap.
      expect(totalMatched.greaterThan(matchCap)).toBe(false);

      // Invariant: total MUST equal matchCap exactly (10 of 50 are funded, exactly).
      expect(totalMatched.toString()).toBe('1000');

      // Verify the authoritative counter on the Multiplier row agrees.
      const finalMultiplier = await prisma.multiplier.findUniqueOrThrow({
        where: { id: multiplier.id },
      });
      expect(new Prisma.Decimal(finalMultiplier.matchedTotal).toString()).toBe('1000');

      // All 50 donations must be CONFIRMED regardless of whether they got a match.
      const finalDonations = await prisma.donation.findMany({ where: { campaignId } });
      expect(finalDonations.every((d) => d.status === DonationStatus.CONFIRMED)).toBe(true);
    },
    60_000,
  );

  // ─── Acceptance Criterion 2: 50-parallel, non-round matchCap ────────────

  skippable(
    '[AC-2] 50 parallel confirmations with matchCap=333.33333333 preserve Decimal precision',
    async () => {
      // matchCap is not an even multiple of per-donation-match (100).
      // Exactly 3 donations get a full 100 match (total=300),
      // one donation gets a partial 33.33333333 match,
      // the remainder get nothing.
      const matchCap = new Prisma.Decimal('333.33333333');
      const donorAmount = new Prisma.Decimal(100);
      const concurrency = 50;

      const multiplier = await prisma.multiplier.create({
        data: {
          campaignId,
          type: MultiplierType.CAMPAIGN_WIDE,
          multiplier: new Prisma.Decimal(2),
          matchCap,
          createdBy: 'admin',
          active: true,
        },
      });

      const donations = await Promise.all(
        Array.from({ length: concurrency }).map(() =>
          prisma.donation.create({
            data: {
              campaignId,
              userId: donorId,
              amount: donorAmount,
              currency: 'USD',
            },
          }),
        ),
      );

      await Promise.all(
        donations.map((d) => confirmAndAllocate(d.id, donorAmount, campaignId)),
      );

      const rows = await prisma.matchedFund.findMany({ where: { multiplierId: multiplier.id } });
      const totalMatched = rows.reduce(
        (sum, r) => sum.plus(r.matchedAmount),
        new Prisma.Decimal(0),
      );

      // The sum must equal matchCap exactly — verifies no float drift.
      expect(totalMatched.toString()).toBe('333.33333333');

      // The authoritative counter must agree.
      const finalMultiplier = await prisma.multiplier.findUniqueOrThrow({
        where: { id: multiplier.id },
      });
      expect(new Prisma.Decimal(finalMultiplier.matchedTotal).toString()).toBe('333.33333333');

      // The partial-match row must appear: exactly one row with amount < 100
      const partials = rows.filter((r) => new Prisma.Decimal(r.matchedAmount).lessThan(100));
      expect(partials).toHaveLength(1);
      expect(partials[0].matchedAmount.toString()).toBe('33.33333333');
    },
    60_000,
  );

  // ─── Regression tests retained from the original 20-concurrent suite ────

  skippable(
    'never exceeds matchCap across 20 concurrent confirmations racing the same multiplier',
    async () => {
      const multiplier = await prisma.multiplier.create({
        data: {
          campaignId,
          type: MultiplierType.CAMPAIGN_WIDE,
          multiplier: new Prisma.Decimal(2),
          matchCap: new Prisma.Decimal(500),
          createdBy: 'admin',
          active: true,
        },
      });

      // 20 donations of 50 each want a 50 match apiece = 1000 desired, cap is 500.
      const donations = await Promise.all(
        Array.from({ length: 20 }).map(() =>
          prisma.donation.create({
            data: { campaignId, userId: donorId, amount: new Prisma.Decimal(50), currency: 'USD' },
          }),
        ),
      );

      await Promise.all(donations.map((d) => confirmAndAllocate(d.id, new Prisma.Decimal(50), campaignId)));

      const rows = await prisma.matchedFund.findMany({ where: { multiplierId: multiplier.id } });
      const total = rows.reduce((sum, r) => sum.plus(r.matchedAmount), new Prisma.Decimal(0));

      expect(total.toString()).toBe('500');
      expect(rows.length).toBe(10); // exactly 10 of the 20 get the full 50; the rest get nothing

      const finalMultiplier = await prisma.multiplier.findUniqueOrThrow({ where: { id: multiplier.id } });
      expect(finalMultiplier.matchedTotal.toString()).toBe('500');

      const finalDonations = await prisma.donation.findMany({ where: { campaignId } });
      expect(finalDonations.every((d) => d.status === DonationStatus.CONFIRMED)).toBe(true);
    },
    30000,
  );

  skippable(
    'exactly consumes a matchCap that is not an even multiple of the per-donation match (adversarial edge case)',
    async () => {
      const multiplier = await prisma.multiplier.create({
        data: {
          campaignId,
          type: MultiplierType.CAMPAIGN_WIDE,
          multiplier: new Prisma.Decimal(2),
          matchCap: new Prisma.Decimal(105), // not a multiple of 50 -> forces a partial allocation
          createdBy: 'admin',
          active: true,
        },
      });

      const donations = await Promise.all(
        Array.from({ length: 10 }).map(() =>
          prisma.donation.create({
            data: { campaignId, userId: donorId, amount: new Prisma.Decimal(50), currency: 'USD' },
          }),
        ),
      );

      await Promise.all(donations.map((d) => confirmAndAllocate(d.id, new Prisma.Decimal(50), campaignId)));

      const rows = await prisma.matchedFund.findMany({ where: { multiplierId: multiplier.id } });
      const total = rows.reduce((sum, r) => sum.plus(r.matchedAmount), new Prisma.Decimal(0));

      expect(total.toString()).toBe('105');
      // 2 full matches of 50 + exactly one partial match of 5
      const amounts = rows.map((r) => r.matchedAmount.toString()).sort();
      expect(amounts).toContain('5');
    },
    30000,
  );

  skippable(
    'enforces perDonationCap independently of matchCap headroom',
    async () => {
      await prisma.multiplier.create({
        data: {
          campaignId,
          type: MultiplierType.CAMPAIGN_WIDE,
          multiplier: new Prisma.Decimal(3),
          matchCap: new Prisma.Decimal(10_000),
          perDonationCap: new Prisma.Decimal(20),
          createdBy: 'admin',
          active: true,
        },
      });

      const donation = await prisma.donation.create({
        data: { campaignId, userId: donorId, amount: new Prisma.Decimal(100), currency: 'USD' },
      });

      // desired match = 100 * (3-1) = 200, but perDonationCap clamps to 20
      await confirmAndAllocate(donation.id, new Prisma.Decimal(100), campaignId);

      const row = await prisma.matchedFund.findUnique({ where: { donationId: donation.id } });
      expect(row?.matchedAmount.toString()).toBe('20');
    },
    30000,
  );

  skippable(
    'rejects a competing confirmation for the same donation and allocates matched funds only once',
    async () => {
      await prisma.multiplier.create({
        data: {
          campaignId,
          type: MultiplierType.CAMPAIGN_WIDE,
          multiplier: new Prisma.Decimal(2),
          matchCap: new Prisma.Decimal(1000),
          createdBy: 'admin',
          active: true,
        },
      });

      const donation = await prisma.donation.create({
        data: { campaignId, userId: donorId, amount: new Prisma.Decimal(50), currency: 'USD' },
      });

      const [first, second] = await Promise.all([
        confirmAndAllocate(donation.id, new Prisma.Decimal(50), campaignId),
        confirmAndAllocate(donation.id, new Prisma.Decimal(50), campaignId),
      ]);

      const confirmedCount = [first, second].filter((r) => r.confirmed).length;
      expect(confirmedCount).toBe(1);

      const matchedFundRows = await prisma.matchedFund.findMany({ where: { donationId: donation.id } });
      expect(matchedFundRows).toHaveLength(1);
    },
    30000,
  );

  skippable(
    'stays atomic when the confirmation call is retried sequentially after it already committed',
    async () => {
      await prisma.multiplier.create({
        data: {
          campaignId,
          type: MultiplierType.CAMPAIGN_WIDE,
          multiplier: new Prisma.Decimal(2),
          matchCap: new Prisma.Decimal(1000),
          createdBy: 'admin',
          active: true,
        },
      });

      const donation = await prisma.donation.create({
        data: { campaignId, userId: donorId, amount: new Prisma.Decimal(50), currency: 'USD' },
      });

      // Simulates a caller retrying confirmDonation (e.g. after a dropped
      // response) once the first attempt has already committed.
      const first = await confirmAndAllocate(donation.id, new Prisma.Decimal(50), campaignId);
      const retry = await confirmAndAllocate(donation.id, new Prisma.Decimal(50), campaignId);

      expect(first.confirmed).toBe(true);
      expect(retry.confirmed).toBe(false);
      expect(retry.matchedFund).toBeNull();

      const matchedFundRows = await prisma.matchedFund.findMany({ where: { donationId: donation.id } });
      expect(matchedFundRows).toHaveLength(1);
      expect(matchedFundRows[0].matchedAmount.toString()).toBe('50');

      const multiplierRow = await prisma.multiplier.findFirstOrThrow({ where: { campaignId } });
      expect(multiplierRow.matchedTotal.toString()).toBe('50');
    },
    30000,
  );

  skippable(
    'resolves the correct multiplier under mixed precedence with real timestamps',
    async () => {
      const milestone = await prisma.milestone.create({
        data: {
          campaignId,
          title: 'M1',
          description: 'd',
          targetAmount: new Prisma.Decimal(1000),
          order: 1,
        },
      });

      await prisma.multiplier.create({
        data: {
          campaignId,
          type: MultiplierType.CAMPAIGN_WIDE,
          multiplier: new Prisma.Decimal(5),
          createdBy: 'admin',
          active: true,
        },
      });
      await prisma.multiplier.create({
        data: {
          campaignId,
          type: MultiplierType.CORPORATE,
          multiplier: new Prisma.Decimal(4),
          createdBy: 'admin',
          active: true,
        },
      });
      const milestoneMultiplier = await prisma.multiplier.create({
        data: {
          campaignId,
          type: MultiplierType.MILESTONE,
          milestoneId: milestone.id,
          multiplier: new Prisma.Decimal(1.1),
          createdBy: 'admin',
          active: true,
        },
      });

      const winner = await MultiplierService.evaluateMultiplierAtDonation(
        { campaignId, donationTime: new Date(), milestoneId: milestone.id },
        prisma,
      );

      expect(winner?.id).toBe(milestoneMultiplier.id);
    },
    30000,
  );
});
