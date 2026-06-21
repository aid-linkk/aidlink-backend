import { DonationService } from './donation.service';
import prisma from '../config/database';

// Mock Prisma
jest.mock('../config/database');
jest.mock('@prisma/client', () => ({
  DonationStatus: {
    PENDING: 'PENDING',
    CONFIRMED: 'CONFIRMED',
    REFUNDED: 'REFUNDED',
  },
  Role: {
    ADMIN: 'ADMIN',
  },
}));

describe('DonationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createDonation', () => {
    it('should create a donation successfully', async () => {
      const mockCampaign = {
        id: '1',
        status: 'ACTIVE',
      };

      const mockDonation = {
        id: '1',
        campaignId: '1',
        amount: 100,
        status: 'PENDING',
      };

      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(mockCampaign);
      (prisma.donation.create as jest.Mock).mockResolvedValue(mockDonation);

      const result = await DonationService.createDonation({
        campaignId: '1',
        amount: 100,
        currency: 'XLM',
      });

      expect(result).toHaveProperty('id');
      expect(result.status).toBe('PENDING');
    });

    it('should throw error if campaign not found', async () => {
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        DonationService.createDonation({
          campaignId: '1',
          amount: 100,
          currency: 'XLM',
        })
      ).rejects.toThrow('Campaign not found');
    });

    it('should throw error if campaign is not active', async () => {
      const mockCampaign = {
        id: '1',
        status: 'DRAFT',
      };

      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(mockCampaign);

      await expect(
        DonationService.createDonation({
          campaignId: '1',
          amount: 100,
          currency: 'XLM',
        })
      ).rejects.toThrow('Campaign is not active');
    });
  });

  describe('confirmDonation', () => {
    it('should confirm a donation successfully', async () => {
      const mockDonation = {
        id: '1',
        status: 'PENDING',
        campaign: { id: '1' },
      };

      const mockUpdated = {
        id: '1',
        status: 'CONFIRMED',
        blockchainTxHash: 'tx123',
      };

      (prisma.donation.findUnique as jest.Mock).mockResolvedValue(mockDonation);
      (prisma.donation.update as jest.Mock).mockResolvedValue(mockUpdated);

      const result = await DonationService.confirmDonation('1', 'tx123');

      expect(result.status).toBe('CONFIRMED');
      expect(result.blockchainTxHash).toBe('tx123');
    });

    it('should throw error if donation already confirmed', async () => {
      const mockDonation = {
        id: '1',
        status: 'CONFIRMED',
        campaign: { id: '1' },
      };

      (prisma.donation.findUnique as jest.Mock).mockResolvedValue(mockDonation);

      await expect(DonationService.confirmDonation('1', 'tx123')).rejects.toThrow('Donation already confirmed');
    });
  });

  describe('getDonations', () => {
    const defaultPagination = {
      page: 1,
      limit: 10,
      sortBy: 'createdAt',
      sortOrder: 'desc' as const,
    };

    const mockFindManyAndCount = (donations: any[] = [], total = donations.length) => {
      (prisma.donation.findMany as jest.Mock).mockResolvedValue(donations);
      (prisma.donation.count as jest.Mock).mockResolvedValue(total);
    };

    const expectDonationQueryWhere = (where: Record<string, any>) => {
      expect(prisma.donation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where,
          skip: 0,
          take: 10,
          orderBy: { createdAt: 'desc' },
        })
      );
      expect(prisma.donation.count).toHaveBeenCalledWith({ where });
    };

    it('should return paginated donations', async () => {
      const mockDonations = [
        { id: '1', amount: 100, status: 'CONFIRMED' },
        { id: '2', amount: 50, status: 'CONFIRMED' },
      ];

      mockFindManyAndCount(mockDonations, 2);

      const result = await DonationService.getDonations({}, defaultPagination);

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('pagination');
      expect(result.data).toHaveLength(2);
      expectDonationQueryWhere({});
    });

    it('should filter donations by user ID', async () => {
      const mockDonations = [{ id: '1', userId: 'user-1', amount: 100 }];
      mockFindManyAndCount(mockDonations);

      const result = await DonationService.getDonations({ userId: 'user-1' }, defaultPagination);

      expect(result.data).toEqual(mockDonations);
      expectDonationQueryWhere({ userId: 'user-1' });
    });

    it('should filter donations by campaign ID', async () => {
      const mockDonations = [{ id: '1', campaignId: 'campaign-1', amount: 100 }];
      mockFindManyAndCount(mockDonations);

      await DonationService.getDonations({ campaignId: 'campaign-1' }, defaultPagination);

      expectDonationQueryWhere({ campaignId: 'campaign-1' });
    });

    it('should filter donations by status', async () => {
      const mockDonations = [{ id: '1', status: 'CONFIRMED', amount: 100 }];
      mockFindManyAndCount(mockDonations);

      await DonationService.getDonations({ status: 'CONFIRMED' }, defaultPagination);

      expectDonationQueryWhere({ status: 'CONFIRMED' });
    });

    it('should filter donations by start date', async () => {
      const startDate = new Date('2026-01-01T00:00:00.000Z');
      mockFindManyAndCount();

      await DonationService.getDonations({ startDate }, defaultPagination);

      expectDonationQueryWhere({ createdAt: { gte: startDate } });
    });

    it('should filter donations by end date', async () => {
      const endDate = new Date('2026-01-31T23:59:59.000Z');
      mockFindManyAndCount();

      await DonationService.getDonations({ endDate }, defaultPagination);

      expectDonationQueryWhere({ createdAt: { lte: endDate } });
    });

    it('should combine user, campaign, status, and date range filters', async () => {
      const startDate = new Date('2026-01-01T00:00:00.000Z');
      const endDate = new Date('2026-01-31T23:59:59.000Z');
      mockFindManyAndCount([{ id: '1', userId: 'user-1', campaignId: 'campaign-1', status: 'CONFIRMED' }]);

      await DonationService.getDonations(
        {
          userId: 'user-1',
          campaignId: 'campaign-1',
          status: 'CONFIRMED',
          startDate,
          endDate,
        },
        defaultPagination
      );

      expectDonationQueryWhere({
        userId: 'user-1',
        campaignId: 'campaign-1',
        status: 'CONFIRMED',
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      });
    });

    it('should return an empty page when filters match no donations', async () => {
      mockFindManyAndCount([], 0);

      const result = await DonationService.getDonations({ userId: 'missing-user' }, defaultPagination);

      expect(result.data).toEqual([]);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 10,
        total: 0,
        totalPages: 0,
      });
      expectDonationQueryWhere({ userId: 'missing-user' });
    });

    it('should support null filters by using the unfiltered query', async () => {
      mockFindManyAndCount([{ id: '1', amount: 100 }]);

      const result = await DonationService.getDonations(null as any, defaultPagination);

      expect(result.data).toHaveLength(1);
      expectDonationQueryWhere({});
    });
  });
});
