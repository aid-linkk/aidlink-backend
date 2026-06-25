import { MilestoneService } from './milestone.service';
import { MilestoneSubmissionStatus, MilestoneVerificationStatus, ReviewDecision, Role } from '@prisma/client';

jest.mock('../config/database', () => {
  const mock = {
    __esModule: true,
    default: {
      campaign: { findUnique: jest.fn() },
      milestone: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      milestoneSubmission: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      milestoneReview: { create: jest.fn(), findMany: jest.fn() },
      milestoneVerificationHistory: { create: jest.fn() },
      user: { findMany: jest.fn() },
      $transaction: jest.fn(),
    },
  };
  return mock;
});

jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('./notification.service', () => ({
  NotificationService: {
    sendMilestoneSubmissionReceivedNotification: jest.fn().mockResolvedValue(undefined),
    sendMilestoneApprovedNotification: jest.fn().mockResolvedValue(undefined),
    sendMilestoneRejectedNotification: jest.fn().mockResolvedValue(undefined),
    sendMilestoneRevisionRequestedNotification: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../websocket/socket.server', () => ({
  broadcastToUser: jest.fn(),
  broadcastToCampaign: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const prismaMock = require('../config/database').default;

const baseCampaign = (overrides: any = {}) => ({
  id: 'campaign-1',
  userId: 'user-1',
  organizationId: 'org-1',
  title: 'Test Campaign',
  organization: { id: 'org-1' },
  ...overrides,
});

const baseMilestone = (overrides: any = {}) => ({
  id: 'milestone-1',
  campaignId: 'campaign-1',
  title: 'First Milestone',
  verificationStatus: MilestoneVerificationStatus.PENDING_SUBMISSION,
  currentSubmissionId: null,
  currentReviewId: null,
  ...overrides,
});

const baseSubmission = (overrides: any = {}) => ({
  id: 'sub-1',
  campaignId: 'campaign-1',
  milestoneId: 'milestone-1',
  organizationId: 'org-1',
  status: MilestoneSubmissionStatus.DRAFT,
  submittedAt: null,
  milestone: {
    ...baseMilestone(),
    campaign: { ...baseCampaign(), user: { id: 'user-1', email: 'org@test.com' } },
  },
  ...overrides,
});

describe('MilestoneService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (cb: any) => {
      if (typeof cb === 'function') return cb(prismaMock);
      return Promise.all(cb);
    });
  });

  // ─── createSubmission ──────────────────────────────────────────

  describe('createSubmission', () => {
    it('creates draft submission for campaign owner', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.milestone.findFirst.mockResolvedValueOnce(baseMilestone());
      prismaMock.milestoneSubmission.findFirst.mockResolvedValue(null);
      const created = { id: 'sub-1', status: MilestoneSubmissionStatus.DRAFT };
      prismaMock.milestoneSubmission.create.mockResolvedValue(created);
      prismaMock.milestone.update.mockResolvedValue({});

      const result = await MilestoneService.createSubmission(
        'campaign-1',
        'milestone-1',
        'user-1',
        { description: 'Done', evidenceUrls: ['http://x.com'], metricsData: {} }
      );

      expect(result).toEqual(created);
      expect(prismaMock.milestoneSubmission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: MilestoneSubmissionStatus.DRAFT,
            milestoneId: 'milestone-1',
          }),
        })
      );
    });

    it('rejects non-owner', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign({ userId: 'other-user' }));
      await expect(
        MilestoneService.createSubmission('campaign-1', 'milestone-1', 'user-1', {
          description: 'x',
          evidenceUrls: [],
          metricsData: {},
        })
      ).rejects.toThrow('You do not own this campaign');
    });

    it('rejects when active submission already exists', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.milestone.findFirst.mockResolvedValueOnce(baseMilestone());
      prismaMock.milestoneSubmission.findFirst.mockResolvedValue({
        id: 'existing-sub',
        status: MilestoneSubmissionStatus.SUBMITTED,
      });
      await expect(
        MilestoneService.createSubmission('campaign-1', 'milestone-1', 'user-1', {
          description: 'x',
          evidenceUrls: [],
          metricsData: {},
        })
      ).rejects.toThrow('An active submission already exists');
    });

    it('throws 404 when campaign not found', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(null);
      await expect(
        MilestoneService.createSubmission('bad-campaign', 'milestone-1', 'user-1', {
          description: 'x',
          evidenceUrls: [],
          metricsData: {},
        })
      ).rejects.toThrow('Campaign not found');
    });
  });

  // ─── submitForReview ───────────────────────────────────────────

  describe('submitForReview', () => {
    it('transitions DRAFT → SUBMITTED', async () => {
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(
        baseSubmission({ status: MilestoneSubmissionStatus.DRAFT })
      );
      const updated = { ...baseSubmission(), status: MilestoneSubmissionStatus.SUBMITTED };
      prismaMock.milestoneSubmission.update.mockResolvedValue(updated);
      prismaMock.milestone.update.mockResolvedValue({});
      prismaMock.milestoneVerificationHistory.create.mockResolvedValue({});
      prismaMock.user.findMany.mockResolvedValue([]);

      const result = await MilestoneService.submitForReview('sub-1', 'user-1');

      expect(result.status).toBe(MilestoneSubmissionStatus.SUBMITTED);
      expect(prismaMock.milestoneSubmission.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: MilestoneSubmissionStatus.SUBMITTED }),
        })
      );
    });

    it('transitions REVISION_REQUESTED → SUBMITTED (resubmission)', async () => {
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(
        baseSubmission({ status: MilestoneSubmissionStatus.REVISION_REQUESTED })
      );
      const updated = { ...baseSubmission(), status: MilestoneSubmissionStatus.SUBMITTED };
      prismaMock.milestoneSubmission.update.mockResolvedValue(updated);
      prismaMock.milestone.update.mockResolvedValue({});
      prismaMock.milestoneVerificationHistory.create.mockResolvedValue({});
      prismaMock.user.findMany.mockResolvedValue([]);

      const result = await MilestoneService.submitForReview('sub-1', 'user-1');
      expect(result.status).toBe(MilestoneSubmissionStatus.SUBMITTED);
    });

    it('rejects submitting an APPROVED submission', async () => {
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(
        baseSubmission({ status: MilestoneSubmissionStatus.APPROVED })
      );
      await expect(MilestoneService.submitForReview('sub-1', 'user-1')).rejects.toThrow(
        'Cannot submit a submission with status APPROVED'
      );
    });

    it('rejects non-owner', async () => {
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(
        baseSubmission({
          milestone: {
            ...baseMilestone(),
            campaign: { ...baseCampaign({ userId: 'other-user' }), user: { id: 'other-user' } },
          },
        })
      );
      await expect(MilestoneService.submitForReview('sub-1', 'user-1')).rejects.toThrow(
        'You do not own this submission'
      );
    });
  });

  // ─── createReview ──────────────────────────────────────────────

  describe('createReview', () => {
    const reviewableSubmission = () =>
      baseSubmission({
        status: MilestoneSubmissionStatus.SUBMITTED,
        milestone: {
          ...baseMilestone(),
          campaign: {
            ...baseCampaign(),
            userId: 'user-1',
            user: { id: 'user-1', email: 'org@test.com' },
            organization: { id: 'org-1' },
          },
        },
      });

    it('approves submission and marks milestone VERIFIED', async () => {
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(reviewableSubmission());
      const review = { id: 'review-1', decision: ReviewDecision.APPROVED };
      prismaMock.milestoneReview.create.mockResolvedValue(review);
      prismaMock.milestoneSubmission.update.mockResolvedValue({});
      prismaMock.milestone.update.mockResolvedValue({});
      prismaMock.milestoneVerificationHistory.create.mockResolvedValue({});

      const result = await MilestoneService.createReview('sub-1', 'verifier-1', {
        decision: ReviewDecision.APPROVED,
        impactSummary: '150 beneficiaries reached',
      });

      expect(result.decision).toBe(ReviewDecision.APPROVED);
      expect(prismaMock.milestone.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            verificationStatus: MilestoneVerificationStatus.VERIFIED,
            achieved: true,
          }),
        })
      );
    });

    it('rejects submission with reason recorded', async () => {
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(reviewableSubmission());
      const review = { id: 'review-1', decision: ReviewDecision.REJECTED };
      prismaMock.milestoneReview.create.mockResolvedValue(review);
      prismaMock.milestoneSubmission.update.mockResolvedValue({});
      prismaMock.milestone.update.mockResolvedValue({});
      prismaMock.milestoneVerificationHistory.create.mockResolvedValue({});

      const result = await MilestoneService.createReview('sub-1', 'verifier-1', {
        decision: ReviewDecision.REJECTED,
        reason: 'Insufficient evidence provided',
      });

      expect(result.decision).toBe(ReviewDecision.REJECTED);
      expect(prismaMock.milestone.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            verificationStatus: MilestoneVerificationStatus.REJECTED,
          }),
        })
      );
    });

    it('requests revision and returns submission to REVISION_REQUESTED', async () => {
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(reviewableSubmission());
      const review = { id: 'review-1', decision: ReviewDecision.REVISION_REQUESTED };
      prismaMock.milestoneReview.create.mockResolvedValue(review);
      prismaMock.milestoneSubmission.update.mockResolvedValue({});
      prismaMock.milestone.update.mockResolvedValue({});
      prismaMock.milestoneVerificationHistory.create.mockResolvedValue({});

      const result = await MilestoneService.createReview('sub-1', 'verifier-1', {
        decision: ReviewDecision.REVISION_REQUESTED,
        reason: 'Please provide photos',
      });

      expect(result.decision).toBe(ReviewDecision.REVISION_REQUESTED);
      expect(prismaMock.milestoneSubmission.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: MilestoneSubmissionStatus.REVISION_REQUESTED,
          }),
        })
      );
    });

    it('rejects reviewing a DRAFT submission', async () => {
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(
        baseSubmission({ status: MilestoneSubmissionStatus.DRAFT, milestone: reviewableSubmission().milestone })
      );
      await expect(
        MilestoneService.createReview('sub-1', 'verifier-1', { decision: ReviewDecision.APPROVED })
      ).rejects.toThrow('Cannot review a submission with status DRAFT');
    });
  });

  // ─── updateSubmission ──────────────────────────────────────────

  describe('updateSubmission', () => {
    it('allows updating DRAFT submission', async () => {
      const sub = baseSubmission({ status: MilestoneSubmissionStatus.DRAFT });
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(sub);
      const updated = { ...sub, description: 'Updated desc' };
      prismaMock.milestoneSubmission.update.mockResolvedValue(updated);

      const result = await MilestoneService.updateSubmission('sub-1', 'user-1', {
        description: 'Updated desc',
      });

      expect(result.description).toBe('Updated desc');
    });

    it('allows updating REVISION_REQUESTED submission', async () => {
      const sub = baseSubmission({ status: MilestoneSubmissionStatus.REVISION_REQUESTED });
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(sub);
      const updated = { ...sub, description: 'Revised desc' };
      prismaMock.milestoneSubmission.update.mockResolvedValue(updated);

      const result = await MilestoneService.updateSubmission('sub-1', 'user-1', {
        description: 'Revised desc',
      });

      expect(result.description).toBe('Revised desc');
    });

    it('rejects updating a SUBMITTED submission', async () => {
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(
        baseSubmission({ status: MilestoneSubmissionStatus.SUBMITTED })
      );
      await expect(
        MilestoneService.updateSubmission('sub-1', 'user-1', { description: 'x' })
      ).rejects.toThrow('Cannot edit a submission with status SUBMITTED');
    });

    it('rejects non-owner update', async () => {
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(
        baseSubmission({
          status: MilestoneSubmissionStatus.DRAFT,
          milestone: {
            ...baseMilestone(),
            campaign: { ...baseCampaign({ userId: 'other-user' }), user: { id: 'other-user' } },
          },
        })
      );
      await expect(
        MilestoneService.updateSubmission('sub-1', 'user-1', { description: 'x' })
      ).rejects.toThrow('You do not own this submission');
    });

    it('throws 404 when submission not found', async () => {
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(null);
      await expect(
        MilestoneService.updateSubmission('bad-sub', 'user-1', { description: 'x' })
      ).rejects.toThrow('Submission not found');
    });
  });

  // ─── getSubmission ─────────────────────────────────────────────

  describe('getSubmission', () => {
    it('returns submission with reviews and history', async () => {
      const sub = {
        ...baseSubmission(),
        reviews: [],
        history: [],
        milestone: baseMilestone(),
      };
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(sub);

      const result = await MilestoneService.getSubmission('sub-1');
      expect(result.id).toBe('sub-1');
    });

    it('throws 404 when not found', async () => {
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(null);
      await expect(MilestoneService.getSubmission('missing')).rejects.toThrow('Submission not found');
    });
  });

  // ─── listSubmissions ───────────────────────────────────────────

  describe('listSubmissions', () => {
    it('returns submissions for valid milestone', async () => {
      prismaMock.milestone.findFirst.mockResolvedValue(baseMilestone());
      prismaMock.milestoneSubmission.findMany.mockResolvedValue([baseSubmission()]);

      const result = await MilestoneService.listSubmissions('milestone-1', 'campaign-1');
      expect(result).toHaveLength(1);
    });

    it('throws 404 when milestone not in campaign', async () => {
      prismaMock.milestone.findFirst.mockResolvedValue(null);
      await expect(
        MilestoneService.listSubmissions('milestone-1', 'wrong-campaign')
      ).rejects.toThrow('Milestone not found in this campaign');
    });
  });

  // ─── createReview: REVIEW_STARTED history event ────────────────

  describe('createReview: state transitions', () => {
    const reviewableSubmission = () =>
      baseSubmission({
        status: MilestoneSubmissionStatus.SUBMITTED,
        milestone: {
          ...baseMilestone(),
          campaign: {
            ...baseCampaign(),
            userId: 'user-1',
            user: { id: 'user-1', email: 'org@test.com' },
            organization: { id: 'org-1' },
          },
        },
      });

    it('records REVIEW_STARTED then decision when status is SUBMITTED', async () => {
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(reviewableSubmission());
      const review = { id: 'review-1', decision: ReviewDecision.APPROVED };
      prismaMock.milestoneReview.create.mockResolvedValue(review);
      prismaMock.milestoneSubmission.update.mockResolvedValue({});
      prismaMock.milestone.update.mockResolvedValue({});
      prismaMock.milestoneVerificationHistory.create.mockResolvedValue({});

      await MilestoneService.createReview('sub-1', 'verifier-1', {
        decision: ReviewDecision.APPROVED,
      });

      const historyCalls = prismaMock.milestoneVerificationHistory.create.mock.calls;
      const events = historyCalls.map((c: any) => c[0].data.event);
      expect(events).toContain('REVIEW_STARTED');
      expect(events).toContain('APPROVED');
    });

    it('skips REVIEW_STARTED when already UNDER_REVIEW', async () => {
      prismaMock.milestoneSubmission.findUnique.mockResolvedValue(
        baseSubmission({
          status: MilestoneSubmissionStatus.UNDER_REVIEW,
          milestone: reviewableSubmission().milestone,
        })
      );
      const review = { id: 'review-1', decision: ReviewDecision.REJECTED };
      prismaMock.milestoneReview.create.mockResolvedValue(review);
      prismaMock.milestoneSubmission.update.mockResolvedValue({});
      prismaMock.milestone.update.mockResolvedValue({});
      prismaMock.milestoneVerificationHistory.create.mockResolvedValue({});

      await MilestoneService.createReview('sub-1', 'verifier-1', {
        decision: ReviewDecision.REJECTED,
        reason: 'No evidence',
      });

      const historyCalls = prismaMock.milestoneVerificationHistory.create.mock.calls;
      const events = historyCalls.map((c: any) => c[0].data.event);
      expect(events).not.toContain('REVIEW_STARTED');
      expect(events).toContain('REJECTED');
    });
  });

  // ─── listAdminSubmissions ──────────────────────────────────────

  describe('listAdminSubmissions', () => {
    it('paginates and filters by status', async () => {
      prismaMock.milestoneSubmission.findMany.mockResolvedValue([baseSubmission()]);
      prismaMock.milestoneSubmission.count.mockResolvedValue(1);

      const result = await MilestoneService.listAdminSubmissions({
        status: MilestoneSubmissionStatus.SUBMITTED,
        page: 1,
        limit: 10,
      });

      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.totalPages).toBe(1);
      expect(prismaMock.milestoneSubmission.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: MilestoneSubmissionStatus.SUBMITTED }),
          skip: 0,
          take: 10,
        })
      );
    });

    it('defaults to page 1 limit 20', async () => {
      prismaMock.milestoneSubmission.findMany.mockResolvedValue([]);
      prismaMock.milestoneSubmission.count.mockResolvedValue(0);

      const result = await MilestoneService.listAdminSubmissions({});
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(20);
    });
  });

  // ─── getVerificationReport ─────────────────────────────────────

  describe('getVerificationReport', () => {
    it('returns approved report with metrics', async () => {
      const milestone = {
        ...baseMilestone(),
        verificationStatus: MilestoneVerificationStatus.VERIFIED,
        submissions: [
          {
            id: 'sub-1',
            status: MilestoneSubmissionStatus.APPROVED,
            reviews: [
              {
                decision: 'APPROVED',
                reviewedAt: new Date(),
                metricsConfirmed: { beneficiariesReached: 150 },
                impactSummary: 'Great impact',
                verifierNotes: 'Well documented',
              },
            ],
          },
        ],
      };
      prismaMock.milestone.findFirst.mockResolvedValue(milestone);

      const result = await MilestoneService.getVerificationReport('milestone-1', 'campaign-1');
      expect(result.verificationStatus).toBe(MilestoneVerificationStatus.VERIFIED);
      expect(result.metricsApproved).toEqual({ beneficiariesReached: 150 });
      expect(result.impactSummary).toBe('Great impact');
    });

    it('throws 404 when milestone not in campaign', async () => {
      prismaMock.milestone.findFirst.mockResolvedValue(null);
      await expect(
        MilestoneService.getVerificationReport('milestone-1', 'wrong-campaign')
      ).rejects.toThrow('Milestone not found in this campaign');
    });
  });
});
