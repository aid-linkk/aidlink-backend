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

    it('sanitizes donorMessage when creating a donation', async () => {
      const mockCampaign = { id: '1', status: 'ACTIVE' };
      const unsanitizedMessage = '<script>alert("xss")</script>';
      const sanitizedMessage = '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;';

      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(mockCampaign);
      (prisma.donation.create as jest.Mock).mockImplementation(async ({ data }) => ({
        id: '1',
        campaignId: '1',
        amount: 100,
        status: 'PENDING',
        donorMessage: data.donorMessage,
      }));

      const result = await DonationService.createDonation({
        campaignId: '1',
        amount: 100,
        currency: 'XLM',
        donorMessage: unsanitizedMessage,
      });

      expect(result.donorMessage).toBe(sanitizedMessage);
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

  describe('refundDonation', () => {
    const mockCampaign = {
      id: 'campaign-1',
      currentAmount: 500,
      targetAmount: 10000,
      status: 'ACTIVE',
    };

    const mockDonation = {
      id: 'donation-1',
      userId: 'user-1',
      campaignId: 'campaign-1',
      amount: 100,
      status: 'CONFIRMED' as const,
      campaign: mockCampaign,
    };

    it('should refund a confirmed donation and decrement campaign currentAmount', async () => {
      const txMock = {
        donation: {
          update: jest.fn().mockResolvedValue({
            id: 'donation-1',
            status: 'REFUNDED',
          }),
        },
        campaign: {
          update: jest.fn().mockResolvedValue({
            id: 'campaign-1',
            currentAmount: 400,
          }),
        },
      };

      (prisma.donation.findUnique as jest.Mock).mockResolvedValue(mockDonation);
      (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(txMock));

      const result = await DonationService.refundDonation('donation-1', 'user-1', 'DONOR' as any);

      expect(result.status).toBe('REFUNDED');
      expect(txMock.campaign.update).toHaveBeenCalledWith({
        where: { id: 'campaign-1' },
        data: { currentAmount: { decrement: 100 } },
      });
    });

    it('should throw error if donation is not confirmed', async () => {
      (prisma.donation.findUnique as jest.Mock).mockResolvedValue({
        ...mockDonation,
        status: 'PENDING',
      });

      await expect(
        DonationService.refundDonation('donation-1', 'user-1', 'DONOR' as any)
      ).rejects.toThrow('Only confirmed donations can be refunded');
    });

    it('should throw error if refund would make campaign balance negative', async () => {
      (prisma.donation.findUnique as jest.Mock).mockResolvedValue({
        ...mockDonation,
        amount: 600,
        campaign: { ...mockCampaign, currentAmount: 500 },
      });

      await expect(
        DonationService.refundDonation('donation-1', 'user-1', 'DONOR' as any)
      ).rejects.toThrow('Refund amount exceeds campaign current balance');
    });

    it('should allow admin to refund any donation', async () => {
      const txMock = {
        donation: {
          update: jest.fn().mockResolvedValue({
            id: 'donation-1',
            status: 'REFUNDED',
          }),
        },
        campaign: {
          update: jest.fn().mockResolvedValue({
            id: 'campaign-1',
            currentAmount: 400,
          }),
        },
      };

      (prisma.donation.findUnique as jest.Mock).mockResolvedValue({
        ...mockDonation,
        userId: 'different-user',
      });
      (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(txMock));

      const result = await DonationService.refundDonation('donation-1', 'admin-1', 'ADMIN' as any);

      expect(result.status).toBe('REFUNDED');
    });

    it('should allow donor to refund their own donation', async () => {
      const txMock = {
        donation: {
          update: jest.fn().mockResolvedValue({
            id: 'donation-1',
            status: 'REFUNDED',
          }),
        },
        campaign: {
          update: jest.fn().mockResolvedValue({
            id: 'campaign-1',
            currentAmount: 400,
          }),
        },
      };

      (prisma.donation.findUnique as jest.Mock).mockResolvedValue(mockDonation);
      (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(txMock));

      const result = await DonationService.refundDonation('donation-1', 'user-1', 'DONOR' as any);

      expect(result.status).toBe('REFUNDED');
    });
  });


  describe('getDonations', () => {
    const mockDonations = [
      {
        id: '1',
        campaignId: 'camp1',
        userId: 'user1',
        amount: 100,
        currency: 'XLM',
        status: 'CONFIRMED',
        campaign: { id: 'camp1', title: 'Test Campaign' },
        user: { id: 'user1', username: 'testuser', email: 'test@test.com' },
      },
      {
        id: '2',
        campaignId: 'camp1',
        userId: 'user2',
        amount: 200,
        currency: 'XLM',
        status: 'PENDING',
        campaign: { id: 'camp1', title: 'Test Campaign' },
        user: { id: 'user2', username: 'testuser2', email: 'test2@test.com' },
      },
    ];

    it('should return all donations when no filters applied', async () => {
      (prisma.donation.findMany as jest.Mock).mockResolvedValue(mockDonations);
      (prisma.donation.count as jest.Mock).mockResolvedValue(2);

      const result = await DonationService.getDonations({}, { page: 1, limit: 10 });

      expect(result.data).toHaveLength(2);
      expect(result.pagination.total).toBe(2);
      expect(result.pagination.page).toBe(1);
    });

    it('should filter donations by user ID', async () => {
      (prisma.donation.findMany as jest.Mock).mockResolvedValue([mockDonations[0]]);
      (prisma.donation.count as jest.Mock).mockResolvedValue(1);

      const result = await DonationService.getDonations(
        { userId: 'user1' },
        { page: 1, limit: 10 }
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].userId).toBe('user1');
      expect(prisma.donation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user1' }),
        })
      );
    });

    it('should filter donations by campaign ID', async () => {
      (prisma.donation.findMany as jest.Mock).mockResolvedValue(mockDonations);
      (prisma.donation.count as jest.Mock).mockResolvedValue(2);

      const result = await DonationService.getDonations(
        { campaignId: 'camp1' },
        { page: 1, limit: 10 }
      );

      expect(result.data).toHaveLength(2);
      expect(prisma.donation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ campaignId: 'camp1' }),
        })
      );
    });

    it('should filter donations by status', async () => {
      (prisma.donation.findMany as jest.Mock).mockResolvedValue([mockDonations[0]]);
      (prisma.donation.count as jest.Mock).mockResolvedValue(1);

      const result = await DonationService.getDonations(
        { status: 'CONFIRMED' },
        { page: 1, limit: 10 }
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].status).toBe('CONFIRMED');
    });

    it('should filter donations by multiple criteria', async () => {
      (prisma.donation.findMany as jest.Mock).mockResolvedValue([mockDonations[0]]);
      (prisma.donation.count as jest.Mock).mockResolvedValue(1);

      const result = await DonationService.getDonations(
        { userId: 'user1', campaignId: 'camp1', status: 'CONFIRMED' },
        { page: 1, limit: 10 }
      );

      expect(result.data).toHaveLength(1);
      expect(prisma.donation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'user1',
            campaignId: 'camp1',
            status: 'CONFIRMED',
          }),
        })
      );
    });

    it('should handle empty results', async () => {
      (prisma.donation.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.donation.count as jest.Mock).mockResolvedValue(0);

      const result = await DonationService.getDonations(
        { userId: 'nonexistent' },
        { page: 1, limit: 10 }
      );

      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
    });

    it('should handle pagination correctly', async () => {
      (prisma.donation.findMany as jest.Mock).mockResolvedValue([mockDonations[1]]);
      (prisma.donation.count as jest.Mock).mockResolvedValue(2);

      const result = await DonationService.getDonations({}, { page: 2, limit: 1 });

      expect(result.data).toHaveLength(1);
      expect(result.pagination.page).toBe(2);
      expect(result.pagination.totalPages).toBe(2);
      expect(prisma.donation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 1,
          take: 1,
        })
      );
    });

    it('should filter by date range', async () => {
      const startDate = new Date('2026-01-01');
      const endDate = new Date('2026-12-31');
      (prisma.donation.findMany as jest.Mock).mockResolvedValue(mockDonations);
      (prisma.donation.count as jest.Mock).mockResolvedValue(2);

      const result = await DonationService.getDonations(
        { startDate, endDate },
        { page: 1, limit: 10 }
      );

      expect(result.data).toHaveLength(2);
      expect(prisma.donation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: expect.objectContaining({
              gte: startDate,
              lte: endDate,
            }),
          }),
        })
      );
    });

    it('should not apply userId filter when userId is undefined', async () => {
      (prisma.donation.findMany as jest.Mock).mockResolvedValue(mockDonations);
      (prisma.donation.count as jest.Mock).mockResolvedValue(2);

      await DonationService.getDonations(
        { userId: undefined, campaignId: 'camp1' },
        { page: 1, limit: 10 }
      );

      const callArgs = (prisma.donation.findMany as jest.Mock).mock.calls[0][0];
      expect(callArgs.where).not.toHaveProperty('userId');
      expect(callArgs.where).toHaveProperty('campaignId');
    });
  });

});