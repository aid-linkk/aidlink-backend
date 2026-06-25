/**
 * Integration test for the milestone verification lifecycle:
 *   create draft → submit → revision requested → resubmit → approved
 *   and the alternate rejection flow.
 *
 * Runs the real MilestoneService against a stateful in-memory Prisma fake
 * so the full orchestration (state transitions, audit trail, notifications,
 * WebSocket broadcasts) is exercised without a live database.
 */

import {
  MilestoneSubmissionStatus,
  MilestoneVerificationStatus,
  MilestoneVerificationEvent,
  ReviewDecision,
  Role,
} from '@prisma/client';

// ─── Stateful in-memory store ──────────────────────────────────

const store: any = {
  campaigns: new Map<string, any>(),
  milestones: new Map<string, any>(),
  submissions: new Map<string, any>(),
  reviews: [] as any[],
  history: [] as any[],
  auditLogs: [] as any[],
  users: new Map<string, any>(),
  notifications: [] as any[],
};

let idSeq = 0;
const nextId = (prefix: string) => `${prefix}-${++idSeq}`;

// Reset between tests
function resetStore() {
  store.campaigns.clear();
  store.milestones.clear();
  store.submissions.clear();
  store.reviews.length = 0;
  store.history.length = 0;
  store.auditLogs.length = 0;
  store.users.clear();
  store.notifications.length = 0;
  idSeq = 0;
}

// ─── Prisma fake ───────────────────────────────────────────────

