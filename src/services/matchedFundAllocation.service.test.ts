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
