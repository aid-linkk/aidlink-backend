import { DistributionService } from './distribution.service';
import { DistributionStatus, Role } from '@prisma/client';

jest.mock('../config/database', () => {
  const mock = {
    __esModule: true,
    default: {
      campaign: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      beneficiary: { findUnique: jest.fn() },
      beneficiaryAssignment: { findUnique: jest.fn() },
      distribution: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn(),
    },
  };
  return mock;
});

jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const prismaMock = require('../config/database').default;

const mockDistribution = (overrides: any = {}) => ({
  id: 'dist-1',
  campaignId: 'campaign-1',
  beneficiaryId: 'ben-1',
  amount: 100,
  method: 'CASH',
  status: DistributionStatus.PENDING,
  description: 'Food distribution',
  blockchainTxHash: null,
  proofDocumentUrl: null,
  distributedAt: null,
  distributedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('DistributionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock));
  });

  describe('createDistribution', () => {
    const input = {
      campaignId: 'campaign-1',
      beneficiaryId: 'ben-1',
      amount: 100,
      method: 'CASH' as any,
      description: 'Food distribution',
    };

    it('creates distribution successfully', async () => {
      const campaign = { id: 'campaign-1', userId: 'user-1', status: 'ACTIVE' };
      const beneficiary = { id: 'ben-1' };
      const assignment = { id: 'assign-1', campaignId: 'campaign-1', beneficiaryId: 'ben-1' };

      prismaMock.campaign.findUnique.mockResolvedValue(campaign);
      prismaMock.beneficiary.findUnique.mockResolvedValue(beneficiary);
      prismaMock.beneficiaryAssignment.findUnique.mockResolvedValue(assignment);
      prismaMock.distribution.create.mockResolvedValue(mockDistribution());

      const result = await DistributionService.createDistribution(input, 'user-1', Role.DONOR);

      expect(result.status).toBe(DistributionStatus.PENDING);
      expect(result.amount).toBe(100);
    });

    it('rejects non-existent campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(null);

      await expect(DistributionService.createDistribution(input, 'user-1', Role.DONOR)).rejects.toThrow(
        'Campaign not found'
      );
    });

    it('rejects non-existent beneficiary', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue({ id: 'campaign-1', userId: 'user-1' });
      prismaMock.beneficiary.findUnique.mockResolvedValue(null);

      await expect(DistributionService.createDistribution(input, 'user-1', Role.DONOR)).rejects.toThrow(
        'Beneficiary not found'
      );
    });

    it('rejects unassigned beneficiary', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue({ id: 'campaign-1', userId: 'user-1' });
      prismaMock.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1' });
      prismaMock.beneficiaryAssignment.findUnique.mockResolvedValue(null);

      await expect(DistributionService.createDistribution(input, 'user-1', Role.DONOR)).rejects.toThrow(
        'Beneficiary is not assigned to this campaign'
      );
    });

    it('rejects unauthorized user', async () => {
      const campaign = { id: 'campaign-1', userId: 'owner-1' };
      prismaMock.campaign.findUnique.mockResolvedValue(campaign);
      prismaMock.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1' });
      prismaMock.beneficiaryAssignment.findUnique.mockResolvedValue({ id: 'assign-1' });

      await expect(DistributionService.createDistribution(input, 'other-user', Role.DONOR)).rejects.toThrow(
        'You do not have permission to create distributions for this campaign'
      );
    });

    it('allows admin to create distribution for any campaign', async () => {
      const campaign = { id: 'campaign-1', userId: 'owner-1' };
      prismaMock.campaign.findUnique.mockResolvedValue(campaign);
      prismaMock.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1' });
      prismaMock.beneficiaryAssignment.findUnique.mockResolvedValue({ id: 'assign-1' });
      prismaMock.distribution.create.mockResolvedValue(mockDistribution());

      const result = await DistributionService.createDistribution(input, 'admin-1', Role.ADMIN);

      expect(result.status).toBe(DistributionStatus.PENDING);
    });

    it('wraps creation in a transaction', async () => {
      const campaign = { id: 'campaign-1', userId: 'user-1', status: 'ACTIVE' };
      prismaMock.campaign.findUnique.mockResolvedValue(campaign);
      prismaMock.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1' });
      prismaMock.beneficiaryAssignment.findUnique.mockResolvedValue({ id: 'assign-1' });
      prismaMock.distribution.create.mockResolvedValue(mockDistribution());

      await DistributionService.createDistribution(input, 'user-1', Role.DONOR);

      expect(prismaMock.$transaction).toHaveBeenCalled();
    });
  });

  describe('confirmDistribution', () => {
    it('confirms distribution successfully and decrements campaign balance', async () => {
      const distribution = mockDistribution({ campaign: { id: 'campaign-1' } });
      const updated = mockDistribution({
        status: DistributionStatus.COMPLETED,
        blockchainTxHash: '0xabc',
        distributedAt: new Date(),
        distributedBy: 'user-1',
      });

      prismaMock.distribution.findUnique.mockResolvedValue(distribution);
      prismaMock.distribution.update.mockResolvedValue(updated);
      prismaMock.campaign.update.mockResolvedValue({});

      const result = await DistributionService.confirmDistribution('dist-1', '0xabc', 'user-1');

      expect(result.status).toBe(DistributionStatus.COMPLETED);
      expect(result.blockchainTxHash).toBe('0xabc');
      expect(prismaMock.$transaction).toHaveBeenCalled();
      expect(prismaMock.campaign.update).toHaveBeenCalledWith({
        where: { id: 'campaign-1' },
        data: { currentAmount: { decrement: 100 } },
      });
    });

    it('rolls back when campaign update fails inside transaction', async () => {
      const distribution = mockDistribution({ campaign: { id: 'campaign-1' } });
      prismaMock.distribution.findUnique.mockResolvedValue(distribution);
      prismaMock.distribution.update.mockResolvedValue(mockDistribution({ status: DistributionStatus.COMPLETED }));
      prismaMock.campaign.update.mockRejectedValue(new Error('DB error'));

      await expect(
        DistributionService.confirmDistribution('dist-1', '0xabc', 'user-1')
      ).rejects.toThrow('DB error');
    });

    it('rejects already completed distribution', async () => {
      prismaMock.distribution.findUnique.mockResolvedValue(
        mockDistribution({ status: DistributionStatus.COMPLETED, campaign: { id: 'campaign-1' } })
      );

      await expect(DistributionService.confirmDistribution('dist-1', '0xabc', 'user-1')).rejects.toThrow(
        'Distribution already completed'
      );
    });

    it('throws error for non-existent distribution', async () => {
      prismaMock.distribution.findUnique.mockResolvedValue(null);

      await expect(DistributionService.confirmDistribution('nonexistent', '0xabc', 'user-1')).rejects.toThrow(
        'Distribution not found'
      );
    });
  });

  describe('getDistributions', () => {
    it('returns paginated list of distributions', async () => {
      const distributions = [mockDistribution(), mockDistribution({ id: 'dist-2' })];
      prismaMock.distribution.findMany.mockResolvedValue(distributions);
      prismaMock.distribution.count.mockResolvedValue(2);

      const result = await DistributionService.getDistributions(undefined, undefined, { page: 1, limit: 10 });

      expect(result.data).toHaveLength(2);
      expect(result.pagination.total).toBe(2);
    });

    it('filters by campaignId', async () => {
      prismaMock.distribution.findMany.mockResolvedValue([]);
      prismaMock.distribution.count.mockResolvedValue(0);

      await DistributionService.getDistributions('campaign-1');

      expect(prismaMock.distribution.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ campaignId: 'campaign-1' }) })
      );
    });

    it('filters by beneficiaryId', async () => {
      prismaMock.distribution.findMany.mockResolvedValue([]);
      prismaMock.distribution.count.mockResolvedValue(0);

      await DistributionService.getDistributions(undefined, 'ben-1');

      expect(prismaMock.distribution.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ beneficiaryId: 'ben-1' }) })
      );
    });

    it('uses default pagination when none provided', async () => {
      prismaMock.distribution.findMany.mockResolvedValue([]);
      prismaMock.distribution.count.mockResolvedValue(0);

      await DistributionService.getDistributions();

      expect(prismaMock.distribution.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 10 })
      );
    });
  });

  describe('updateDistributionStatus', () => {
    it('updates status to in_progress by owner', async () => {
      const distribution = mockDistribution({ campaign: { id: 'campaign-1', userId: 'user-1' } });
      prismaMock.distribution.findUnique.mockResolvedValue(distribution);
      prismaMock.distribution.update.mockResolvedValue(
        mockDistribution({ status: DistributionStatus.IN_PROGRESS, distributedBy: 'user-1' })
      );

      const result = await DistributionService.updateDistributionStatus('dist-1', DistributionStatus.IN_PROGRESS, 'user-1', Role.DONOR);

      expect(result.status).toBe(DistributionStatus.IN_PROGRESS);
    });

    it('updates status to completed by admin', async () => {
      const distribution = mockDistribution({ campaign: { id: 'campaign-1', userId: 'owner-1' } });
      prismaMock.distribution.findUnique.mockResolvedValue(distribution);
      prismaMock.distribution.update.mockResolvedValue(
        mockDistribution({ status: DistributionStatus.COMPLETED, distributedAt: new Date() })
      );

      const result = await DistributionService.updateDistributionStatus('dist-1', DistributionStatus.COMPLETED, 'admin-1', Role.ADMIN);

      expect(result.status).toBe(DistributionStatus.COMPLETED);
    });

    it('rejects unauthorized user', async () => {
      const distribution = mockDistribution({ campaign: { id: 'campaign-1', userId: 'owner-1' } });
      prismaMock.distribution.findUnique.mockResolvedValue(distribution);

      await expect(
        DistributionService.updateDistributionStatus('dist-1', DistributionStatus.COMPLETED, 'other-user', Role.DONOR)
      ).rejects.toThrow('You do not have permission to update this distribution');
    });

    it('throws error for non-existent distribution', async () => {
      prismaMock.distribution.findUnique.mockResolvedValue(null);

      await expect(
        DistributionService.updateDistributionStatus('nonexistent', DistributionStatus.COMPLETED, 'user-1', Role.DONOR)
      ).rejects.toThrow('Distribution not found');
    });

    it('sets distributedBy when status is IN_PROGRESS', async () => {
      const distribution = mockDistribution({ campaign: { id: 'campaign-1', userId: 'user-1' } });
      prismaMock.distribution.findUnique.mockResolvedValue(distribution);
      prismaMock.distribution.update.mockResolvedValue(mockDistribution({ status: DistributionStatus.IN_PROGRESS }));

      await DistributionService.updateDistributionStatus('dist-1', DistributionStatus.IN_PROGRESS, 'user-1', Role.DONOR);

      expect(prismaMock.distribution.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: DistributionStatus.IN_PROGRESS,
            distributedBy: 'user-1',
          }),
        })
      );
    });

    it('wraps status update in a transaction', async () => {
      const distribution = mockDistribution({ campaign: { id: 'campaign-1', userId: 'user-1' } });
      prismaMock.distribution.findUnique.mockResolvedValue(distribution);
      prismaMock.distribution.update.mockResolvedValue(mockDistribution({ status: DistributionStatus.COMPLETED }));

      await DistributionService.updateDistributionStatus('dist-1', DistributionStatus.COMPLETED, 'user-1', Role.DONOR);

      expect(prismaMock.$transaction).toHaveBeenCalled();
    });
  });

  describe('addProofDocument', () => {
    it('adds proof document successfully', async () => {
      const distribution = mockDistribution({ campaign: { id: 'campaign-1', userId: 'user-1' } });
      const updated = mockDistribution({ proofDocumentUrl: 'https://proof.example.com/doc.pdf' });

      prismaMock.distribution.findUnique.mockResolvedValue(distribution);
      prismaMock.distribution.update.mockResolvedValue(updated);

      const result = await DistributionService.addProofDocument('dist-1', 'https://proof.example.com/doc.pdf', 'user-1', Role.DONOR);

      expect(result.proofDocumentUrl).toBe('https://proof.example.com/doc.pdf');
    });

    it('rejects unauthorized user', async () => {
      const distribution = mockDistribution({ campaign: { id: 'campaign-1', userId: 'owner-1' } });
      prismaMock.distribution.findUnique.mockResolvedValue(distribution);

      await expect(
        DistributionService.addProofDocument('dist-1', 'https://proof.example.com/doc.pdf', 'other-user', Role.DONOR)
      ).rejects.toThrow('You do not have permission to update this distribution');
    });

    it('throws error for non-existent distribution', async () => {
      prismaMock.distribution.findUnique.mockResolvedValue(null);

      await expect(
        DistributionService.addProofDocument('nonexistent', 'https://proof.example.com/doc.pdf', 'user-1', Role.DONOR)
      ).rejects.toThrow('Distribution not found');
    });
  });
});