const prismaFake: any = {
  campaign: {
    findUnique: jest.fn(async ({ where, include }: any) => {
      const c = store.campaigns.get(where.id);
      if (!c) return null;
      const result = { ...c };
      if (include?.organization) result.organization = { id: c.organizationId };
      return result;
    }),
  },
  milestone: {
    findFirst: jest.fn(async ({ where, include }: any) => {
      const m = [...store.milestones.values()].find(
        (m) => m.id === where.id && m.campaignId === where.campaignId
      );
      if (!m) return null;
      const result: any = { ...m };
      if (include?.campaign) {
        result.campaign = { ...store.campaigns.get(m.campaignId) };
      }
      if (include?.submissions) {
        const statusFilter: string[] | undefined = include.submissions.where?.status?.in;
        let subs = [...store.submissions.values()].filter((s) => {
          if (s.milestoneId !== m.id) return false;
          if (statusFilter && !statusFilter.includes(s.status)) return false;
          return true;
        });
        subs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (include.submissions.take) subs = subs.slice(0, include.submissions.take);
        result.submissions = subs.map((s) => ({
          ...s,
          ...(include.submissions.include?.reviews && {
            reviews: store.reviews
              .filter((r: any) => r.submissionId === s.id)
              .filter((r: any) => {
                const dFilter = include.submissions.include.reviews.where?.decision;
                return !dFilter || r.decision === dFilter;
              })
              .sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime())
              .slice(0, include.submissions.include.reviews.take ?? undefined),
          }),
        }));
      }
      return result;
    }),
    findUnique: jest.fn(async ({ where, include }: any) => {
      const m = store.milestones.get(where.id);
      if (!m) return null;
      if (include?.submissions) {
        const subs = [...store.submissions.values()].filter((s) => s.milestoneId === m.id);
        subs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const latestSubs = subs.slice(0, include.submissions.take ?? undefined).map((s) => ({
          ...s,
          reviews: store.reviews
            .filter((r) => r.submissionId === s.id)
            .sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, include.submissions.include?.reviews?.take ?? undefined),
          history: store.history
            .filter((h) => h.submissionId === s.id)
            .sort((a: any, b: any) => a.timestamp.getTime() - b.timestamp.getTime()),
        }));
        return { ...m, submissions: latestSubs };
      }
      return { ...m };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const m = store.milestones.get(where.id);
      Object.assign(m, data);
      return { ...m };
    }),
  },
  milestoneSubmission: {
    create: jest.fn(async ({ data }: any) => {
      const s = {
        id: nextId('sub'),
        createdAt: new Date(),
        updatedAt: new Date(),
        submittedAt: null,
        submissionNotes: null,
        ...data,
      };
      store.submissions.set(s.id, s);
      return { ...s };
    }),
    findFirst: jest.fn(async ({ where }: any) => {
      const subs = [...store.submissions.values()];
      return (
        subs.find((s) => {
          const milestoneMatch = !where.milestoneId || s.milestoneId === where.milestoneId;
          const statusMatch =
            !where.status ||
            (where.status.in ? where.status.in.includes(s.status) : s.status === where.status);
          return milestoneMatch && statusMatch;
        }) ?? null
      );
    }),
    findUnique: jest.fn(async ({ where, include }: any) => {
      const s = store.submissions.get(where.id);
      if (!s) return null;
      const result = { ...s };
      if (include?.milestone) {
        const m = store.milestones.get(s.milestoneId);
        result.milestone = { ...m };
        if (include.milestone.include?.campaign) {
          const c = store.campaigns.get(m.campaignId);
          result.milestone.campaign = { ...c };
          if (include.milestone.include.campaign.include?.organization) {
            result.milestone.campaign.organization = { id: c.organizationId };
          }
          if (include.milestone.include.campaign.include?.user) {
            result.milestone.campaign.user = store.users.get(c.userId);
          }
        }
      }
      if (include?.reviews) {
        result.reviews = store.reviews
          .filter((r: any) => r.submissionId === s.id)
          .sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      if (include?.history) {
        result.history = store.history
          .filter((h: any) => h.submissionId === s.id)
          .sort((a: any, b: any) => a.timestamp.getTime() - b.timestamp.getTime());
      }
      return result;
    }),
    findMany: jest.fn(async ({ where, include, orderBy, skip, take }: any) => {
      let subs = [...store.submissions.values()].filter((s) => {
        if (where.milestoneId && s.milestoneId !== where.milestoneId) return false;
        if (where.campaignId && s.campaignId !== where.campaignId) return false;
        if (where.status?.in && !where.status.in.includes(s.status)) return false;
        if (where.status && !where.status.in && s.status !== where.status) return false;
        if (where.submittedAt?.gte && s.submittedAt < where.submittedAt.gte) return false;
        if (where.submittedAt?.lte && s.submittedAt > where.submittedAt.lte) return false;
        return true;
      });

      subs.sort((a, b) => {
        const key = orderBy?.submittedAt ?? orderBy?.createdAt;
        if (!key) return 0;
        const dir = key === 'desc' ? -1 : 1;
        const aDate = a.submittedAt ?? a.createdAt;
        const bDate = b.submittedAt ?? b.createdAt;
        return dir * (aDate.getTime() - bDate.getTime());
      });

      if (skip) subs = subs.slice(skip);
      if (take) subs = subs.slice(0, take);

      return subs.map((s) => ({
        ...s,
        ...(include?.reviews && {
          reviews: store.reviews
            .filter((r: any) => r.submissionId === s.id)
            .sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, include.reviews.take ?? undefined),
        }),
        ...(include?.milestone && {
          milestone: { ...store.milestones.get(s.milestoneId) },
        }),
        ...(include?.history && {
          history: store.history
            .filter((h: any) => h.submissionId === s.id)
            .sort((a: any, b: any) => a.timestamp.getTime() - b.timestamp.getTime())
            .slice(0, include.history.take ?? undefined),
        }),
      }));
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const s = store.submissions.get(where.id);
      Object.assign(s, data, { updatedAt: new Date() });
      return { ...s };
    }),
    count: jest.fn(async ({ where }: any) => {
      return [...store.submissions.values()].filter((s) => {
        if (where.status && s.status !== where.status) return false;
        if (where.campaignId && s.campaignId !== where.campaignId) return false;
        return true;
      }).length;
    }),
  },
  milestoneReview: {
    create: jest.fn(async ({ data }: any) => {
      const r = { id: nextId('review'), createdAt: new Date(), reviewedAt: new Date(), ...data };
      store.reviews.push(r);
      return { ...r };
    }),
    findMany: jest.fn(async ({ where }: any) =>
      store.reviews.filter((r: any) => r.submissionId === where.submissionId)
    ),
  },
  milestoneVerificationHistory: {
    create: jest.fn(async ({ data }: any) => {
      const h = { id: nextId('hist'), timestamp: new Date(), ...data };
      store.history.push(h);
      return { ...h };
    }),
  },
  auditLog: {
    create: jest.fn(async ({ data }: any) => {
      const log = { id: nextId('audit'), createdAt: new Date(), ...data };
      store.auditLogs.push(log);
      return log;
    }),
  },
  user: {
    findMany: jest.fn(async ({ where }: any) => {
      return [...store.users.values()].filter((u) => {
        if (where.role?.in && !where.role.in.includes(u.role)) return false;
        if (where.status && u.status !== where.status) return false;
        return true;
      });
    }),
  },
  $transaction: jest.fn(async (cb: any) =>
    typeof cb === 'function' ? cb(prismaFake) : Promise.all(cb)
  ),
};

