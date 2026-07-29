import { MatchedFundAllocationService } from './matchedFundAllocation.service';
import { MultiplierType, Prisma } from '@prisma/client';

type M = Parameters<typeof MatchedFundAllocationService.computeDesiredMatch>[1];

const baseMultiplier = (overrides: Partial<M>): M =>
  ({
    id: 'mult-1',
    campaignId: 'camp1',
    type: MultiplierType.CAMPAIGN_WIDE,
    multiplier: 2 as any,
    matchCap: null,
    perDonationCap: null,
    matchedTotal: 0 as any,
    startAt: null,
    endAt: null,
    milestoneId: null,
    metadata: null,
    active: true,
    createdBy: 'admin1',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  }) as M;

describe('MatchedFundAllocationService.computeDesiredMatch', () => {
  it('computes donorAmount * (multiplier - 1) with no caps', () => {
    const multiplier = baseMultiplier({ multiplier: 2 as any });
    const result = MatchedFundAllocationService.computeDesiredMatch(new Prisma.Decimal(50), multiplier);
    expect(result.toString()).toBe('50');
  });

  it('returns zero when multiplier is exactly 1', () => {
    const multiplier = baseMultiplier({ multiplier: 1 as any });
    const result = MatchedFundAllocationService.computeDesiredMatch(new Prisma.Decimal(50), multiplier);
    expect(result.toString()).toBe('0');
  });

  it('clamps to perDonationCap when the raw match exceeds it', () => {
    const multiplier = baseMultiplier({ multiplier: 3 as any, perDonationCap: 40 as any });
    const result = MatchedFundAllocationService.computeDesiredMatch(new Prisma.Decimal(50), multiplier);
    expect(result.toString()).toBe('40');
  });

  it('does not clamp when the raw match is under perDonationCap', () => {
    const multiplier = baseMultiplier({ multiplier: 1.5 as any, perDonationCap: 100 as any });
    const result = MatchedFundAllocationService.computeDesiredMatch(new Prisma.Decimal(50), multiplier);
    expect(result.toString()).toBe('25');
  });

  it('preserves decimal precision instead of falling back to floating point', () => {
    const multiplier = baseMultiplier({ multiplier: 1.1 as any });
    const result = MatchedFundAllocationService.computeDesiredMatch(new Prisma.Decimal('10.33'), multiplier);
    // 10.33 * 0.1 in naive floating point is 1.0329999999999999
    expect(result.toString()).toBe('1.033');
  });
});

describe('MatchedFundAllocationService.allocate', () => {
  const makeTx = (appliedFromQuery: string | null) => ({
    $queryRaw: jest.fn().mockResolvedValue(appliedFromQuery === null ? [] : [{ applied: appliedFromQuery }]),
    matchedFund: {
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'mf-1', ...data })),
    },
  });

  it('returns null when no multiplier applies', async () => {
    const tx = makeTx('0');
    const result = await MatchedFundAllocationService.allocate(tx as any, {
      donationId: 'd1',
      campaignId: 'camp1',
      donorAmount: 100,
      multiplier: null,
    });

    expect(result).toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.matchedFund.create).not.toHaveBeenCalled();
  });

  it('returns null and skips the DB round trip when the desired match is zero', async () => {
    const tx = makeTx('0');
    const multiplier = baseMultiplier({ multiplier: 1 as any });

    const result = await MatchedFundAllocationService.allocate(tx as any, {
      donationId: 'd1',
      campaignId: 'camp1',
      donorAmount: 100,
      multiplier,
    });

    expect(result).toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('creates a matched fund for the amount the atomic claim grants', async () => {
    const tx = makeTx('100');
    const multiplier = baseMultiplier({ multiplier: 2 as any, matchCap: 1000 as any });

    const result = await MatchedFundAllocationService.allocate(tx as any, {
      donationId: 'd1',
      campaignId: 'camp1',
      donorAmount: 100,
      multiplier,
    });

    expect(tx.matchedFund.create).toHaveBeenCalledTimes(1);
    expect(result?.donorAmount.toString()).toBe('100');
    expect(result?.matchedAmount.toString()).toBe('100');
    expect(result?.totalAmount.toString()).toBe('200');
  });

  it('creates a partial matched fund when the atomic claim grants less than desired', async () => {
    // matchCap nearly exhausted: only 30 of the desired 100 can be claimed.
    const tx = makeTx('30');
    const multiplier = baseMultiplier({ multiplier: 2 as any, matchCap: 1000 as any });

    const result = await MatchedFundAllocationService.allocate(tx as any, {
      donationId: 'd1',
      campaignId: 'camp1',
      donorAmount: 100,
      multiplier,
    });

    expect(result?.matchedAmount.toString()).toBe('30');
    expect(result?.totalAmount.toString()).toBe('130');
  });

  it('returns null without creating a row when the claim grants zero (cap exhausted)', async () => {
    const tx = makeTx('0');
    const multiplier = baseMultiplier({ multiplier: 2 as any, matchCap: 1000 as any });

    const result = await MatchedFundAllocationService.allocate(tx as any, {
      donationId: 'd1',
      campaignId: 'camp1',
      donorAmount: 100,
      multiplier,
    });

    expect(result).toBeNull();
    expect(tx.matchedFund.create).not.toHaveBeenCalled();
  });

  it('throws when the multiplier row disappears mid-transaction', async () => {
    const tx = makeTx(null);
    const multiplier = baseMultiplier({ multiplier: 2 as any });

    await expect(
      MatchedFundAllocationService.allocate(tx as any, {
        donationId: 'd1',
        campaignId: 'camp1',
        donorAmount: 100,
        multiplier,
      }),
    ).rejects.toThrow('Multiplier not found during matched-fund allocation');
  });
});

