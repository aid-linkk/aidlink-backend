/// <reference types="jest" />

import { SearchService } from './search.service';
import prisma from '../config/database';

// Mock Prisma
jest.mock('../config/database');

// Mock the cache layer so tests don't depend on a real Redis connection —
// getOrSet always misses and just runs the factory.
jest.mock('../utils/cache', () => ({
  getOrSet: jest.fn((_key: string, _ttl: number, factory: () => Promise<unknown>) => factory()),
  buildKey: jest.fn((namespace: string, key: string) => `${namespace}:${key}`),
}));

// Mirrors the private encodeCursor() in search.service.ts (v2 cursor format:
// { v: 2, score, id }). Kept in sync manually since the encoder isn't exported.
function buildCursor(score: number, id: string, overrides: Record<string, unknown> = {}): string {
  return Buffer.from(JSON.stringify({ v: 2, score, id, ...overrides })).toString('base64');
}

// A pre-fix (v1, unversioned) cursor, as an old client might still be holding.
function buildLegacyCursor(score: number, id: string): string {
  return Buffer.from(JSON.stringify({ score, id })).toString('base64');
}

describe('SearchService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('searchCampaigns', () => {
    it('should return search results for campaigns', async () => {
      const mockCampaigns = [
        {
          id: '1',
          title: 'Test Campaign',
          status: 'ACTIVE',
          organization: { name: 'Test Org' },
          _count: { donations: 10, beneficiaries: 5, distributions: 3 },
        },
      ];

      (prisma.campaign.findMany as jest.Mock).mockResolvedValue(mockCampaigns);
      (prisma.campaign.count as jest.Mock).mockResolvedValue(1);

      const result = await SearchService.searchCampaigns({
        query: 'test',
        page: 1,
        limit: 20,
      });

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('pagination');
      expect(result.data).toHaveLength(1);
    });
  });

  describe('searchDonations', () => {
    it('should return search results for donations', async () => {
      const mockDonations = [
        {
          id: '1',
          amount: 100,
          status: 'CONFIRMED',
          campaign: { id: '1', title: 'Test Campaign' },
        },
      ];

      (prisma.donation.findMany as jest.Mock).mockResolvedValue(mockDonations);
      (prisma.donation.count as jest.Mock).mockResolvedValue(1);

      const result = await SearchService.searchDonations({
        query: 'test',
        page: 1,
        limit: 20,
      });

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('pagination');
    });
  });

  describe('relevance sorting', () => {
    interface RawSqlCall {
      text: string;
      values: unknown[];
    }

    function extractLimitOffset(call: RawSqlCall): { limit: unknown; offset: unknown } {
      const match = call.text.match(/LIMIT \$(\d+) OFFSET \$(\d+)/);
      if (!match) throw new Error(`LIMIT/OFFSET not found in: ${call.text}`);
      const [, limitIdx, offsetIdx] = match;
      return {
        limit: call.values[Number(limitIdx) - 1],
        offset: call.values[Number(offsetIdx) - 1],
      };
    }

    describe('searchCampaigns', () => {
      it('uses the $queryRaw scoring path when sortBy is relevance, not the default orderBy path', async () => {
        (prisma.$queryRaw as jest.Mock)
          .mockResolvedValueOnce([{ id: 'camp-1', score: 50 }])
          .mockResolvedValueOnce([{ count: 1 }]);
        (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
          {
            id: 'camp-1',
            title: 'Flood Relief',
            organization: { name: 'Org' },
            _count: { donations: 0, beneficiaries: 0 },
          },
        ]);

        await SearchService.searchCampaigns({ query: 'flood', sortBy: 'relevance', page: 1, limit: 20 });

        expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
        expect(prisma.campaign.count).not.toHaveBeenCalled();

        const findManyArgs = (prisma.campaign.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyArgs.where).toEqual({ id: { in: ['camp-1'] } });
        expect(findManyArgs.orderBy).toBeUndefined();
        expect(findManyArgs.skip).toBeUndefined();
        expect(findManyArgs.take).toBeUndefined();
      });

      it('orders results by score desc with id as tiebreaker, even if findMany returns a different order', async () => {
        (prisma.$queryRaw as jest.Mock)
          .mockResolvedValueOnce([
            { id: 'c', score: 90 },
            { id: 'a', score: 50 },
            { id: 'b', score: 50 },
          ])
          .mockResolvedValueOnce([{ count: 3 }]);

        // findMany intentionally returns a different order than the ranked ids,
        // since `WHERE id IN (...)` does not guarantee row order.
        (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
          { id: 'b', title: 'B', organization: { name: 'Org' }, _count: { donations: 0, beneficiaries: 0 } },
          { id: 'a', title: 'A', organization: { name: 'Org' }, _count: { donations: 0, beneficiaries: 0 } },
          { id: 'c', title: 'C', organization: { name: 'Org' }, _count: { donations: 0, beneficiaries: 0 } },
        ]);

        const result = await SearchService.searchCampaigns({
          query: 'flood',
          sortBy: 'relevance',
          page: 1,
          limit: 20,
        });

        expect(result.data.map((c: any) => c.id)).toEqual(['c', 'a', 'b']);

        const rankedCall = (prisma.$queryRaw as jest.Mock).mock.calls[0][0] as RawSqlCall;
        expect(rankedCall.text).toMatch(/ORDER BY score DESC, id ASC/);
      });

      it('respects limit/offset pagination in the relevance path', async () => {
        (prisma.$queryRaw as jest.Mock)
          .mockResolvedValueOnce([{ id: 'camp-1', score: 50 }])
          .mockResolvedValueOnce([{ count: 42 }]);
        (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
          {
            id: 'camp-1',
            title: 'Flood Relief',
            organization: { name: 'Org' },
            _count: { donations: 0, beneficiaries: 0 },
          },
        ]);

        const result = await SearchService.searchCampaigns({
          query: 'flood',
          sortBy: 'relevance',
          page: 3,
          limit: 15,
        });

        const rankedCall = (prisma.$queryRaw as jest.Mock).mock.calls[0][0] as RawSqlCall;
        const { limit, offset } = extractLimitOffset(rankedCall);
        expect(limit).toBe(15);
        expect(offset).toBe(30); // (page - 1) * limit

        expect(result.pagination).toEqual({ page: 3, limit: 15, total: 42, totalPages: 3 });
      });

      it('falls back to the original orderBy path for non-relevance sorts', async () => {
        (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
          {
            id: 'camp-1',
            title: 'Flood Relief',
            organization: { name: 'Org' },
            _count: { donations: 0, beneficiaries: 0 },
          },
        ]);
        (prisma.campaign.count as jest.Mock).mockResolvedValue(1);

        await SearchService.searchCampaigns({
          query: 'flood',
          sortBy: 'createdAt',
          sortOrder: 'desc',
          page: 1,
          limit: 20,
        });

        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        const findManyArgs = (prisma.campaign.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyArgs.orderBy).toEqual({ createdAt: 'desc' });
        expect(findManyArgs.skip).toBe(0);
        expect(findManyArgs.take).toBe(20);
      });
    });

    describe('searchDonations', () => {
      it('uses the $queryRaw scoring path when sortBy is relevance, not the default orderBy path', async () => {
        (prisma.$queryRaw as jest.Mock)
          .mockResolvedValueOnce([{ id: 'don-1', score: 50 }])
          .mockResolvedValueOnce([{ count: 1 }]);
        (prisma.donation.findMany as jest.Mock).mockResolvedValue([
          { id: 'don-1', amount: 100, campaign: { id: 'c1', title: 'Flood Relief' } },
        ]);

        await SearchService.searchDonations({ query: 'thanks', sortBy: 'relevance', page: 1, limit: 20 });

        expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
        expect(prisma.donation.count).not.toHaveBeenCalled();

        const findManyArgs = (prisma.donation.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyArgs.where).toEqual({ id: { in: ['don-1'] } });
        expect(findManyArgs.orderBy).toBeUndefined();
        expect(findManyArgs.skip).toBeUndefined();
        expect(findManyArgs.take).toBeUndefined();
      });

      it('orders results by score desc with id as tiebreaker, even if findMany returns a different order', async () => {
        (prisma.$queryRaw as jest.Mock)
          .mockResolvedValueOnce([
            { id: 'z', score: 80 },
            { id: 'x', score: 40 },
            { id: 'y', score: 40 },
          ])
          .mockResolvedValueOnce([{ count: 3 }]);

        (prisma.donation.findMany as jest.Mock).mockResolvedValue([
          { id: 'y', amount: 10, campaign: { id: 'c1', title: 'C' } },
          { id: 'x', amount: 20, campaign: { id: 'c1', title: 'C' } },
          { id: 'z', amount: 30, campaign: { id: 'c1', title: 'C' } },
        ]);

        const result = await SearchService.searchDonations({
          query: 'thanks',
          sortBy: 'relevance',
          page: 1,
          limit: 20,
        });

        expect(result.data.map((d: any) => d.id)).toEqual(['z', 'x', 'y']);

        const rankedCall = (prisma.$queryRaw as jest.Mock).mock.calls[0][0] as RawSqlCall;
        expect(rankedCall.text).toMatch(/ORDER BY score DESC, id ASC/);
      });

      it('respects limit/offset pagination in the relevance path', async () => {
        (prisma.$queryRaw as jest.Mock)
          .mockResolvedValueOnce([{ id: 'don-1', score: 50 }])
          .mockResolvedValueOnce([{ count: 17 }]);
        (prisma.donation.findMany as jest.Mock).mockResolvedValue([
          { id: 'don-1', amount: 100, campaign: { id: 'c1', title: 'Flood Relief' } },
        ]);

        const result = await SearchService.searchDonations({
          query: 'thanks',
          sortBy: 'relevance',
          page: 2,
          limit: 5,
        });

        const rankedCall = (prisma.$queryRaw as jest.Mock).mock.calls[0][0] as RawSqlCall;
        const { limit, offset } = extractLimitOffset(rankedCall);
        expect(limit).toBe(5);
        expect(offset).toBe(5); // (page - 1) * limit

        expect(result.pagination).toEqual({ page: 2, limit: 5, total: 17, totalPages: 4 });
      });

      it('falls back to the original orderBy path for non-relevance sorts', async () => {
        (prisma.donation.findMany as jest.Mock).mockResolvedValue([
          { id: 'don-1', amount: 100, campaign: { id: 'c1', title: 'Flood Relief' } },
        ]);
        (prisma.donation.count as jest.Mock).mockResolvedValue(1);

        await SearchService.searchDonations({
          query: 'thanks',
          sortBy: 'createdAt',
          sortOrder: 'desc',
          page: 1,
          limit: 20,
        });

        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        const findManyArgs = (prisma.donation.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyArgs.orderBy).toEqual({ createdAt: 'desc' });
        expect(findManyArgs.skip).toBe(0);
        expect(findManyArgs.take).toBe(20);
      });
    });
  });

  describe('searchBeneficiaries', () => {
    const mockBeneficiaries = [
      {
        id: '1',
        firstName: 'John',
        lastName: 'Doe',
        status: 'VERIFIED',
        user: { id: '1', email: 'test@example.com' },
        _count: { distributions: 2 },
      },
    ];

    beforeEach(() => {
      (prisma.beneficiary.findMany as jest.Mock).mockResolvedValue(mockBeneficiaries);
      (prisma.beneficiary.count as jest.Mock).mockResolvedValue(1);
      (prisma.beneficiary.groupBy as jest.Mock).mockResolvedValue([]);
    });

    it('should return data, pagination, and facets', async () => {
      const result = await SearchService.searchBeneficiaries({
        query: 'John',
        page: 1,
        limit: 20,
      });

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('pagination');
      expect(result).toHaveProperty('facets');
      expect(result.facets).toEqual(
        expect.objectContaining({
          countries: expect.any(Array),
          cities: expect.any(Array),
          needsCategories: expect.any(Array),
          verificationStatuses: expect.any(Array),
          riskScoreRanges: expect.any(Array),
          ageRanges: expect.any(Array),
          familySizeRanges: expect.any(Array),
        })
      );
    });

    it('should return correct pagination metadata', async () => {
      (prisma.beneficiary.count as jest.Mock).mockResolvedValue(45);

      const result = await SearchService.searchBeneficiaries({ page: 2, limit: 20 });

      expect(result.pagination).toEqual({ page: 2, limit: 20, total: 45, totalPages: 3 });
      const findManyArgs = (prisma.beneficiary.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyArgs.skip).toBe(20);
      expect(findManyArgs.take).toBe(20);
    });

    it('should build a where clause covering all filters', () => {
      const now = new Date('2026-06-20T00:00:00Z');
      const where = SearchService.buildBeneficiaryWhere(
        {
          query: 'doe',
          country: 'KE',
          city: 'Nairobi',
          needsCategory: 'FOOD',
          verificationStatus: 'VERIFIED',
          riskScoreMin: 10,
          riskScoreMax: 80,
          familySizeMin: 2,
          familySizeMax: 6,
          ageMin: 18,
          ageMax: 40,
        },
        now
      );

      expect(where.status).toBe('VERIFIED');
      expect(where.country).toBe('KE');
      expect(where.city).toBe('Nairobi');
      expect(where.needsCategory).toBe('FOOD');
      expect(where.riskScore).toEqual({ gte: 10, lte: 80 });
      expect(where.familySize).toEqual({ gte: 2, lte: 6 });
      expect(where.OR).toHaveLength(5);
      // age 18..40 -> dateOfBirth between (now-41y, now-18y]
      expect(where.dateOfBirth.lte).toEqual(new Date('2008-06-20T00:00:00Z'));
      expect(where.dateOfBirth.gt).toEqual(new Date('1985-06-20T00:00:00Z'));
    });

    it('should append an id tiebreaker for stable pagination', () => {
      expect(SearchService.buildBeneficiaryOrderBy('createdAt', 'desc')).toEqual([
        { createdAt: 'desc' },
        { id: 'asc' },
      ]);
    });

    it('should invert order when sorting by age', () => {
      expect(SearchService.buildBeneficiaryOrderBy('age', 'desc')).toEqual([
        { dateOfBirth: 'asc' },
        { id: 'asc' },
      ]);
      expect(SearchService.buildBeneficiaryOrderBy('age', 'asc')).toEqual([
        { dateOfBirth: 'desc' },
        { id: 'asc' },
      ]);
    });

    it('should fall back to createdAt for relevance sort', () => {
      expect(SearchService.buildBeneficiaryOrderBy('relevance', 'desc')).toEqual([
        { createdAt: 'desc' },
        { id: 'asc' },
      ]);
    });

    it('should pass supported sort fields through directly', () => {
      expect(SearchService.buildBeneficiaryOrderBy('riskScore', 'asc')).toEqual([
        { riskScore: 'asc' },
        { id: 'asc' },
      ]);
      expect(SearchService.buildBeneficiaryOrderBy('familySize', 'desc')).toEqual([
        { familySize: 'desc' },
        { id: 'asc' },
      ]);
    });

    it("should exclude a facet's own dimension for drill-down counts", () => {
      const now = new Date('2026-06-20T00:00:00Z');
      const filters = { country: 'KE', city: 'Nairobi', riskScoreMin: 50 };

      const full = SearchService.buildBeneficiaryWhere(filters, now);
      expect(full.country).toBe('KE');
      expect(full.riskScore).toEqual({ gte: 50 });

      const exCountry = SearchService.buildBeneficiaryWhere(filters, now, new Set(['country']));
      expect(exCountry.country).toBeUndefined();
      expect(exCountry.city).toBe('Nairobi'); // sibling filters retained

      const exRisk = SearchService.buildBeneficiaryWhere(filters, now, new Set(['risk']));
      expect(exRisk.riskScore).toBeUndefined();
      expect(exRisk.country).toBe('KE');
    });

    it('should assemble facets and keep out-of-range scores in the open-ended bucket', () => {
      const results = [
        [
          { country: 'KE', _count: { _all: 5 } },
          { country: null, _count: { _all: 1 } }, // null excluded
        ],
        [], // cities
        [], // needsCategories
        [], // statuses
        [
          { riskScore: 10, _count: { _all: 3 } },
          { riskScore: 60, _count: { _all: 2 } },
          { riskScore: 150, _count: { _all: 1 } },
        ],
        [
          { familySize: 1, _count: { _all: 4 } },
          { familySize: 5, _count: { _all: 1 } },
        ],
        2, 5, 0, 0, 0, 0, // age bucket counts (6 AGE_BUCKETS)
      ];

      const facets = SearchService.assembleBeneficiaryFacets(results);

      expect(facets.countries).toEqual([{ value: 'KE', count: 5 }]);
      expect(facets.riskScoreRanges).toEqual([
        { range: '0-25', count: 3 },
        { range: '26-50', count: 0 },
        { range: '51-75', count: 2 },
        { range: '76+', count: 1 },
      ]);
      expect(facets.familySizeRanges).toEqual([
        { range: '1', count: 4 },
        { range: '2-3', count: 0 },
        { range: '4-5', count: 1 },
        { range: '6+', count: 0 },
      ]);
      expect(facets.ageRanges).toEqual([
        { range: '0-17', count: 2 },
        { range: '18-25', count: 5 },
        { range: '26-35', count: 0 },
        { range: '36-50', count: 0 },
        { range: '51-65', count: 0 },
        { range: '66+', count: 0 },
      ]);
    });
  });

  describe('searchDistributions', () => {
    const mockDistributions = [
      {
        id: 'dist-1',
        amount: 100,
        status: 'COMPLETED',
        campaign: { id: 'camp-1', title: 'Flood Relief' },
        beneficiary: { id: 'ben-1', firstName: 'John', lastName: 'Doe', country: 'KE', city: 'Nairobi' },
      },
    ];

    beforeEach(() => {
      (prisma.distribution.findMany as jest.Mock).mockResolvedValue(mockDistributions);
      (prisma.distribution.count as jest.Mock).mockResolvedValue(1);
    });

    it('returns data and pagination', async () => {
      const result = await SearchService.searchDistributions({ page: 1, limit: 20 });

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('pagination');
      expect(result.data).toHaveLength(1);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    });

    it('applies skip/take from page and limit', async () => {
      (prisma.distribution.count as jest.Mock).mockResolvedValue(45);

      await SearchService.searchDistributions({ page: 3, limit: 10 });

      const findManyArgs = (prisma.distribution.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyArgs.skip).toBe(20);
      expect(findManyArgs.take).toBe(10);
    });

    it('builds a where clause matching distribution id, tx hash, or transaction ref for distributionId', () => {
      const where = SearchService.buildDistributionWhere({ distributionId: 'dist-1' });
      expect(where.OR).toEqual([
        { id: 'dist-1' },
        { blockchainTxHash: 'dist-1' },
        { transactionRef: 'dist-1' },
      ]);
    });

    it('builds a where clause covering campaign/beneficiary joins, status, method, location, amount and date range', () => {
      const dateFrom = new Date('2026-01-01');
      const dateTo = new Date('2026-02-01');
      const where = SearchService.buildDistributionWhere({
        campaignId: 'camp-1',
        campaignName: 'Flood',
        beneficiaryId: 'ben-1',
        beneficiaryName: 'Doe',
        status: 'COMPLETED',
        method: 'CASH',
        location: 'Nairobi',
        distributedBy: 'staff-1',
        dateFrom,
        dateTo,
        minAmount: 10,
        maxAmount: 500,
      });

      expect(where.campaignId).toBe('camp-1');
      expect(where.campaign).toEqual({ title: { contains: 'Flood', mode: 'insensitive' } });
      expect(where.beneficiaryId).toBe('ben-1');
      expect(where.status).toBe('COMPLETED');
      expect(where.method).toBe('CASH');
      expect(where.distributedBy).toBe('staff-1');
      expect(where.distributedAt).toEqual({ gte: dateFrom, lte: dateTo });
      expect(where.amount).toEqual({ gte: 10, lte: 500 });
      // beneficiaryName + location both contribute to beneficiary.OR
      expect(where.beneficiary.OR).toEqual(
        expect.arrayContaining([
          { firstName: { contains: 'Doe', mode: 'insensitive' } },
          { lastName: { contains: 'Doe', mode: 'insensitive' } },
          { country: { contains: 'Nairobi', mode: 'insensitive' } },
          { city: { contains: 'Nairobi', mode: 'insensitive' } },
        ])
      );
    });

    it('sorts by campaignName/beneficiaryName via relation, with an id tiebreaker', () => {
      expect(SearchService.buildDistributionOrderBy('campaignName', 'asc')).toEqual([
        { campaign: { title: 'asc' } },
        { id: 'asc' },
      ]);
      expect(SearchService.buildDistributionOrderBy('beneficiaryName', 'desc')).toEqual([
        { beneficiary: { firstName: 'desc' } },
        { id: 'asc' },
      ]);
      expect(SearchService.buildDistributionOrderBy('amount', 'desc')).toEqual([
        { amount: 'desc' },
        { id: 'asc' },
      ]);
    });

    it('falls back to createdAt desc for an unrecognized sort field', () => {
      expect(SearchService.buildDistributionOrderBy('bogus' as any, 'asc')).toEqual([
        { createdAt: 'desc' },
        { id: 'asc' },
      ]);
    });
  });

  describe('searchAssignments', () => {
    const mockAssignments = [
      {
        id: 'assign-1',
        priority: 5,
        assignedAt: new Date('2026-01-15'),
        campaign: { id: 'camp-1', title: 'Flood Relief' },
        beneficiary: {
          id: 'ben-1',
          firstName: 'John',
          lastName: 'Doe',
          country: 'KE',
          city: 'Nairobi',
          needsCategory: 'FOOD',
        },
      },
    ];

    beforeEach(() => {
      (prisma.beneficiaryAssignment.findMany as jest.Mock).mockResolvedValue(mockAssignments);
      (prisma.beneficiaryAssignment.count as jest.Mock).mockResolvedValue(1);
    });

    it('returns data and pagination', async () => {
      const result = await SearchService.searchAssignments({ page: 1, limit: 20 });

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('pagination');
      expect(result.data).toHaveLength(1);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    });

    it('applies skip/take from page and limit', async () => {
      (prisma.beneficiaryAssignment.count as jest.Mock).mockResolvedValue(23);

      await SearchService.searchAssignments({ page: 2, limit: 10 });

      const findManyArgs = (prisma.beneficiaryAssignment.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyArgs.skip).toBe(10);
      expect(findManyArgs.take).toBe(10);
    });

    it('builds a where clause covering id, campaign/beneficiary joins, needsCategory, location, priority range and date range', () => {
      const dateFrom = new Date('2026-01-01');
      const dateTo = new Date('2026-02-01');
      const where = SearchService.buildAssignmentWhere({
        assignmentId: 'assign-1',
        campaignId: 'camp-1',
        campaignName: 'Flood',
        beneficiaryId: 'ben-1',
        beneficiaryName: 'Doe',
        needsCategory: 'FOOD',
        location: 'Nairobi',
        priorityMin: 1,
        priorityMax: 10,
        dateFrom,
        dateTo,
      });

      expect(where.id).toBe('assign-1');
      expect(where.campaignId).toBe('camp-1');
      expect(where.campaign).toEqual({ title: { contains: 'Flood', mode: 'insensitive' } });
      expect(where.beneficiaryId).toBe('ben-1');
      expect(where.beneficiary.needsCategory).toBe('FOOD');
      expect(where.beneficiary.OR).toEqual(
        expect.arrayContaining([
          { firstName: { contains: 'Doe', mode: 'insensitive' } },
          { lastName: { contains: 'Doe', mode: 'insensitive' } },
          { country: { contains: 'Nairobi', mode: 'insensitive' } },
          { city: { contains: 'Nairobi', mode: 'insensitive' } },
        ])
      );
      expect(where.priority).toEqual({ gte: 1, lte: 10 });
      expect(where.assignedAt).toEqual({ gte: dateFrom, lte: dateTo });
    });

    it('matches free-text query against notes', () => {
      const where = SearchService.buildAssignmentWhere({ query: 'urgent case' });
      expect(where.notes).toEqual({ contains: 'urgent case', mode: 'insensitive' });
    });

    it('sorts by campaignName/beneficiaryName via relation, with an id tiebreaker', () => {
      expect(SearchService.buildAssignmentOrderBy('campaignName', 'asc')).toEqual([
        { campaign: { title: 'asc' } },
        { id: 'asc' },
      ]);
      expect(SearchService.buildAssignmentOrderBy('priority', 'desc')).toEqual([
        { priority: 'desc' },
        { id: 'asc' },
      ]);
    });

    it('falls back to assignedAt desc for an unrecognized sort field', () => {
      expect(SearchService.buildAssignmentOrderBy('bogus' as any, 'asc')).toEqual([
        { assignedAt: 'desc' },
        { id: 'asc' },
      ]);
    });
  });

  describe('advancedSearch entity routing', () => {
    it('routes entityType=distribution to searchDistributions', async () => {
      (prisma.distribution.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.distribution.count as jest.Mock).mockResolvedValue(0);

      await SearchService.advancedSearch({ entityType: 'distribution', campaignId: 'camp-1', page: 1, limit: 20 });

      expect(prisma.distribution.findMany).toHaveBeenCalled();
      const findManyArgs = (prisma.distribution.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyArgs.where.campaignId).toBe('camp-1');
    });

    it('routes entityType=assignments to searchAssignments', async () => {
      (prisma.beneficiaryAssignment.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.beneficiaryAssignment.count as jest.Mock).mockResolvedValue(0);

      await SearchService.advancedSearch({ entityType: 'assignments', beneficiaryId: 'ben-1', page: 1, limit: 20 });

      expect(prisma.beneficiaryAssignment.findMany).toHaveBeenCalled();
      const findManyArgs = (prisma.beneficiaryAssignment.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyArgs.where.beneficiaryId).toBe('ben-1');
    });
  });

  describe('globalSearch', () => {
    it('should throw error if query is not provided', async () => {
      await expect(SearchService.globalSearch({ page: 1, limit: 10 })).rejects.toThrow('Query is required');
    });

    it('should return results from all entities', async () => {
      const mockCampaigns = [{ id: '1', title: 'Test', status: 'ACTIVE', entityType: 'campaign' }];
      const mockDonations = [{ id: '1', amount: 100, status: 'CONFIRMED', entityType: 'donation' }];
      const mockBeneficiaries = [{ id: '1', firstName: 'Test', lastName: 'User', status: 'VERIFIED', entityType: 'beneficiary' }];

      (prisma.campaign.findMany as jest.Mock).mockResolvedValue(mockCampaigns);
      (prisma.donation.findMany as jest.Mock).mockResolvedValue(mockDonations);
      (prisma.beneficiary.findMany as jest.Mock).mockResolvedValue(mockBeneficiaries);

      const result = await SearchService.globalSearch({
        query: 'test',
        page: 1,
        limit: 10,
      });

      expect(result).toHaveProperty('data');
      expect(result.data.length).toBeGreaterThan(0);
    });
  });

  describe('trigram similarity relevance ranking', () => {
    it('searchCampaigns returns relevanceScore field when query is provided', async () => {
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([{ id: 'camp-1', score: 0.85 }])
        .mockResolvedValueOnce([{ count: 1 }]);
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'camp-1',
          title: 'Syria Relief Fund',
          organization: { name: 'Org' },
          _count: { donations: 0, beneficiaries: 0 },
        },
      ]);

      const result = await SearchService.searchCampaigns({
        query: 'syria relief',
        sortBy: 'relevance',
        page: 1,
        limit: 20,
      });

      expect(result.data[0]).toHaveProperty('relevanceScore');
      expect(result.data[0].relevanceScore).toBeGreaterThan(0);
    });

    it('searchCampaigns ranks exact title match higher than description match', async () => {
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'camp-1', score: 0.95 }, // exact title match
          { id: 'camp-2', score: 0.45 }, // description match only
        ])
        .mockResolvedValueOnce([{ count: 2 }]);
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'camp-1',
          title: 'Syria Relief Fund',
          organization: { name: 'Org' },
          _count: { donations: 0, beneficiaries: 0 },
        },
        {
          id: 'camp-2',
          title: 'Other Campaign',
          organization: { name: 'Org' },
          _count: { donations: 0, beneficiaries: 0 },
        },
      ]);

      const result = await SearchService.searchCampaigns({
        query: 'syria relief',
        sortBy: 'relevance',
        page: 1,
        limit: 20,
      });

      expect(result.data[0].id).toBe('camp-1');
      expect(result.data[0].relevanceScore).toBeGreaterThan(result.data[1].relevanceScore);
    });

    it('sortBy relevance returns results in descending word_similarity order', async () => {
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'camp-1', score: 0.9 },
          { id: 'camp-2', score: 0.7 },
          { id: 'camp-3', score: 0.5 },
        ])
        .mockResolvedValueOnce([{ count: 3 }]);
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'camp-1',
          title: 'High Match',
          organization: { name: 'Org' },
          _count: { donations: 0, beneficiaries: 0 },
        },
        {
          id: 'camp-2',
          title: 'Medium Match',
          organization: { name: 'Org' },
          _count: { donations: 0, beneficiaries: 0 },
        },
        {
          id: 'camp-3',
          title: 'Low Match',
          organization: { name: 'Org' },
          _count: { donations: 0, beneficiaries: 0 },
        },
      ]);

      const result = await SearchService.searchCampaigns({
        query: 'match',
        sortBy: 'relevance',
        page: 1,
        limit: 20,
      });

      expect(result.data[0].relevanceScore).toBeGreaterThanOrEqual(result.data[1].relevanceScore);
      expect(result.data[1].relevanceScore).toBeGreaterThanOrEqual(result.data[2].relevanceScore);
    });

    it('searchDonations returns relevanceScore field when query is provided', async () => {
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([{ id: 'don-1', score: 0.75 }])
        .mockResolvedValueOnce([{ count: 1 }]);
      (prisma.donation.findMany as jest.Mock).mockResolvedValue([
        { id: 'don-1', amount: 100, campaign: { id: 'c1', title: 'Test' }, user: { id: 'u1', username: 'user', email: 'test@test.com' } },
      ]);

      const result = await SearchService.searchDonations({
        query: 'thanks',
        sortBy: 'relevance',
        page: 1,
        limit: 20,
      });

      expect(result.data[0]).toHaveProperty('relevanceScore');
      expect(result.data[0].relevanceScore).toBeGreaterThan(0);
    });

    it('searchBeneficiaries returns relevanceScore field when query is provided', async () => {
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([{ id: 'ben-1', score: 0.9 }])
        .mockResolvedValueOnce([{ count: 1 }]);
      (prisma.beneficiary.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'ben-1',
          firstName: 'Ahmed',
          lastName: 'Khalil',
          user: { id: 'u1', email: 'test@test.com' },
          _count: { distributions: 0 },
        },
      ]);

      const result = await SearchService.searchBeneficiaries({
        query: 'Ahmed',
        sortBy: 'relevance',
        page: 1,
        limit: 20,
      });

      expect(result.data[0]).toHaveProperty('relevanceScore');
      expect(result.data[0].relevanceScore).toBeGreaterThan(0);
    });
  });

  describe('globalSearch BM25-inspired cross-entity scoring', () => {
    it('interleaves results by normalized score across entity types', async () => {
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'camp-1', title: 'Test', status: 'ACTIVE', score: 0.8 },
          { id: 'camp-2', title: 'Test2', status: 'ACTIVE', score: 0.4 },
        ])
        .mockResolvedValueOnce([
          { id: 'don-1', amount: 100, status: 'CONFIRMED', score: 0.9 },
          { id: 'don-2', amount: 50, status: 'CONFIRMED', score: 0.3 },
        ])
        .mockResolvedValueOnce([
          { id: 'ben-1', firstName: 'Test', lastName: 'User', status: 'VERIFIED', score: 0.7 },
          { id: 'ben-2', firstName: 'Test2', lastName: 'User2', status: 'VERIFIED', score: 0.5 },
        ]);

      const result = await SearchService.globalSearch({
        query: 'test',
        page: 1,
        limit: 10,
      });

      expect(result.data).toHaveLength(6);
      expect(result.data[0]).toHaveProperty('relevanceScore');
      expect(result.data[0]).toHaveProperty('entityType');
    });

    it('prioritizes highly relevant beneficiaries over weakly relevant campaigns', async () => {
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'camp-1', title: 'Weak Match', status: 'ACTIVE', score: 0.3 },
          { id: 'camp-2', title: 'Weak Match2', status: 'ACTIVE', score: 0.25 },
        ])
        .mockResolvedValueOnce([
          { id: 'don-1', amount: 100, status: 'CONFIRMED', score: 0.2 },
        ])
        .mockResolvedValueOnce([
          { id: 'ben-1', firstName: 'Ahmed', lastName: 'Khalil', status: 'VERIFIED', score: 0.9 },
          { id: 'ben-2', firstName: 'Ahmed', lastName: 'Mohamed', status: 'VERIFIED', score: 0.85 },
          { id: 'ben-3', firstName: 'Ahmed', lastName: 'Ali', status: 'VERIFIED', score: 0.8 },
          { id: 'ben-4', firstName: 'Ahmed', lastName: 'Hassan', status: 'VERIFIED', score: 0.75 },
          { id: 'ben-5', firstName: 'Ahmed', lastName: 'Omar', status: 'VERIFIED', score: 0.7 },
        ]);

      const result = await SearchService.globalSearch({
        query: 'Ahmed',
        page: 1,
        limit: 10,
      });

      // Top 5 results should all be beneficiaries (higher relevance)
      const top5 = result.data.slice(0, 5);
      top5.forEach(item => {
        expect(item.entityType).toBe('beneficiary');
      });
    });

    it('de-duplicates results by (entityType, id)', async () => {
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'camp-1', title: 'Test', status: 'ACTIVE', score: 0.8 },
          { id: 'camp-1', title: 'Test', status: 'ACTIVE', score: 0.8 }, // duplicate
        ])
        .mockResolvedValueOnce([{ id: 'don-1', amount: 100, status: 'CONFIRMED', score: 0.9 }])
        .mockResolvedValueOnce([{ id: 'ben-1', firstName: 'Test', lastName: 'User', status: 'VERIFIED', score: 0.7 }]);

      const result = await SearchService.globalSearch({
        query: 'test',
        page: 1,
        limit: 10,
      });

      const campaignResults = result.data.filter((item: any) => item.entityType === 'campaign');
      expect(campaignResults).toHaveLength(1); // duplicate removed
    });

    it('includes relevanceScore in globalSearch results', async () => {
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([{ id: 'camp-1', title: 'Test', status: 'ACTIVE', score: 0.8 }])
        .mockResolvedValueOnce([{ id: 'don-1', amount: 100, status: 'CONFIRMED', score: 0.9 }])
        .mockResolvedValueOnce([{ id: 'ben-1', firstName: 'Test', lastName: 'User', status: 'VERIFIED', score: 0.7 }]);

      const result = await SearchService.globalSearch({
        query: 'test',
        page: 1,
        limit: 10,
      });

      result.data.forEach((item: any) => {
        expect(item).toHaveProperty('relevanceScore');
        expect(item.relevanceScore).toBeGreaterThan(0);
      });
    });
  });

  describe('cursor-based pagination', () => {
    it('generates nextCursor when there are more results', async () => {
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'camp-1', score: 0.9 },
          { id: 'camp-2', score: 0.8 },
        ])
        .mockResolvedValueOnce([{ count: 5 }]);
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'camp-1',
          title: 'Test',
          organization: { name: 'Org' },
          _count: { donations: 0, beneficiaries: 0 },
        },
        {
          id: 'camp-2',
          title: 'Test2',
          organization: { name: 'Org' },
          _count: { donations: 0, beneficiaries: 0 },
        },
      ]);

      const result = await SearchService.searchCampaigns({
        query: 'test',
        sortBy: 'relevance',
        page: 1,
        limit: 2,
      });

      expect(result.pagination).toHaveProperty('nextCursor');
      expect(result.pagination.nextCursor).toBeTruthy();
    });

    it('uses cursor to fetch next page', async () => {
      const cursor = buildCursor(0.8, 'camp-2');

      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'camp-3', score: 0.7 },
          { id: 'camp-4', score: 0.6 },
        ])
        .mockResolvedValueOnce([{ count: 5 }]);
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'camp-3',
          title: 'Test3',
          organization: { name: 'Org' },
          _count: { donations: 0, beneficiaries: 0 },
        },
        {
          id: 'camp-4',
          title: 'Test4',
          organization: { name: 'Org' },
          _count: { donations: 0, beneficiaries: 0 },
        },
      ]);

      const result = await SearchService.searchCampaigns({
        query: 'test',
        sortBy: 'relevance',
        page: 2,
        limit: 2,
        cursor,
      });

      expect(result.data).toHaveLength(2);
      expect(result.data[0].id).toBe('camp-3');
    });

    it('cursor pagination is stable across inserts', async () => {
      // First page
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'camp-1', score: 0.9 },
          { id: 'camp-2', score: 0.8 },
        ])
        .mockResolvedValueOnce([{ count: 4 }]);
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'camp-1',
          title: 'Test',
          organization: { name: 'Org' },
          _count: { donations: 0, beneficiaries: 0 },
        },
        {
          id: 'camp-2',
          title: 'Test2',
          organization: { name: 'Org' },
          _count: { donations: 0, beneficiaries: 0 },
        },
      ]);

      const page1 = await SearchService.searchCampaigns({
        query: 'test',
        sortBy: 'relevance',
        page: 1,
        limit: 2,
      });

      const cursor = page1.pagination.nextCursor;

      // Second page with cursor (simulating new row inserted between page 1 and 2)
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'camp-3', score: 0.7 },
          { id: 'camp-4', score: 0.6 },
        ])
        .mockResolvedValueOnce([{ count: 4 }]);
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'camp-3',
          title: 'Test3',
          organization: { name: 'Org' },
          _count: { donations: 0, beneficiaries: 0 },
        },
        {
          id: 'camp-4',
          title: 'Test4',
          organization: { name: 'Org' },
          _count: { donations: 0, beneficiaries: 0 },
        },
      ]);

      const page2 = await SearchService.searchCampaigns({
        query: 'test',
        sortBy: 'relevance',
        page: 2,
        limit: 2,
        cursor,
      });

      expect(page2.data).toHaveLength(2);
      expect(page2.data[0].id).toBe('camp-3');
      expect(page2.data[1].id).toBe('camp-4');
      // No duplicates from page 1
      expect(page2.data.every((item: any) => item.id !== 'camp-1' && item.id !== 'camp-2')).toBe(true);
    });

    it('globalSearch supports cursor pagination', async () => {
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'camp-1', title: 'Test', status: 'ACTIVE', score: 0.9 },
          { id: 'camp-2', title: 'Test2', status: 'ACTIVE', score: 0.8 },
        ])
        .mockResolvedValueOnce([{ id: 'don-1', amount: 100, status: 'CONFIRMED', score: 0.7 }])
        .mockResolvedValueOnce([{ id: 'ben-1', firstName: 'Test', lastName: 'User', status: 'VERIFIED', score: 0.6 }]);

      const result = await SearchService.globalSearch({
        query: 'test',
        page: 1,
        limit: 2,
      });

      expect(result.pagination).toHaveProperty('nextCursor');
    });

    it('round-trips a float4-precision-busting score through the cursor without corrupting it', async () => {
      // word_similarity() returns a float4; widened to a JS double this looks like
      // 0.5000001192092896 rather than a clean 0.5 — the exact scenario that broke
      // the pre-fix cursor's JSON-number encoding and the WHERE-clause comparison.
      const trickyScore = 0.5000001192092896;

      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([{ id: 'camp-9', score: trickyScore }])
        .mockResolvedValueOnce([{ count: 5 }]);
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
        { id: 'camp-9', title: 'Relief', organization: { name: 'Org' }, _count: { donations: 0, beneficiaries: 0 } },
      ]);

      const page1 = await SearchService.searchCampaigns({
        query: 'relief',
        sortBy: 'relevance',
        page: 1,
        limit: 1,
      });

      const cursor = page1.pagination.nextCursor!;
      const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));

      // The score survives the encode/decode round trip bit-for-bit (JSON number
      // round-tripping is lossless in JS; the bug was never really here, but this
      // pins the behavior so a future encoding change can't silently reintroduce it).
      expect(decoded.score).toBe(trickyScore);
      expect(decoded.v).toBe(2);

      (prisma.$queryRaw as jest.Mock).mockReset();
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([{ id: 'camp-8', score: 0.4 }])
        .mockResolvedValueOnce([{ count: 5 }]);
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
        { id: 'camp-8', title: 'Relief 2', organization: { name: 'Org' }, _count: { donations: 0, beneficiaries: 0 } },
      ]);

      await SearchService.searchCampaigns({
        query: 'relief',
        sortBy: 'relevance',
        page: 2,
        limit: 1,
        cursor,
      });

      const rankedCall = (prisma.$queryRaw as jest.Mock).mock.calls[0][0] as {
        text: string;
        values: unknown[];
      };

      // The cursor value sent back to Postgres is the exact same double we decoded —
      // no truncation or re-rounding on the way back into the query.
      expect(rankedCall.values).toContain(trickyScore);
      // Both sides of the comparison are explicitly cast to the same type, and the
      // comparison is decomposed instead of relying on tuple-comparison promotion.
      expect(rankedCall.text).toMatch(/CAST\(.*AS DOUBLE PRECISION\)/s);
      expect(rankedCall.text).toMatch(/CAST\(\$\d+ AS DOUBLE PRECISION\)/);
      expect(rankedCall.text).not.toMatch(/\(score, id\)/);
    });

    it('treats a pre-fix (unversioned) cursor as absent instead of misinterpreting its score', async () => {
      const legacyCursor = buildLegacyCursor(0.8, 'camp-2');

      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([{ id: 'camp-1', score: 0.9 }])
        .mockResolvedValueOnce([{ count: 1 }]);
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
        { id: 'camp-1', title: 'Test', organization: { name: 'Org' }, _count: { donations: 0, beneficiaries: 0 } },
      ]);

      await expect(
        SearchService.searchCampaigns({
          query: 'test',
          sortBy: 'relevance',
          page: 2,
          limit: 1,
          cursor: legacyCursor,
        })
      ).resolves.toBeDefined();

      const rankedCall = (prisma.$queryRaw as jest.Mock).mock.calls[0][0] as { text: string; values: unknown[] };
      // The legacy cursor's score never reaches the query — it's silently dropped,
      // and the query runs as an unfiltered first page instead.
      expect(rankedCall.values).not.toContain(0.8);
      expect(rankedCall.text).not.toMatch(/OR \(/);
    });

    it('handles a manipulated cursor score without crashing or leaking extra rows', async () => {
      const tamperedCursor = buildCursor(-1, 'camp-legit');

      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0 }]);

      const result = await SearchService.searchCampaigns({
        query: 'relief',
        sortBy: 'relevance',
        page: 2,
        limit: 10,
        cursor: tamperedCursor,
      });

      expect(result.data).toEqual([]);

      const rankedCall = (prisma.$queryRaw as jest.Mock).mock.calls[0][0] as { text: string; values: unknown[] };
      // The tampered value is bound as a parameter (never string-concatenated), and the
      // score threshold filter (`> 0.2`) still applies regardless of the cursor.
      expect(rankedCall.values).toContain(-1);
      expect(rankedCall.text).toMatch(/> 0\.2/);
    });

    it('applies COALESCE around the description score for campaigns, matching donation search', async () => {
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([{ id: 'camp-1', score: 0.5 }])
        .mockResolvedValueOnce([{ count: 1 }]);
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
        { id: 'camp-1', title: 'Test', organization: { name: 'Org' }, _count: { donations: 0, beneficiaries: 0 } },
      ]);

      await SearchService.searchCampaigns({ query: 'test', sortBy: 'relevance', page: 1, limit: 20 });

      const rankedCall = (prisma.$queryRaw as jest.Mock).mock.calls[0][0] as { text: string };
      expect(rankedCall.text).toMatch(/COALESCE\(\s*word_similarity\(\$\d+, description\),\s*0\s*\)/);
    });
  });
});
