/// <reference types="jest" />

import { SearchService } from './search.service';
import prisma from '../config/database';

// Mock Prisma
jest.mock('../config/database');

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
});