// ─── Mocks ─────────────────────────────────────────────────────

jest.mock('../../src/config/database', () => ({ __esModule: true, default: prismaFake }));

jest.mock('../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const notifMock = {
  sendMilestoneSubmissionReceivedNotification: jest.fn().mockResolvedValue(undefined),
  sendMilestoneApprovedNotification: jest.fn().mockResolvedValue(undefined),
  sendMilestoneRejectedNotification: jest.fn().mockResolvedValue(undefined),
  sendMilestoneRevisionRequestedNotification: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../../src/services/notification.service', () => ({
  NotificationService: notifMock,
}));

const broadcastToUserMock = jest.fn();
const broadcastToCampaignMock = jest.fn();

jest.mock('../../src/websocket/socket.server', () => ({
  broadcastToUser: broadcastToUserMock,
  broadcastToCampaign: broadcastToCampaignMock,
}));

// ─── Import service after mocks ────────────────────────────────

import { MilestoneService } from '../../src/services/milestone.service';

// ─── Test data helpers ─────────────────────────────────────────

function seedOrg() {
  store.users.set('user-org', {
    id: 'user-org',
    email: 'org@test.com',
    role: Role.ORGANIZATION,
    status: 'ACTIVE',
  });
  store.users.set('verifier-1', {
    id: 'verifier-1',
    email: 'verifier@test.com',
    role: Role.VERIFIER,
    status: 'ACTIVE',
  });
  store.campaigns.set('campaign-1', {
    id: 'campaign-1',
    userId: 'user-org',
    organizationId: 'org-1',
    title: 'Aid Campaign',
    organization: { id: 'org-1' },
  });
  store.milestones.set('milestone-1', {
    id: 'milestone-1',
    campaignId: 'campaign-1',
    title: 'Distribute 300 food kits',
    verificationStatus: MilestoneVerificationStatus.PENDING_SUBMISSION,
    currentSubmissionId: null,
    currentReviewId: null,
  });
}

const goodSubmissionData = {
  description: 'We distributed 300 food kits across 5 villages during March 2026.',
  evidenceUrls: ['https://storage.aidlink.io/photo1.jpg', 'https://storage.aidlink.io/report.pdf'],
  metricsData: { beneficiariesReached: 300, villagesCovered: 5 },
};

// ─── Tests ─────────────────────────────────────────────────────