describe('MatchedFundAllocationService.buildSummary', () => {
  it('returns null when there is no matched fund', () => {
    expect(MatchedFundAllocationService.buildSummary(null, null)).toBeNull();
  });

  it('marks capped=true when the applied amount is less than the desired amount', () => {
    const multiplier = baseMultiplier({ multiplier: 2 as any });
    const matchedFund = {
      id: 'mf-1',
      donationId: 'd1',
      campaignId: 'camp1',
      multiplierId: 'mult-1',
      matcherId: null,
      donorAmount: new Prisma.Decimal(100) as any,
      matchedAmount: new Prisma.Decimal(30) as any,
      totalAmount: new Prisma.Decimal(130) as any,
      createdAt: new Date(),
    };

    const summary = MatchedFundAllocationService.buildSummary(matchedFund, multiplier);
    expect(summary).toEqual({
      multiplierId: 'mult-1',
      multiplierType: 'CAMPAIGN_WIDE',
      multiplierValue: '2',
      donorAmount: '100',
      matchedAmount: '30',
      totalAmount: '130',
      capped: true,
    });
  });

  it('marks capped=false when the full desired amount was granted', () => {
    const multiplier = baseMultiplier({ multiplier: 2 as any });
    const matchedFund = {
      id: 'mf-1',
      donationId: 'd1',
      campaignId: 'camp1',
      multiplierId: 'mult-1',
      matcherId: null,
      donorAmount: new Prisma.Decimal(100) as any,
      matchedAmount: new Prisma.Decimal(100) as any,
      totalAmount: new Prisma.Decimal(200) as any,
      createdAt: new Date(),
    };

    const summary = MatchedFundAllocationService.buildSummary(matchedFund, multiplier);
    expect(summary?.capped).toBe(false);
  });
});

// ─── Acceptance-Criteria Unit Tests ──────────────────────────────────────────
//
// These tests directly verify the two AC items from the TOCTOU fix spec:
//
//   AC-3a: perDonationCap is applied BEFORE matchCap consumption — the value
//          passed to the atomic claimMatchCap SQL is already capped by
//          perDonationCap, not the raw donorAmount × (multiplier−1).
//
//   AC-3b: A single oversized donation cannot claim more than
//          min(perDonationCap, remaining_matchCap).

