import { CampaignService } from './campaign.service';
import { CampaignStatus, Role } from '@prisma/client';

jest.mock('../config/database', () => {
  const mock = {
    __esModule: true,
    default: {
      campaign: {
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      donation: { aggregate: jest.fn() },
      distribution: { aggregate: jest.fn() },
      beneficiary: { findUnique: jest.fn() },
      beneficiaryAssignment: { upsert: jest.fn() },
      milestone: { create: jest.fn(), deleteMany: jest.fn() },
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

const baseCampaign = (overrides: any = {}) => ({
  id: 'campaign-1',
  userId: 'user-1',
  organizationId: 'org-1',
  title: 'Test Campaign',
  description: 'A test campaign description',
  targetAmount: 10000,
  currentAmount: 2500,
  startDate: new Date('2025-01-01'),
  endDate: new Date('2025-12-31'),
  status: CampaignStatus.ACTIVE,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('CampaignService', () => {
  beforeEach(() => jest.clearAllMocks());

  // ─── updateCampaign ────────────────────────────────────────────

  describe('updateCampaign', () => {
    it('updates successfully for owner', async () => {
      const campaign = baseCampaign();
      const updated = { ...campaign, title: 'Updated Title' };
      prismaMock.campaign.findUnique.mockResolvedValue(campaign);
      prismaMock.campaign.update.mockResolvedValue(updated);

      const result = await CampaignService.updateCampaign(
        'campaign-1', { title: 'Updated Title' }, 'user-1', Role.DONOR,
      );
      expect(result.title).toBe('Updated Title');
      expect(prismaMock.campaign.update).toHaveBeenCalledWith({
        where: { id: 'campaign-1' },
        data: { title: 'Updated Title' },
      });
    });

    it('updates successfully for admin (non-owner)', async () => {
      const campaign = baseCampaign();
      prismaMock.campaign.findUnique.mockResolvedValue(campaign);
      prismaMock.campaign.update.mockResolvedValue({ ...campaign, title: 'Admin Update' });

      const result = await CampaignService.updateCampaign(
        'campaign-1', { title: 'Admin Update' }, 'other-user', Role.ADMIN,
      );
      expect(result.title).toBe('Admin Update');
    });

    it('rejects non-owner non-admin', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      await expect(
        CampaignService.updateCampaign('campaign-1', { title: 'Hack' }, 'other-user', Role.DONOR),
      ).rejects.toThrow('You do not have permission to update this campaign');
    });

    it('rejects update when campaign is completed', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign({ status: CampaignStatus.COMPLETED }));
      await expect(
        CampaignService.updateCampaign('campaign-1', { title: 'Nope' }, 'user-1', Role.DONOR),
      ).rejects.toThrow('Cannot update a completed or cancelled campaign');
    });

    it('rejects update when campaign is cancelled', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign({ status: CampaignStatus.CANCELLED }));
      await expect(
        CampaignService.updateCampaign('campaign-1', { title: 'Nope' }, 'user-1', Role.DONOR),
      ).rejects.toThrow('Cannot update a completed or cancelled campaign');
    });

    it('returns 404 for missing campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(null);
      await expect(
        CampaignService.updateCampaign('missing', {}, 'user-1', Role.DONOR),
      ).rejects.toThrow('Campaign not found');
    });

    it('rejects title shorter than 3 characters', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      await expect(
        CampaignService.updateCampaign('campaign-1', { title: 'ab' }, 'user-1', Role.DONOR),
      ).rejects.toThrow('Title must be at least 3 characters long');
    });

    it('rejects title exceeding 200 characters', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      await expect(
        CampaignService.updateCampaign('campaign-1', { title: 'a'.repeat(201) }, 'user-1', Role.DONOR),
      ).rejects.toThrow('Title must not exceed 200 characters');
    });

    it('rejects description shorter than 10 characters', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      await expect(
        CampaignService.updateCampaign('campaign-1', { description: 'short' }, 'user-1', Role.DONOR),
      ).rejects.toThrow('Description must be at least 10 characters long');
    });

    it('rejects non-positive target amount', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      await expect(
        CampaignService.updateCampaign('campaign-1', { targetAmount: -5 }, 'user-1', Role.DONOR),
      ).rejects.toThrow('Target amount must be a positive number');
    });

    it('rejects invalid image URL', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      await expect(
        CampaignService.updateCampaign('campaign-1', { imageUrl: 'not-a-url' }, 'user-1', Role.DONOR),
      ).rejects.toThrow('Image URL must be a valid URL');
    });

    it('rejects end date before start date', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      await expect(
        CampaignService.updateCampaign(
          'campaign-1',
          { startDate: new Date('2025-06-01'), endDate: new Date('2025-01-01') },
          'user-1', Role.DONOR,
        ),
      ).rejects.toThrow('End date must be after start date');
    });
  });

  // ─── deleteCampaign ────────────────────────────────────────────

  describe('deleteCampaign', () => {
    const txMock = () => ({
      milestone: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      beneficiaryAssignment: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      distribution: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      donation: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      campaign: { delete: jest.fn().mockResolvedValue({}) },
    });

    it('deletes draft campaign for owner', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign({ status: CampaignStatus.DRAFT }));
      const tx = txMock();
      prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

      await CampaignService.deleteCampaign('campaign-1', 'user-1', Role.DONOR);
      expect(tx.campaign.delete).toHaveBeenCalledWith({ where: { id: 'campaign-1' } });
    });

    it('allows admin to delete draft campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign({ status: CampaignStatus.DRAFT }));
      const tx = txMock();
      prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));

      await CampaignService.deleteCampaign('campaign-1', 'admin-user', Role.ADMIN);
      expect(tx.campaign.delete).toHaveBeenCalled();
    });

    it('rejects delete by unauthorized user', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign({ status: CampaignStatus.DRAFT }));
      await expect(
        CampaignService.deleteCampaign('campaign-1', 'other-user', Role.DONOR),
      ).rejects.toThrow('You do not have permission to delete this campaign');
    });

    it('rejects delete for active campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign({ status: CampaignStatus.ACTIVE }));
      await expect(
        CampaignService.deleteCampaign('campaign-1', 'user-1', Role.DONOR),
      ).rejects.toThrow('Can only delete draft campaigns');
    });

    it('rejects delete for completed campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign({ status: CampaignStatus.COMPLETED }));
      await expect(
        CampaignService.deleteCampaign('campaign-1', 'user-1', Role.DONOR),
      ).rejects.toThrow('Can only delete draft campaigns');
    });

    it('returns 404 for missing campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(null);
      await expect(
        CampaignService.deleteCampaign('missing', 'user-1', Role.DONOR),
      ).rejects.toThrow('Campaign not found');
    });
  });

  // ─── getCampaignStats ──────────────────────────────────────────

  describe('getCampaignStats', () => {
    it('returns aggregated stats for existing campaign', async () => {
      const campaign = {
        ...baseCampaign({ targetAmount: 10000, currentAmount: 5000 }),
        _count: { donations: 5, beneficiaries: 3, distributions: 2 },
      };
      prismaMock.campaign.findUnique.mockResolvedValue(campaign);
      prismaMock.donation.aggregate.mockResolvedValue({ _sum: { amount: 5000 } });
      prismaMock.distribution.aggregate.mockResolvedValue({ _sum: { amount: 2000 } });

      const result = await CampaignService.getCampaignStats('campaign-1');

      expect(result.campaignId).toBe('campaign-1');
      expect(result.title).toBe('Test Campaign');
      expect(result.totalDonated).toBe(5000);
      expect(result.totalDistributed).toBe(2000);
      expect(result.donationCount).toBe(5);
      expect(result.beneficiaryCount).toBe(3);
      expect(result.distributionCount).toBe(2);
      expect(result.progress).toBe(50);
    });

    it('returns 404 for missing campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(null);
      await expect(CampaignService.getCampaignStats('missing')).rejects.toThrow('Campaign not found');
    });

    it('calculates progress correctly', async () => {
      const campaign = {
        ...baseCampaign({ targetAmount: 200, currentAmount: 50 }),
        _count: { donations: 1, beneficiaries: 0, distributions: 0 },
      };
      prismaMock.campaign.findUnique.mockResolvedValue(campaign);
      prismaMock.donation.aggregate.mockResolvedValue({ _sum: { amount: 50 } });
      prismaMock.distribution.aggregate.mockResolvedValue({ _sum: { amount: null } });

      const result = await CampaignService.getCampaignStats('campaign-1');
      expect(result.progress).toBe(25);
      expect(result.totalDistributed).toBe(0);
    });

    it('handles zero target amount safely', async () => {
      const campaign = {
        ...baseCampaign({ targetAmount: 0, currentAmount: 0 }),
        _count: { donations: 0, beneficiaries: 0, distributions: 0 },
      };
      prismaMock.campaign.findUnique.mockResolvedValue(campaign);
      prismaMock.donation.aggregate.mockResolvedValue({ _sum: { amount: null } });
      prismaMock.distribution.aggregate.mockResolvedValue({ _sum: { amount: null } });

      const result = await CampaignService.getCampaignStats('campaign-1');
      expect(result.progress).toBe(0);
    });
  });

  // ─── addMilestone ──────────────────────────────────────────────

  describe('addMilestone', () => {
    const validMilestone = { title: 'Phase 1', description: 'Initial phase of the campaign', targetAmount: 5000, order: 0 };

    it('creates milestone successfully for owner', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.milestone.create.mockResolvedValue({ id: 'ms-1', campaignId: 'campaign-1', ...validMilestone });

      const result = await CampaignService.addMilestone('campaign-1', validMilestone, 'user-1', Role.DONOR);
      expect(result.id).toBe('ms-1');
      expect(result.title).toBe('Phase 1');
    });

    it('rejects unauthorized user', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      await expect(
        CampaignService.addMilestone('campaign-1', validMilestone, 'other-user', Role.DONOR),
      ).rejects.toThrow('You do not have permission to add milestones to this campaign');
    });

    it('rejects missing campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(null);
      await expect(
        CampaignService.addMilestone('missing', validMilestone, 'user-1', Role.DONOR),
      ).rejects.toThrow('Campaign not found');
    });

    it('validates required title', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      await expect(
        CampaignService.addMilestone('campaign-1', { ...validMilestone, title: '' }, 'user-1', Role.DONOR),
      ).rejects.toThrow('Milestone title is required');
    });

    it('validates required description', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      await expect(
        CampaignService.addMilestone('campaign-1', { ...validMilestone, description: '' }, 'user-1', Role.DONOR),
      ).rejects.toThrow('Milestone description is required');
    });

    it('validates positive target amount', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      await expect(
        CampaignService.addMilestone('campaign-1', { ...validMilestone, targetAmount: -10 }, 'user-1', Role.DONOR),
      ).rejects.toThrow('Milestone target amount must be a positive number');
    });

    it('validates non-negative integer order', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      await expect(
        CampaignService.addMilestone('campaign-1', { ...validMilestone, order: -1 }, 'user-1', Role.DONOR),
      ).rejects.toThrow('Milestone order must be a non-negative integer');
    });
  });

  // ─── assignBeneficiary ─────────────────────────────────────────

  describe('assignBeneficiary', () => {
    const assignData = { assignedAmount: 500, allocatedAmount: 300, priority: 1 };
    const mockBen = { id: 'ben-1', firstName: 'Jane', lastName: 'Doe' };

    it('assigns beneficiary successfully', async () => {
      const assignment = { id: 'a-1', campaignId: 'campaign-1', beneficiaryId: 'ben-1', ...assignData };
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBen);
      prismaMock.beneficiaryAssignment.upsert.mockResolvedValue(assignment);

      const result = await CampaignService.assignBeneficiary('campaign-1', 'ben-1', assignData, 'user-1', Role.DONOR);
      expect(result.id).toBe('a-1');
      expect(prismaMock.beneficiaryAssignment.upsert).toHaveBeenCalled();
    });

    it('updates existing assignment via upsert', async () => {
      const updated = { id: 'a-1', campaignId: 'campaign-1', beneficiaryId: 'ben-1', assignedAmount: 800, allocatedAmount: 600, priority: 2 };
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBen);
      prismaMock.beneficiaryAssignment.upsert.mockResolvedValue(updated);

      const result = await CampaignService.assignBeneficiary(
        'campaign-1', 'ben-1', { assignedAmount: 800, allocatedAmount: 600, priority: 2 }, 'user-1', Role.DONOR,
      );
      expect(result.assignedAmount).toBe(800);
      const call = prismaMock.beneficiaryAssignment.upsert.mock.calls[0][0];
      expect(call.where.campaignId_beneficiaryId).toEqual({ campaignId: 'campaign-1', beneficiaryId: 'ben-1' });
    });

    it('rejects when campaign is missing', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(null);
      await expect(
        CampaignService.assignBeneficiary('missing', 'ben-1', assignData, 'user-1', Role.DONOR),
      ).rejects.toThrow('Campaign not found');
    });

    it('rejects when beneficiary is missing', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.beneficiary.findUnique.mockResolvedValue(null);
      await expect(
        CampaignService.assignBeneficiary('campaign-1', 'missing', assignData, 'user-1', Role.DONOR),
      ).rejects.toThrow('Beneficiary not found');
    });

    it('rejects unauthorized user', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      await expect(
        CampaignService.assignBeneficiary('campaign-1', 'ben-1', assignData, 'other-user', Role.DONOR),
      ).rejects.toThrow('You do not have permission to assign beneficiaries to this campaign');
    });

    it('rejects negative assigned amount', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBen);
      await expect(
        CampaignService.assignBeneficiary('campaign-1', 'ben-1', { ...assignData, assignedAmount: -1 }, 'user-1', Role.DONOR),
      ).rejects.toThrow('Assigned amount must be a non-negative number');
    });

    it('rejects negative allocated amount', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBen);
      await expect(
        CampaignService.assignBeneficiary('campaign-1', 'ben-1', { ...assignData, allocatedAmount: -1 }, 'user-1', Role.DONOR),
      ).rejects.toThrow('Allocated amount must be a non-negative number');
    });

    it('rejects non-integer priority', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBen);
      await expect(
        CampaignService.assignBeneficiary('campaign-1', 'ben-1', { ...assignData, priority: 1.5 }, 'user-1', Role.DONOR),
      ).rejects.toThrow('Priority must be a non-negative integer');
    });
  });
});
