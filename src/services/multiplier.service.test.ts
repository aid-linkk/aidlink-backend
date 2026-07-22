import { MultiplierService } from './multiplier.service';
import { MultiplierType } from '@prisma/client';

jest.mock('../config/database');

type M = Parameters<typeof MultiplierService.selectWinningMultiplier>[0][number];

const baseMultiplier = (overrides: Partial<M>): M =>
  ({
    id: 'm1',
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
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }) as M;

describe('MultiplierService.selectWinningMultiplier', () => {
  const donationTime = new Date('2026-06-01T00:00:00Z');

  it('returns null when there are no candidates', () => {
    expect(MultiplierService.selectWinningMultiplier([], { donationTime })).toBeNull();
  });

  it('excludes inactive multipliers', () => {
    const m = baseMultiplier({ active: false });
    expect(MultiplierService.selectWinningMultiplier([m], { donationTime })).toBeNull();
  });

  it('excludes multipliers outside their startAt/endAt window', () => {
    const before = baseMultiplier({ id: 'before', startAt: new Date('2026-07-01') });
    const after = baseMultiplier({ id: 'after', endAt: new Date('2026-05-01') });
    expect(MultiplierService.selectWinningMultiplier([before, after], { donationTime })).toBeNull();
  });

  it('includes a multiplier whose window contains the donation time', () => {
    const m = baseMultiplier({
      id: 'in-window',
      startAt: new Date('2026-01-01'),
      endAt: new Date('2026-12-31'),
    });
    expect(MultiplierService.selectWinningMultiplier([m], { donationTime })?.id).toBe('in-window');
  });

  it('excludes a MILESTONE multiplier when no milestoneId is supplied', () => {
    const m = baseMultiplier({ type: MultiplierType.MILESTONE, milestoneId: 'ms1' });
    expect(MultiplierService.selectWinningMultiplier([m], { donationTime })).toBeNull();
  });

  it('excludes a MILESTONE multiplier whose milestoneId does not match', () => {
    const m = baseMultiplier({ type: MultiplierType.MILESTONE, milestoneId: 'ms1' });
    expect(
      MultiplierService.selectWinningMultiplier([m], { donationTime, milestoneId: 'ms2' }),
    ).toBeNull();
  });

  it('includes a MILESTONE multiplier whose milestoneId matches', () => {
    const m = baseMultiplier({ id: 'ms-match', type: MultiplierType.MILESTONE, milestoneId: 'ms1' });
    expect(
      MultiplierService.selectWinningMultiplier([m], { donationTime, milestoneId: 'ms1' })?.id,
    ).toBe('ms-match');
  });

  it('prefers MILESTONE over CORPORATE over CAMPAIGN_WIDE regardless of multiplier value', () => {
    const milestone = baseMultiplier({
      id: 'milestone',
      type: MultiplierType.MILESTONE,
      milestoneId: 'ms1',
      multiplier: 1.5 as any,
    });
    const corporate = baseMultiplier({ id: 'corporate', type: MultiplierType.CORPORATE, multiplier: 3 as any });
    const campaignWide = baseMultiplier({
      id: 'campaign-wide',
      type: MultiplierType.CAMPAIGN_WIDE,
      multiplier: 5 as any,
    });

    const winner = MultiplierService.selectWinningMultiplier([corporate, campaignWide, milestone], {
      donationTime,
      milestoneId: 'ms1',
    });

    expect(winner?.id).toBe('milestone');
  });

  it('picks CORPORATE over CAMPAIGN_WIDE when no milestone applies', () => {
    const corporate = baseMultiplier({ id: 'corporate', type: MultiplierType.CORPORATE, multiplier: 1.5 as any });
    const campaignWide = baseMultiplier({
      id: 'campaign-wide',
      type: MultiplierType.CAMPAIGN_WIDE,
      multiplier: 10 as any,
    });

    const winner = MultiplierService.selectWinningMultiplier([campaignWide, corporate], { donationTime });
    expect(winner?.id).toBe('corporate');
  });

  it('within the same precedence tier, the highest multiplier value wins', () => {
    const low = baseMultiplier({ id: 'low', multiplier: 1.5 as any });
    const high = baseMultiplier({ id: 'high', multiplier: 3 as any });

    const winner = MultiplierService.selectWinningMultiplier([low, high], { donationTime });
    expect(winner?.id).toBe('high');
  });

  it('breaks a multiplier-value tie by earliest createdAt', () => {
    const later = baseMultiplier({
      id: 'later',
      multiplier: 2 as any,
      createdAt: new Date('2026-02-01'),
    });
    const earlier = baseMultiplier({
      id: 'earlier',
      multiplier: 2 as any,
      createdAt: new Date('2026-01-01'),
    });

    const winner = MultiplierService.selectWinningMultiplier([later, earlier], { donationTime });
    expect(winner?.id).toBe('earlier');
  });

  it('breaks a full tie (same multiplier and createdAt) by id for full determinism', () => {
    const sameTime = new Date('2026-01-01');
    const b = baseMultiplier({ id: 'b-multiplier', multiplier: 2 as any, createdAt: sameTime });
    const a = baseMultiplier({ id: 'a-multiplier', multiplier: 2 as any, createdAt: sameTime });

    const winner = MultiplierService.selectWinningMultiplier([b, a], { donationTime });
    expect(winner?.id).toBe('a-multiplier');
  });

  it('is order-independent: shuffled input yields the same winner', () => {
    const milestone = baseMultiplier({
      id: 'milestone',
      type: MultiplierType.MILESTONE,
      milestoneId: 'ms1',
      multiplier: 1.2 as any,
    });
    const corporate = baseMultiplier({ id: 'corporate', type: MultiplierType.CORPORATE, multiplier: 5 as any });
    const campaignWide = baseMultiplier({ id: 'campaign-wide', multiplier: 5 as any });

    const forward = MultiplierService.selectWinningMultiplier([milestone, corporate, campaignWide], {
      donationTime,
      milestoneId: 'ms1',
    });
    const reversed = MultiplierService.selectWinningMultiplier([campaignWide, corporate, milestone], {
      donationTime,
      milestoneId: 'ms1',
    });

    expect(forward?.id).toBe('milestone');
    expect(reversed?.id).toBe('milestone');
  });
});
