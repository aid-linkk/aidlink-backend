import { AnalyticsService } from './analytics.service';
import prisma from '../config/database';

// Mock Prisma
jest.mock('../config/database');

describe('AnalyticsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

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
});
