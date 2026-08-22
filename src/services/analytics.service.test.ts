import { AnalyticsService } from './analytics.service';
import prisma from '../config/database';
import { Prisma } from '@prisma/client';

// Mock Prisma
jest.mock('../config/database');

// ---------------------------------------------------------------------------
// Redis mock — must include pfadd and pfcount for the HLL-based uniqueDonors
// feature (Bug 3) and hincrby (integer-scaled totalRaised, Bug 2).
//
// jest.mock() factory runs before variable declarations so the mock object
// must be defined inside the factory.  We then hold a reference to it via the
// module exports so individual tests can call mockResolvedValueOnce() etc.
// ---------------------------------------------------------------------------
jest.mock('../config/redis', () => {
  const mock = {
    hgetall: jest.fn().mockResolvedValue({}),
    hset: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    hincrby: jest.fn().mockResolvedValue(0),
    // hincrbyfloat is no longer used in production code; kept here so any
    // accidental regression (calling it instead of hincrby) is immediately
    // detectable as "unexpected call".
    hincrbyfloat: jest.fn().mockResolvedValue(0),
    exists: jest.fn().mockResolvedValue(0),
    del: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
    // HyperLogLog commands
    pfadd: jest.fn().mockResolvedValue(1),
    pfcount: jest.fn().mockResolvedValue(0),
  };
  return { __esModule: true, default: mock };
});

// Grab a live reference to the mock so tests can call mockResolvedValueOnce()
import redisMockModule from '../config/redis';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const redisMock = redisMockModule as any;