describe('Milestone verification flow (integration)', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
    seedOrg();
  });

  // ─── Happy path: full approval ──────────────────────────────

  describe('full approval flow', () => {
    it('creates a DRAFT submission', async () => {
      const sub = await MilestoneService.createSubmission(
        'campaign-1',
        'milestone-1',
        'user-org',
        goodSubmissionData
      );

      expect(sub.status).toBe(MilestoneSubmissionStatus.DRAFT);
      expect(sub.milestoneId).toBe('milestone-1');
      expect(sub.organizationId).toBe('org-1');

      const milestone = store.milestones.get('milestone-1');
      expect(milestone.currentSubmissionId).toBe(sub.id);
    });

    it('DRAFT → SUBMITTED notifies verifiers and records history', async () => {
      const sub = await MilestoneService.createSubmission(
        'campaign-1', 'milestone-1', 'user-org', goodSubmissionData
      );

      const updated = await MilestoneService.submitForReview(sub.id, 'user-org');

      expect(updated.status).toBe(MilestoneSubmissionStatus.SUBMITTED);
      expect(updated.submittedAt).toBeTruthy();

      const milestone = store.milestones.get('milestone-1');
      expect(milestone.verificationStatus).toBe(MilestoneVerificationStatus.SUBMITTED);

      const submittedEvent = store.history.find(
        (h: any) => h.submissionId === sub.id && h.event === MilestoneVerificationEvent.SUBMITTED
      );
      expect(submittedEvent).toBeTruthy();
      expect(submittedEvent.actor).toBe('user-org');

      expect(notifMock.sendMilestoneSubmissionReceivedNotification).toHaveBeenCalledWith(
        'verifier-1',
        'Aid Campaign',
        'Distribute 300 food kits',
        sub.id
      );

      expect(broadcastToCampaignMock).toHaveBeenCalledWith(
        'campaign-1',
        'milestone:submitted',
        expect.objectContaining({ submissionId: sub.id })
      );

      const auditEntry = store.auditLogs.find((a: any) => a.action === 'MILESTONE_SUBMITTED');
      expect(auditEntry).toBeTruthy();
      expect(auditEntry.userId).toBe('user-org');
    });

    it('SUBMITTED → UNDER_REVIEW → APPROVED marks milestone VERIFIED', async () => {
      const sub = await MilestoneService.createSubmission(
        'campaign-1', 'milestone-1', 'user-org', goodSubmissionData
      );
      await MilestoneService.submitForReview(sub.id, 'user-org');

      const review = await MilestoneService.createReview(sub.id, 'verifier-1', {
        decision: ReviewDecision.APPROVED,
        impactSummary: '300 beneficiaries confirmed via distribution records.',
        metricsConfirmed: { beneficiariesReached: 300 },
      });

      expect(review.decision).toBe(ReviewDecision.APPROVED);

      const updatedSub = store.submissions.get(sub.id);
      expect(updatedSub.status).toBe(MilestoneSubmissionStatus.APPROVED);

      const milestone = store.milestones.get('milestone-1');
      expect(milestone.verificationStatus).toBe(MilestoneVerificationStatus.VERIFIED);
      expect(milestone.achieved).toBe(true);
      expect(milestone.achievedAt).toBeTruthy();
      expect(milestone.currentReviewId).toBe(review.id);

      const reviewStarted = store.history.find(
        (h: any) => h.submissionId === sub.id && h.event === MilestoneVerificationEvent.REVIEW_STARTED
      );
      expect(reviewStarted).toBeTruthy();
      expect(reviewStarted.actor).toBe('verifier-1');

      const approved = store.history.find(
        (h: any) => h.submissionId === sub.id && h.event === MilestoneVerificationEvent.APPROVED
      );
      expect(approved).toBeTruthy();

      expect(notifMock.sendMilestoneApprovedNotification).toHaveBeenCalledWith(
        'user-org',
        'Distribute 300 food kits',
        '300 beneficiaries confirmed via distribution records.'
      );

      expect(broadcastToUserMock).toHaveBeenCalledWith(
        'user-org',
        'milestone:reviewed',
        expect.objectContaining({ decision: ReviewDecision.APPROVED })
      );

      const auditEntry = store.auditLogs.find((a: any) => a.action === 'MILESTONE_APPROVED');
      expect(auditEntry).toBeTruthy();
      expect(auditEntry.userId).toBe('verifier-1');
    });
  });

  // ─── Revision loop ──────────────────────────────────────────

  describe('revision loop', () => {
    it('SUBMITTED → REVISION_REQUESTED → RESUBMITTED → APPROVED', async () => {
      const sub = await MilestoneService.createSubmission(
        'campaign-1', 'milestone-1', 'user-org', goodSubmissionData
      );
      await MilestoneService.submitForReview(sub.id, 'user-org');

      await MilestoneService.createReview(sub.id, 'verifier-1', {
        decision: ReviewDecision.REVISION_REQUESTED,
        reason: 'Please provide GPS coordinates for each distribution point.',
      });

      let updatedSub = store.submissions.get(sub.id);
      expect(updatedSub.status).toBe(MilestoneSubmissionStatus.REVISION_REQUESTED);

      const revisionHistory = store.history.find(
        (h: any) => h.submissionId === sub.id && h.event === MilestoneVerificationEvent.REVISION_REQUESTED
      );
      expect(revisionHistory).toBeTruthy();

      expect(notifMock.sendMilestoneRevisionRequestedNotification).toHaveBeenCalledWith(
        'user-org',
        'Distribute 300 food kits',
        'Please provide GPS coordinates for each distribution point.'
      );

      await MilestoneService.updateSubmission(sub.id, 'user-org', {
        evidenceUrls: [
          ...goodSubmissionData.evidenceUrls,
          'https://storage.aidlink.io/gps-coords.json',
        ],
      });

      const resubmitted = await MilestoneService.submitForReview(sub.id, 'user-org');
      expect(resubmitted.status).toBe(MilestoneSubmissionStatus.SUBMITTED);

      const resubmittedHistory = store.history.find(
        (h: any) => h.submissionId === sub.id && h.event === MilestoneVerificationEvent.RESUBMITTED
      );
      expect(resubmittedHistory).toBeTruthy();

      jest.clearAllMocks();

      await MilestoneService.createReview(sub.id, 'verifier-1', {
        decision: ReviewDecision.APPROVED,
        impactSummary: 'GPS evidence confirmed.',
      });

      updatedSub = store.submissions.get(sub.id);
      expect(updatedSub.status).toBe(MilestoneSubmissionStatus.APPROVED);

      const milestone = store.milestones.get('milestone-1');
      expect(milestone.verificationStatus).toBe(MilestoneVerificationStatus.VERIFIED);

      const historyEvents = store.history
        .filter((h: any) => h.submissionId === sub.id)
        .map((h: any) => h.event);

      expect(historyEvents).toContain(MilestoneVerificationEvent.SUBMITTED);
      expect(historyEvents).toContain(MilestoneVerificationEvent.REVIEW_STARTED);
      expect(historyEvents).toContain(MilestoneVerificationEvent.REVISION_REQUESTED);
      expect(historyEvents).toContain(MilestoneVerificationEvent.RESUBMITTED);
      expect(historyEvents).toContain(MilestoneVerificationEvent.APPROVED);
    });
  });

  // ─── Rejection flow ─────────────────────────────────────────

  describe('rejection flow', () => {
    it('SUBMITTED → REJECTED records reason and notifies org', async () => {
      const sub = await MilestoneService.createSubmission(
        'campaign-1', 'milestone-1', 'user-org', goodSubmissionData
      );
      await MilestoneService.submitForReview(sub.id, 'user-org');

      const review = await MilestoneService.createReview(sub.id, 'verifier-1', {
        decision: ReviewDecision.REJECTED,
        reason: 'Evidence does not match reported dates.',
      });

      expect(review.decision).toBe(ReviewDecision.REJECTED);
      expect(review.reason).toBe('Evidence does not match reported dates.');

      const updatedSub = store.submissions.get(sub.id);
      expect(updatedSub.status).toBe(MilestoneSubmissionStatus.REJECTED);

      const milestone = store.milestones.get('milestone-1');
      expect(milestone.verificationStatus).toBe(MilestoneVerificationStatus.REJECTED);
      expect(milestone.achieved).toBeUndefined();

      expect(notifMock.sendMilestoneRejectedNotification).toHaveBeenCalledWith(
        'user-org',
        'Distribute 300 food kits',
        'Evidence does not match reported dates.'
      );

      const auditEntry = store.auditLogs.find((a: any) => a.action === 'MILESTONE_REJECTED');
      expect(auditEntry).toBeTruthy();
      expect(auditEntry.metadata.reason).toBe('Evidence does not match reported dates.');
    });
  });

  // ─── Guard rails ────────────────────────────────────────────

  describe('guard rails', () => {
    it('blocks duplicate active submission', async () => {
      await MilestoneService.createSubmission(
        'campaign-1', 'milestone-1', 'user-org', goodSubmissionData
      );
      const first = store.submissions.get('sub-1');
      first.status = MilestoneSubmissionStatus.SUBMITTED;

      await expect(
        MilestoneService.createSubmission(
          'campaign-1', 'milestone-1', 'user-org', goodSubmissionData
        )
      ).rejects.toThrow('An active submission already exists');
    });

    it('blocks submitting an already-submitted submission', async () => {
      const sub = await MilestoneService.createSubmission(
        'campaign-1', 'milestone-1', 'user-org', goodSubmissionData
      );
      await MilestoneService.submitForReview(sub.id, 'user-org');

      await expect(MilestoneService.submitForReview(sub.id, 'user-org')).rejects.toThrow(
        'Cannot submit a submission with status SUBMITTED'
      );
    });

    it('blocks non-owner from submitting', async () => {
      const sub = await MilestoneService.createSubmission(
        'campaign-1', 'milestone-1', 'user-org', goodSubmissionData
      );

      await expect(MilestoneService.submitForReview(sub.id, 'intruder-99')).rejects.toThrow(
        'You do not own this submission'
      );
    });

    it('blocks reviewing a DRAFT submission', async () => {
      const sub = await MilestoneService.createSubmission(
        'campaign-1', 'milestone-1', 'user-org', goodSubmissionData
      );

      await expect(
        MilestoneService.createReview(sub.id, 'verifier-1', {
          decision: ReviewDecision.APPROVED,
        })
      ).rejects.toThrow('Cannot review a submission with status DRAFT');
    });

    it('blocks editing a SUBMITTED submission', async () => {
      const sub = await MilestoneService.createSubmission(
        'campaign-1', 'milestone-1', 'user-org', goodSubmissionData
      );
      await MilestoneService.submitForReview(sub.id, 'user-org');

      await expect(
        MilestoneService.updateSubmission(sub.id, 'user-org', { description: 'sneaky edit' })
      ).rejects.toThrow('Cannot edit a submission with status SUBMITTED');
    });

    it('blocks non-owner from editing', async () => {
      const sub = await MilestoneService.createSubmission(
        'campaign-1', 'milestone-1', 'user-org', goodSubmissionData
      );

      await expect(
        MilestoneService.updateSubmission(sub.id, 'intruder-99', { description: 'x' })
      ).rejects.toThrow('You do not own this submission');
    });

    it('second reviewer skips REVIEW_STARTED (already UNDER_REVIEW)', async () => {
      const sub = await MilestoneService.createSubmission(
        'campaign-1', 'milestone-1', 'user-org', goodSubmissionData
      );
      await MilestoneService.submitForReview(sub.id, 'user-org');

      store.submissions.get(sub.id).status = MilestoneSubmissionStatus.UNDER_REVIEW;

      await MilestoneService.createReview(sub.id, 'verifier-1', {
        decision: ReviewDecision.APPROVED,
      });

      const reviewStartedEvents = store.history.filter(
        (h: any) => h.submissionId === sub.id && h.event === MilestoneVerificationEvent.REVIEW_STARTED
      );
      expect(reviewStartedEvents).toHaveLength(0);
    });
  });

  // ─── Audit trail completeness ──────────────────────────────

  describe('audit trail', () => {
    it('full approval flow produces complete ordered history', async () => {
      const sub = await MilestoneService.createSubmission(
        'campaign-1', 'milestone-1', 'user-org', goodSubmissionData
      );
      await MilestoneService.submitForReview(sub.id, 'user-org');
      await MilestoneService.createReview(sub.id, 'verifier-1', {
        decision: ReviewDecision.APPROVED,
        impactSummary: 'All good',
      });

      const events = store.history
        .filter((h: any) => h.submissionId === sub.id)
        .sort((a: any, b: any) => a.timestamp.getTime() - b.timestamp.getTime())
        .map((h: any) => h.event);

      expect(events).toEqual([
        MilestoneVerificationEvent.SUBMITTED,
        MilestoneVerificationEvent.REVIEW_STARTED,
        MilestoneVerificationEvent.APPROVED,
      ]);

      const auditActions = store.auditLogs.map((a: any) => a.action);
      expect(auditActions).toContain('MILESTONE_SUBMITTED');
      expect(auditActions).toContain('MILESTONE_APPROVED');
    });

    it('getMilestoneVerificationStatus returns full history', async () => {
      const sub = await MilestoneService.createSubmission(
        'campaign-1', 'milestone-1', 'user-org', goodSubmissionData
      );
      await MilestoneService.submitForReview(sub.id, 'user-org');
      await MilestoneService.createReview(sub.id, 'verifier-1', {
        decision: ReviewDecision.APPROVED,
      });

      const status = await MilestoneService.getMilestoneVerificationStatus('milestone-1');

      expect(status.verificationStatus).toBe(MilestoneVerificationStatus.VERIFIED);
      expect(status.submissions).toHaveLength(1);
      expect(status.submissions[0].history).toHaveLength(3);
    });
  });

  // ─── Query methods ─────────────────────────────────────────

  describe('query methods', () => {
    it('listAdminSubmissions paginates by status', async () => {
      for (let i = 0; i < 3; i++) {
        const milestoneId = `ms-paginate-${i}`;
        store.milestones.set(milestoneId, {
          id: milestoneId,
          campaignId: 'campaign-1',
          title: `Milestone ${i}`,
          verificationStatus: MilestoneVerificationStatus.PENDING_SUBMISSION,
          currentSubmissionId: null,
          currentReviewId: null,
        });
        const sub = await MilestoneService.createSubmission(
          'campaign-1', milestoneId, 'user-org',
          { ...goodSubmissionData, description: `Desc ${i} long enough to pass validation minimum` }
        );
        store.submissions.get(sub.id).status = MilestoneSubmissionStatus.SUBMITTED;
        store.submissions.get(sub.id).submittedAt = new Date();
      }

      const page1 = await MilestoneService.listAdminSubmissions({
        status: MilestoneSubmissionStatus.SUBMITTED,
        page: 1,
        limit: 2,
      });

      expect(page1.data).toHaveLength(2);
      expect(page1.pagination.total).toBe(3);
      expect(page1.pagination.totalPages).toBe(2);
    });

    it('getVerificationReport returns approved metrics', async () => {
      const sub = await MilestoneService.createSubmission(
        'campaign-1', 'milestone-1', 'user-org', goodSubmissionData
      );
      await MilestoneService.submitForReview(sub.id, 'user-org');
      await MilestoneService.createReview(sub.id, 'verifier-1', {
        decision: ReviewDecision.APPROVED,
        metricsConfirmed: { beneficiariesReached: 300 },
        impactSummary: 'Verified by field visit.',
      });

      store.milestones.get('milestone-1').verificationStatus = MilestoneVerificationStatus.VERIFIED;

      const report = await MilestoneService.getVerificationReport('milestone-1', 'campaign-1');

      expect(report.verificationStatus).toBe(MilestoneVerificationStatus.VERIFIED);
      expect(report.metricsApproved).toEqual({ beneficiariesReached: 300 });
      expect(report.impactSummary).toBe('Verified by field visit.');
    });
  });
});