describe('MatchedFundAllocationService – perDonationCap applied before matchCap (AC-3a)', () => {
  const makeTx = (appliedFromQuery: string) => ({
    $queryRaw: jest.fn().mockResolvedValue([{ applied: appliedFromQuery }]),
    matchedFund: {
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'mf-ac', ...data })),
    },
  });

  it('passes the perDonationCap-clamped value (not the raw match) to the atomic SQL claim', async () => {
    // donorAmount=500, multiplier=3 → raw match = 500*(3-1) = 1000
    // perDonationCap=75 → desired match sent to DB should be 75, not 1000
    // matchCap has plenty of headroom so the DB grants the full 75.
    const tx = makeTx('75');
    const multiplier = baseMultiplier({
      multiplier: 3 as any,
      perDonationCap: 75 as any,
      matchCap: 10_000 as any,
    });

    const result = await MatchedFundAllocationService.allocate(tx as any, {
      donationId: 'd-ac1',
      campaignId: 'camp1',
      donorAmount: 500,
      multiplier,
    });

    // The $queryRaw call should have received the perDonationCap-clamped
    // value (75) as the desired-match parameter, not the raw 1000.
    // We verify this by inspecting the SQL template tag args captured by jest:
    const rawArgs = (tx.$queryRaw as jest.Mock).mock.calls[0][0];
    // Prisma.sql tagged template: rawArgs.values contains the interpolated
    // parameters. The first value is multiplierId; the second and third are
    // the desired-match amount (appears twice in the CASE expression).
    const sqlValues: string[] = rawArgs.values ?? rawArgs;
    const desiredMatchParam = sqlValues.find(
      (v: any) => typeof v === 'string' && v !== multiplier.id,
    );
    expect(desiredMatchParam).toBe('75');

    // The matched fund row should record exactly 75 (what the DB granted).
    expect(result?.matchedAmount.toString()).toBe('75');
  });

  it('perDonationCap=0 results in no match, regardless of matchCap headroom', async () => {
    const tx = makeTx('0');
    const multiplier = baseMultiplier({
      multiplier: 2 as any,
      perDonationCap: 0 as any,
      matchCap: 10_000 as any,
    });

    const result = await MatchedFundAllocationService.allocate(tx as any, {
      donationId: 'd-ac2',
      campaignId: 'camp1',
      donorAmount: 200,
      multiplier,
    });

    // computeDesiredMatch returns 0 when perDonationCap=0 → skip DB round-trip
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe('MatchedFundAllocationService – single oversized donation capped to min(perDonationCap, remaining) (AC-3b)', () => {
  const makeTx = (appliedFromQuery: string) => ({
    $queryRaw: jest.fn().mockResolvedValue([{ applied: appliedFromQuery }]),
    matchedFund: {
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'mf-ac2', ...data })),
    },
  });

  it('caps an oversized donation at perDonationCap when remaining matchCap > perDonationCap', async () => {
    // donorAmount=1000, multiplier=5 → raw = 4000
    // perDonationCap=50 → desired = 50
    // remaining matchCap = 500 > 50 → DB grants 50 in full
    const tx = makeTx('50');
    const multiplier = baseMultiplier({
      multiplier: 5 as any,
      perDonationCap: 50 as any,
      matchCap: 10_000 as any,
    });

    const result = await MatchedFundAllocationService.allocate(tx as any, {
      donationId: 'd-ac3',
      campaignId: 'camp1',
      donorAmount: 1000,
      multiplier,
    });

    expect(result?.matchedAmount.toString()).toBe('50');
    expect(result?.totalAmount.toString()).toBe('1050');
  });

  it('caps an oversized donation at remaining matchCap when remaining < perDonationCap', async () => {
    // donorAmount=1000, multiplier=5 → raw = 4000
    // perDonationCap=200 → desired = 200
    // DB reports only 30 remaining of matchCap → grants 30
    const tx = makeTx('30');
    const multiplier = baseMultiplier({
      multiplier: 5 as any,
      perDonationCap: 200 as any,
      matchCap: 10_000 as any,
    });

    const result = await MatchedFundAllocationService.allocate(tx as any, {
      donationId: 'd-ac4',
      campaignId: 'camp1',
      donorAmount: 1000,
      multiplier,
    });

    // min(perDonationCap=200, remaining=30) = 30
    expect(result?.matchedAmount.toString()).toBe('30');
    expect(result?.totalAmount.toString()).toBe('1030');
  });

  it('returns null when both perDonationCap and matchCap are exhausted', async () => {
    const tx = makeTx('0');
    const multiplier = baseMultiplier({
      multiplier: 2 as any,
      perDonationCap: 100 as any,
      matchCap: 1000 as any,
    });

    const result = await MatchedFundAllocationService.allocate(tx as any, {
      donationId: 'd-ac5',
      campaignId: 'camp1',
      donorAmount: 500,
      multiplier,
    });

    // DB reports 0 remaining → no row created
    expect(result).toBeNull();
    expect(tx.matchedFund.create).not.toHaveBeenCalled();
  });

  it('correctly computes min(perDonationCap, remaining) with non-round Decimal amounts', async () => {
    // This verifies no IEEE-754 drift when cap values are non-round decimals.
    // donorAmount = 100, multiplier = 2 → raw = 100
    // perDonationCap = 33.33333333 → desired = 33.33333333
    // remaining matchCap > perDonationCap → DB grants exactly 33.33333333
    const tx = makeTx('33.33333333');
    const multiplier = baseMultiplier({
      multiplier: 2 as any,
      perDonationCap: new Prisma.Decimal('33.33333333') as any,
      matchCap: new Prisma.Decimal('333.33333333') as any,
    });

    const result = await MatchedFundAllocationService.allocate(tx as any, {
      donationId: 'd-ac6',
      campaignId: 'camp1',
      donorAmount: new Prisma.Decimal(100),
      multiplier,
    });

    expect(result?.matchedAmount.toString()).toBe('33.33333333');
    expect(result?.totalAmount.toString()).toBe('133.33333333');
  });
});
