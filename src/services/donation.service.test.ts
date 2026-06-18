import { DonationService } from './donation.service';
import prisma from '../config/database';

// Mock Prisma
jest.mock('../config/database');

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
    it('should return paginated donations', async () => {
      const mockDonations = [
        { id: '1', amount: 100, status: 'CONFIRMED' },
        { id: '2', amount: 50, status: 'CONFIRMED' },
      ];

      (prisma.donation.findMany as jest.Mock).mockResolvedValue(mockDonations);
      (prisma.donation.count as jest.Mock).mockResolvedValue(2);

      const result = await DonationService.getDonations({}, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('pagination');
      expect(result.data).toHaveLength(2);
    });
  });
});