describe('AnalyticsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── getCampaignAnalytics ────────────────────────────────────────────────

  describe('getCampaignAnalytics', () => {
    it('should return campaign analytics', async () => {
      const mockCampaign = {
        id: '1',
        title: 'Test Campaign',
        targetAmount: 1000,
        currentAmount: 500,
        status: 'ACTIVE',
        _count: {
          donations: 10,
          beneficiaries: 5,
          distributions: 3,
        },
        donations: [
          { amount: 100, createdAt: new Date() },
          { amount: 50, createdAt: new Date() },
        ],
        distributions: [
          { amount: 25, status: 'COMPLETED', createdAt: new Date() },
        ],
      };

      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(mockCampaign);

      const result = await AnalyticsService.getCampaignAnalytics('1');

      expect(result).toHaveProperty('campaign');
      expect(result).toHaveProperty('donations');
      expect(result).toHaveProperty('distributions');
      expect(result).toHaveProperty('beneficiaries');
    });

    it('should throw error if campaign not found', async () => {
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(AnalyticsService.getCampaignAnalytics('1')).rejects.toThrow('Campaign not found');
    });
  });

  // ─── getDonorAnalytics ───────────────────────────────────────────────────

  describe('getDonorAnalytics', () => {
    it('should return donor analytics', async () => {
      const mockDonations = [
        { amount: 100, campaignId: '1', campaign: { id: '1', title: 'Campaign 1' } },
        { amount: 50, campaignId: '2', campaign: { id: '2', title: 'Campaign 2' } },
      ];

      (prisma.donation.findMany as jest.Mock).mockResolvedValue(mockDonations);
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      const result = await AnalyticsService.getDonorAnalytics('user1');

      expect(result).toHaveProperty('totalDonated');
      expect(result).toHaveProperty('totalDonations');
      expect(result).toHaveProperty('campaignsSupported');
    });
  });

  // ─── exportReport ────────────────────────────────────────────────────────

  describe('exportReport', () => {
    it('exports a campaign report as CSV with the expected columns and row', async () => {
      const mockCampaign = {
        id: '1',
        title: 'Test Campaign',
        targetAmount: 1000,
        currentAmount: 500,
        status: 'ACTIVE',
        _count: { donations: 10, beneficiaries: 5, distributions: 3 },
        donations: [
          { amount: 100, createdAt: new Date() },
          { amount: 50, createdAt: new Date() },
        ],
        distributions: [{ amount: 25, status: 'COMPLETED', createdAt: new Date() }],
      };

      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(mockCampaign);

      const result = await AnalyticsService.exportReport('campaign', { campaignId: '1' }, 'csv');

      expect(result.contentType).toBe('text/csv');
      expect(result.filename).toMatch(/^campaign-analytics-.*\.csv$/);

      const [header, row] = result.content.split('\r\n');
      expect(header).toBe(
        'campaignId,title,status,targetAmount,currentAmount,progressPercentage,totalDonations,totalRaised,avgDonation,totalDistributions,totalDistributed,beneficiariesTotal'
      );
      expect(row).toContain('1,Test Campaign,ACTIVE,1000,500');
    });

    it('exports a donor report as CSV with one row per donation', async () => {
      const mockDonations = [
        {
          id: 'd1',
          amount: 100,
          campaignId: '1',
          campaign: { id: '1', title: 'Campaign 1' },
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          isAnonymous: false,
        },
        {
          id: 'd2',
          amount: 50,
          campaignId: '2',
          campaign: { id: '2', title: 'Campaign 2' },
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
          isAnonymous: false,
        },
      ];

      (prisma.donation.findMany as jest.Mock).mockResolvedValue(mockDonations);
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      const result = await AnalyticsService.exportReport('donor', { userId: 'user1' }, 'csv');

      const lines = result.content.split('\r\n');
      expect(lines[0]).toBe('donationId,campaignId,campaignTitle,amount,createdAt');
      expect(lines).toHaveLength(3); // header + 2 donations
      expect(lines[1]).toContain('d1,1,Campaign 1,100');
    });

    it('exports an organization report as CSV', async () => {
      const mockCampaigns = [
        {
          id: '1',
          status: 'ACTIVE',
          _count: { donations: 2, beneficiaries: 1, distributions: 1 },
          donations: [{ amount: 100 }, { amount: 50 }],
        },
      ];
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue(mockCampaigns);

      const result = await AnalyticsService.exportReport(
        'organization',
        { organizationId: 'org1' },
        'csv'
      );

      const [header, row] = result.content.split('\r\n');
      expect(header).toBe(
        'totalCampaigns,activeCampaigns,completedCampaigns,totalRaised,avgPerCampaign,totalBeneficiaries,totalDistributions'
      );
      expect(row).toBe('1,1,0,150,150,1,1');
    });

    it('exports a platform report as JSON when format=json', async () => {
      (prisma.user.count as jest.Mock).mockResolvedValue(100);
      (prisma.campaign.count as jest.Mock).mockResolvedValue(20);
      (prisma.donation.count as jest.Mock).mockResolvedValue(500);
      (prisma.distribution.count as jest.Mock).mockResolvedValue(300);
      (prisma.beneficiary.count as jest.Mock).mockResolvedValue(50);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.donation.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: 10000 } });
      (prisma.distribution.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: 4000 } });

      const result = await AnalyticsService.exportReport('platform', {}, 'json');

      expect(result.contentType).toBe('application/json');
      expect(result.filename).toMatch(/^platform-analytics-.*\.json$/);
      const parsed = JSON.parse(result.content);
      expect(parsed.overview.totalUsers).toBe(100);
      expect(parsed.financials.totalRaised).toBe(10000);
    });

    it('rejects an unsupported report type with a 400 AppError', async () => {
      await expect(AnalyticsService.exportReport('invalid', {}, 'csv')).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it('rejects a campaign export missing campaignId with a 400 AppError', async () => {
      await expect(
        AnalyticsService.exportReport('campaign', {}, 'csv')
      ).rejects.toMatchObject({ statusCode: 400, message: 'Campaign ID is required for campaign report' });
    });
  });

  // ─── getPlatformAnalytics ────────────────────────────────────────────────

  describe('getPlatformAnalytics', () => {
    it('should return platform analytics', async () => {
      (prisma.user.count as jest.Mock).mockResolvedValue(100);
      (prisma.campaign.count as jest.Mock).mockResolvedValue(20);
      (prisma.donation.count as jest.Mock).mockResolvedValue(500);
      (prisma.distribution.count as jest.Mock).mockResolvedValue(300);
      (prisma.beneficiary.count as jest.Mock).mockResolvedValue(50);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.donation.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: 10000 } });

      const result = await AnalyticsService.getPlatformAnalytics();

      expect(result).toHaveProperty('overview');
      expect(result).toHaveProperty('financials');
      expect(result).toHaveProperty('recent');
    });
  });

  // ─── incrementDonationStats — Bug 2 (integer scaling) ───────────────────

  describe('incrementDonationStats', () => {
    it('uses HINCRBY (not HINCRBYFLOAT) with integer-scaled amount', async () => {
      redisMock.exists.mockResolvedValueOnce(1);

      // 1.50000001 × 10^8 = 150000001 — exercises all 8 decimal places
      await AnalyticsService.incrementDonationStats('camp1', new Prisma.Decimal('1.50000001'), 'user1');

      // Must NOT call hincrbyfloat
      expect(redisMock.hincrbyfloat).not.toHaveBeenCalled();

      // Must call hincrby with the integer-scaled amount
      expect(redisMock.hincrby).toHaveBeenCalledWith(
        'campaign:stats:camp1',
        'totalRaised',
        150000001,
      );
      expect(redisMock.hincrby).toHaveBeenCalledWith(
        'campaign:stats:camp1',
        'totalDonations',
        1,
      );
    });

    it('calls PFADD on the HLL key when userId is provided', async () => {
      redisMock.exists.mockResolvedValueOnce(1);

      await AnalyticsService.incrementDonationStats('camp1', new Prisma.Decimal('10'), 'user42');

      expect(redisMock.pfadd).toHaveBeenCalledWith('campaign:donors:hll:camp1', 'user42');
    });

    it('does not call PFADD when userId is null', async () => {
      redisMock.exists.mockResolvedValueOnce(1);

      await AnalyticsService.incrementDonationStats('camp1', new Prisma.Decimal('10'), null);

      expect(redisMock.pfadd).not.toHaveBeenCalled();
    });

    it('skips HINCRBY when the stats key does not exist', async () => {
      redisMock.exists.mockResolvedValueOnce(0);

      await AnalyticsService.incrementDonationStats('camp1', new Prisma.Decimal('10'), 'user1');

      expect(redisMock.hincrby).not.toHaveBeenCalledWith(
        expect.anything(),
        'totalRaised',
        expect.anything(),
      );
    });
  });

  // ─── decrementDonationStats — Bug 1 (refund path) ───────────────────────

  describe('decrementDonationStats', () => {
    it('uses negative HINCRBY with integer-scaled amount on refund', async () => {
      redisMock.exists.mockResolvedValueOnce(1);

      await AnalyticsService.decrementDonationStats('camp1', new Prisma.Decimal('1.50000001'), 'user1');

      expect(redisMock.hincrby).toHaveBeenCalledWith(
        'campaign:stats:camp1',
        'totalRaised',
        -150000001,
      );
      expect(redisMock.hincrby).toHaveBeenCalledWith(
        'campaign:stats:camp1',
        'totalDonations',
        -1,
      );
    });

    it('skips decrement when the stats key does not exist', async () => {
      redisMock.exists.mockResolvedValueOnce(0);

      await AnalyticsService.decrementDonationStats('camp1', new Prisma.Decimal('10'), 'user1');

      expect(redisMock.hincrby).not.toHaveBeenCalled();
    });

    it('does NOT call PFADD or PFDEL (no PFDEL in Redis)', async () => {
      redisMock.exists.mockResolvedValueOnce(1);

      await AnalyticsService.decrementDonationStats('camp1', new Prisma.Decimal('5'), 'user1');

      expect(redisMock.pfadd).not.toHaveBeenCalled();
      // Redis has no pfDel — verify we don't attempt anything HLL-related on decrement
      expect(redisMock.del).not.toHaveBeenCalledWith('campaign:donors:hll:camp1');
    });
  });

  // ─── confirm → refund → re-confirm scenario — Bug 1 ────────────────────

  describe('confirm → refund → re-confirm (no key deletion race)', () => {
    /**
     * Simulates the acceptance-criteria sequence using only the mocks.
     *
     * 1. increment for a donation (key exists)
     * 2. decrement for a refund  (key still exists — not deleted)
     * 3. increment for another donation (key still exists — no race window)
     */
    it('totalRaised net is correct after confirm → refund → confirm', async () => {
      // All three operations see an existing key
      redisMock.exists.mockResolvedValue(1);

      const callLog: Array<{ field: string; delta: number }> = [];
      redisMock.hincrby.mockImplementation((_key: string, field: string, delta: number) => {
        callLog.push({ field, delta });
        return Promise.resolve(delta);
      });

      const amount1 = new Prisma.Decimal('10.00000000'); // 1_000_000_000 scaled
      const amount2 = new Prisma.Decimal('5.00000000');  //   500_000_000 scaled

      await AnalyticsService.incrementDonationStats('camp1', amount1, 'user1');
      await AnalyticsService.decrementDonationStats('camp1', amount1, 'user1'); // full refund
      await AnalyticsService.incrementDonationStats('camp1', amount2, 'user2');

      // Net totalRaised increments (scaled integers)
      const netRaised = callLog
        .filter((c) => c.field === 'totalRaised')
        .reduce((sum, c) => sum + c.delta, 0);

      const expectedNet = 500_000_000; // 5 × 10^8
      expect(netRaised).toBe(expectedNet);
    });
  });

  // ─── getCachedCampaignStats — Bug 3 (HLL uniqueDonors) ──────────────────

  describe('getCachedCampaignStats', () => {
    it('overlays uniqueDonors from PFCOUNT when cache hit', async () => {
      redisMock.hgetall.mockResolvedValueOnce({
        campaignId: 'camp1',
        totalDonations: '5',
        totalRaised: '500000000',
        uniqueDonors: '3', // stale value from stats hash
      });
      redisMock.pfcount.mockResolvedValueOnce(7); // live HLL count

      const stats = await AnalyticsService.getCachedCampaignStats('camp1');

      expect(stats.uniqueDonors).toBe('7');
    });

    it('falls back to hash uniqueDonors when PFCOUNT throws', async () => {
      redisMock.hgetall.mockResolvedValueOnce({
        campaignId: 'camp1',
        totalDonations: '5',
        totalRaised: '500000000',
        uniqueDonors: '3',
      });
      redisMock.pfcount.mockRejectedValueOnce(new Error('Redis unavailable'));

      const stats = await AnalyticsService.getCachedCampaignStats('camp1');

      // Falls back to the value already in the hash
      expect(stats.uniqueDonors).toBe('3');
    });

    it('rebuilds from DB on cache miss and seeds HLL', async () => {
      // First hgetall returns empty (cache miss); subsequent ones return built stats
      redisMock.hgetall.mockResolvedValueOnce({});
      redisMock.pfcount.mockResolvedValueOnce(2);

      const mockCampaign = {
        id: 'camp1',
        title: 'Test',
        targetAmount: '1000',
        currentAmount: '200',
        status: 'ACTIVE',
      };
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(mockCampaign);
      (prisma.donation.aggregate as jest.Mock).mockResolvedValue({
        _count: 2,
        _sum: { amount: new Prisma.Decimal('20.00000000') },
      });
      (prisma.distribution.aggregate as jest.Mock).mockResolvedValue({
        _count: 0,
        _sum: { amount: null },
      });
      (prisma.donation.groupBy as jest.Mock).mockResolvedValue([
        { userId: 'u1' },
        { userId: 'u2' },
      ]);
      (prisma.beneficiaryAssignment.count as jest.Mock).mockResolvedValue(1);

      const stats = await AnalyticsService.getCachedCampaignStats('camp1');

      // HLL should have been seeded with both user IDs
      expect(redisMock.pfadd).toHaveBeenCalledWith(
        'campaign:donors:hll:camp1',
        'u1',
        'u2',
      );
      // uniqueDonors from PFCOUNT should override DB count
      expect(stats.uniqueDonors).toBe('2');
    });
  });

  // ─── buildCampaignStats — integer-scaled totalRaised ────────────────────

  describe('buildCampaignStats', () => {
    it('stores totalRaised as integer-scaled value (× 10^8)', async () => {
      const mockCampaign = {
        id: 'camp1',
        title: 'Test',
        targetAmount: '1000',
        currentAmount: '200',
        status: 'ACTIVE',
      };
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(mockCampaign);
      (prisma.donation.aggregate as jest.Mock).mockResolvedValue({
        _count: 1,
        _sum: { amount: new Prisma.Decimal('12.34567890') },
      });
      (prisma.distribution.aggregate as jest.Mock).mockResolvedValue({
        _count: 0,
        _sum: { amount: null },
      });
      (prisma.donation.groupBy as jest.Mock).mockResolvedValue([]);
      (prisma.beneficiaryAssignment.count as jest.Mock).mockResolvedValue(0);

      const stats = await AnalyticsService.buildCampaignStats('camp1');

      // 12.34567890 × 10^8 = 1234567890
      expect(stats.totalRaised).toBe('1234567890');
    });
  });
});

// ─── runHourlyRollup — idempotency (existing test kept intact) ──────────────

describe('runHourlyRollup', () => {
  it('produces identical upsert payloads when run twice for the same hour (idempotency)', async () => {
    const fixedHour = new Date('2026-07-28T14:00:00.000Z');

    (prisma.donation.findMany as jest.Mock).mockResolvedValue([{ campaignId: 'camp1' }]);
    (prisma.distribution.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.donation.aggregate as jest.Mock).mockResolvedValue({ _count: 3, _sum: { amount: 150 } });
    (prisma.distribution.aggregate as jest.Mock).mockResolvedValue({ _count: 1, _sum: { amount: 50 } });
    (prisma.donation.groupBy as jest.Mock).mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    (prisma.beneficiaryAssignment.count as jest.Mock).mockResolvedValue(0);
    (prisma.campaignHourlyStat.upsert as jest.Mock).mockResolvedValue({});
    (prisma.rollupTracker.upsert as jest.Mock).mockResolvedValue({});
    (prisma.campaign.findUnique as jest.Mock).mockResolvedValue({
      id: 'camp1', title: 'T', targetAmount: 1000, currentAmount: 100, status: 'ACTIVE',
    });

    await AnalyticsService.runHourlyRollup(fixedHour);
    const firstCallArgs = (prisma.campaignHourlyStat.upsert as jest.Mock).mock.calls[0][0];

    await AnalyticsService.runHourlyRollup(fixedHour);
    const secondCallArgs = (prisma.campaignHourlyStat.upsert as jest.Mock).mock.calls[1][0];

    expect(firstCallArgs.update).toEqual(secondCallArgs.update);
    expect(firstCallArgs.where).toEqual(secondCallArgs.where);
  });
});
