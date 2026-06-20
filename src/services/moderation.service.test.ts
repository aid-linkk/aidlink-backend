import { ModerationService } from './moderation.service';
import {
  CampaignStatus,
  SuspensionSource,
  SuspensionReasonCode,
  AppealStatus,
  FraudReportType,
  OrganizationStatus,
  Role,
} from '@prisma/client';

jest.mock('../config/database', () => {
  const mock: any = {
    __esModule: true,
    default: {
      campaign: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
      suspension: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
      appeal: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      fraudReport: { create: jest.fn(), findMany: jest.fn() },
      donation: { findMany: jest.fn() },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(),
    },
  };
  mock.default.$transaction.mockImplementation(async (cb: any) =>
    typeof cb === 'function' ? cb(mock.default) : Promise.all(cb)
  );
  return mock;
});

jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('./notification.service', () => ({
  NotificationService: {
    sendCampaignSuspendedNotification: jest.fn().mockResolvedValue(undefined),
    sendCampaignReinstatedNotification: jest.fn().mockResolvedValue(undefined),
    sendAppealResolvedNotification: jest.fn().mockResolvedValue(undefined),
    sendDonorFraudSuspensionNotification: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../websocket/socket.server', () => ({
  sendCampaignSuspended: jest.fn(),
  sendCampaignReinstated: jest.fn(),
  sendAppealUpdate: jest.fn(),
}));

jest.mock('../config', () => ({
  config: {
    moderation: {
      autoSuspendEnabled: true,
      fraudReportThreshold: 3,
      fraudReportWindowHours: 24,
      verificationScoreThreshold: 40,
      verificationGraceDays: 7,
      notifyDonorsOnFraudSuspension: true,
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const prismaMock = require('../config/database').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NotificationService } = require('./notification.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ws = require('../websocket/socket.server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require('../config');

const baseCampaign = (overrides: any = {}) => ({
  id: 'campaign-1',
  userId: 'owner-1',
  organizationId: 'org-1',
  title: 'Test Campaign',
  status: CampaignStatus.ACTIVE,
  suspendedAt: null,
  createdAt: new Date('2025-01-01'),
  ...overrides,
});

describe('ModerationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (cb: any) =>
      typeof cb === 'function' ? cb(prismaMock) : Promise.all(cb)
    );
    // Reset flag defaults that individual tests may mutate.
    config.moderation.autoSuspendEnabled = true;
    config.moderation.notifyDonorsOnFraudSuspension = true;
  });

  // ─── reportCampaign ────────────────────────────────────────────

  describe('reportCampaign', () => {
    it('creates a fraud report and writes an audit entry', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.fraudReport.create.mockResolvedValue({ id: 'fr-1', createdAt: new Date() });
      prismaMock.fraudReport.findMany.mockResolvedValue([{ reporterId: 'r1' }]);

      const report = await ModerationService.reportCampaign('campaign-1', 'r1', FraudReportType.SCAM, 'scammy');

      expect(report.id).toBe('fr-1');
      expect(prismaMock.fraudReport.create).toHaveBeenCalled();
      expect(prismaMock.auditLog.create).toHaveBeenCalled();
    });

    it('rejects reporting a missing campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(null);
      await expect(
        ModerationService.reportCampaign('missing', 'r1', FraudReportType.SCAM)
      ).rejects.toThrow('Campaign not found');
    });

    it('auto-suspends when the fraud threshold is reached', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.fraudReport.create.mockResolvedValue({ id: 'fr-1', createdAt: new Date() });
      prismaMock.fraudReport.findMany.mockResolvedValue([
        { reporterId: 'r1' }, { reporterId: 'r2' }, { reporterId: 'r3' },
      ]);
      prismaMock.suspension.create.mockResolvedValue({ id: 's-1' });
      prismaMock.campaign.update.mockResolvedValue(baseCampaign({ status: CampaignStatus.SUSPENDED }));
      prismaMock.donation.findMany.mockResolvedValue([]);

      await ModerationService.reportCampaign('campaign-1', 'r1', FraudReportType.SCAM);

      expect(prismaMock.suspension.create).toHaveBeenCalled();
    });
  });

  // ─── suspendCampaign ───────────────────────────────────────────

  describe('suspendCampaign', () => {
    it('suspends an active campaign and notifies the owner', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.suspension.create.mockResolvedValue({ id: 's-1' });
      prismaMock.campaign.update.mockResolvedValue(
        baseCampaign({ status: CampaignStatus.SUSPENDED, suspendedAt: new Date() })
      );

      const result = await ModerationService.suspendCampaign('campaign-1', {
        source: SuspensionSource.ADMIN,
        actorId: 'admin-1',
        reasonCode: SuspensionReasonCode.MANUAL_REVIEW,
      });

      expect(result.alreadySuspended).toBe(false);
      expect(prismaMock.suspension.create).toHaveBeenCalled();
      expect(prismaMock.campaign.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: CampaignStatus.SUSPENDED }) })
      );
      expect(NotificationService.sendCampaignSuspendedNotification).toHaveBeenCalled();
      expect(ws.sendCampaignSuspended).toHaveBeenCalled();
    });

    it('is idempotent when the campaign is already suspended', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign({ status: CampaignStatus.SUSPENDED }));
      prismaMock.suspension.findFirst.mockResolvedValue({ id: 's-existing' });

      const result = await ModerationService.suspendCampaign('campaign-1', {
        source: SuspensionSource.ADMIN,
        actorId: 'admin-1',
        reasonCode: SuspensionReasonCode.MANUAL_REVIEW,
      });

      expect(result.alreadySuspended).toBe(true);
      expect(result.suspension.id).toBe('s-existing');
      expect(prismaMock.suspension.create).not.toHaveBeenCalled();
      expect(prismaMock.campaign.update).not.toHaveBeenCalled();
    });

    it('returns 404 for a missing campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(null);
      await expect(
        ModerationService.suspendCampaign('missing', {
          source: SuspensionSource.ADMIN,
          actorId: 'admin-1',
          reasonCode: SuspensionReasonCode.OTHER,
        })
      ).rejects.toThrow('Campaign not found');
    });

    it('notifies donors for fraud-related suspensions when enabled', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.suspension.create.mockResolvedValue({ id: 's-1' });
      prismaMock.campaign.update.mockResolvedValue(baseCampaign({ status: CampaignStatus.SUSPENDED }));
      prismaMock.donation.findMany.mockResolvedValue([{ userId: 'd1' }, { userId: 'd2' }]);

      await ModerationService.suspendCampaign('campaign-1', {
        source: SuspensionSource.ADMIN,
        actorId: 'admin-1',
        reasonCode: SuspensionReasonCode.FRAUD_REPORTS,
      });

      expect(NotificationService.sendDonorFraudSuspensionNotification).toHaveBeenCalledTimes(2);
    });

    it('does not notify donors when the flag is disabled', async () => {
      config.moderation.notifyDonorsOnFraudSuspension = false;
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.suspension.create.mockResolvedValue({ id: 's-1' });
      prismaMock.campaign.update.mockResolvedValue(baseCampaign({ status: CampaignStatus.SUSPENDED }));

      await ModerationService.suspendCampaign('campaign-1', {
        source: SuspensionSource.ADMIN,
        actorId: 'admin-1',
        reasonCode: SuspensionReasonCode.FRAUD_REPORTS,
      });

      expect(NotificationService.sendDonorFraudSuspensionNotification).not.toHaveBeenCalled();
    });
  });

  // ─── reinstateCampaign ─────────────────────────────────────────

  describe('reinstateCampaign', () => {
    it('reinstates a suspended campaign and lifts active suspensions', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign({ status: CampaignStatus.SUSPENDED }));
      prismaMock.suspension.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.campaign.update.mockResolvedValue(baseCampaign({ status: CampaignStatus.ACTIVE }));

      const result = await ModerationService.reinstateCampaign('campaign-1', 'admin-1', 'looks fine');

      expect(result.status).toBe(CampaignStatus.ACTIVE);
      expect(prismaMock.suspension.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { campaignId: 'campaign-1', active: true } })
      );
      expect(NotificationService.sendCampaignReinstatedNotification).toHaveBeenCalled();
      expect(ws.sendCampaignReinstated).toHaveBeenCalled();
    });

    it('rejects reinstating a campaign that is not suspended', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign({ status: CampaignStatus.ACTIVE }));
      await expect(
        ModerationService.reinstateCampaign('campaign-1', 'admin-1')
      ).rejects.toThrow('Campaign is not suspended');
    });

    it('returns 404 for a missing campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(null);
      await expect(
        ModerationService.reinstateCampaign('missing', 'admin-1')
      ).rejects.toThrow('Campaign not found');
    });
  });

  // ─── submitAppeal ──────────────────────────────────────────────

  describe('submitAppeal', () => {
    const suspendedCampaign = () => baseCampaign({ status: CampaignStatus.SUSPENDED });

    it('creates an appeal for the owner of a suspended campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(suspendedCampaign());
      prismaMock.suspension.findFirst.mockResolvedValue({ id: 's-1' });
      prismaMock.appeal.findFirst.mockResolvedValue(null);
      prismaMock.appeal.create.mockResolvedValue({ id: 'a-1', status: AppealStatus.OPEN });

      const appeal = await ModerationService.submitAppeal('campaign-1', 'owner-1', 'Please reconsider my campaign');

      expect(appeal.id).toBe('a-1');
      expect(prismaMock.appeal.create).toHaveBeenCalled();
    });

    it('rejects a too-short message', async () => {
      await expect(
        ModerationService.submitAppeal('campaign-1', 'owner-1', 'short')
      ).rejects.toThrow('Appeal message must be at least 10 characters long');
    });

    it('rejects a non-owner', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(suspendedCampaign());
      await expect(
        ModerationService.submitAppeal('campaign-1', 'someone-else', 'Please reconsider this')
      ).rejects.toThrow('Only the campaign owner can submit an appeal');
    });

    it('rejects when the campaign is not suspended', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign({ status: CampaignStatus.ACTIVE }));
      await expect(
        ModerationService.submitAppeal('campaign-1', 'owner-1', 'Please reconsider this')
      ).rejects.toThrow('Only suspended campaigns can be appealed');
    });

    it('rejects when an appeal is already in progress', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(suspendedCampaign());
      prismaMock.suspension.findFirst.mockResolvedValue({ id: 's-1' });
      prismaMock.appeal.findFirst.mockResolvedValue({ id: 'a-existing', status: AppealStatus.OPEN });

      await expect(
        ModerationService.submitAppeal('campaign-1', 'owner-1', 'Please reconsider this')
      ).rejects.toThrow('An appeal is already in progress for this suspension');
    });
  });

  // ─── getCampaignAppeals ────────────────────────────────────────

  describe('getCampaignAppeals', () => {
    it('returns appeals for the owner', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.appeal.findMany.mockResolvedValue([{ id: 'a-1' }]);

      const result = await ModerationService.getCampaignAppeals('campaign-1', 'owner-1', Role.DONOR);
      expect(result).toHaveLength(1);
    });

    it('allows an admin who is not the owner', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.appeal.findMany.mockResolvedValue([]);

      await expect(
        ModerationService.getCampaignAppeals('campaign-1', 'admin-1', Role.ADMIN)
      ).resolves.toEqual([]);
    });

    it('rejects an unrelated non-admin user', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      await expect(
        ModerationService.getCampaignAppeals('campaign-1', 'stranger', Role.DONOR)
      ).rejects.toThrow('You do not have permission to view these appeals');
    });
  });

  // ─── resolveAppeal ─────────────────────────────────────────────

  describe('resolveAppeal', () => {
    const openAppeal = (overrides: any = {}) => ({
      id: 'a-1',
      campaignId: 'campaign-1',
      campaignOwnerId: 'owner-1',
      status: AppealStatus.OPEN,
      campaign: { id: 'campaign-1', title: 'Test Campaign', status: CampaignStatus.SUSPENDED, userId: 'owner-1' },
      ...overrides,
    });

    it('approves an appeal and reinstates the campaign', async () => {
      prismaMock.appeal.findUnique.mockResolvedValue(openAppeal());
      prismaMock.appeal.update.mockResolvedValue({ id: 'a-1', status: AppealStatus.APPROVED });
      // reinstateCampaign internals:
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign({ status: CampaignStatus.SUSPENDED }));
      prismaMock.suspension.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.campaign.update.mockResolvedValue(baseCampaign({ status: CampaignStatus.ACTIVE }));

      const result = await ModerationService.resolveAppeal('a-1', 'APPROVE', 'admin-1', 'approved');

      expect(result.status).toBe(AppealStatus.APPROVED);
      expect(prismaMock.suspension.updateMany).toHaveBeenCalled();
      expect(NotificationService.sendAppealResolvedNotification).toHaveBeenCalledWith(
        'owner-1', 'Test Campaign', 'APPROVED', 'approved'
      );
    });

    it('denies an appeal without reinstating', async () => {
      prismaMock.appeal.findUnique.mockResolvedValue(openAppeal());
      prismaMock.appeal.update.mockResolvedValue({ id: 'a-1', status: AppealStatus.DENIED });

      const result = await ModerationService.resolveAppeal('a-1', 'DENY', 'admin-1', 'nope');

      expect(result.status).toBe(AppealStatus.DENIED);
      expect(prismaMock.suspension.updateMany).not.toHaveBeenCalled();
      expect(NotificationService.sendAppealResolvedNotification).toHaveBeenCalledWith(
        'owner-1', 'Test Campaign', 'DENIED', 'nope'
      );
    });

    it('rejects resolving an already-resolved appeal', async () => {
      prismaMock.appeal.findUnique.mockResolvedValue(openAppeal({ status: AppealStatus.APPROVED }));
      await expect(
        ModerationService.resolveAppeal('a-1', 'DENY', 'admin-1')
      ).rejects.toThrow('Appeal has already been resolved');
    });

    it('returns 404 for a missing appeal', async () => {
      prismaMock.appeal.findUnique.mockResolvedValue(null);
      await expect(
        ModerationService.resolveAppeal('missing', 'APPROVE', 'admin-1')
      ).rejects.toThrow('Appeal not found');
    });
  });

  // ─── countIndependentFraudReports ──────────────────────────────

  describe('countIndependentFraudReports', () => {
    it('collapses duplicate reporters and counts anonymous reports individually', async () => {
      prismaMock.fraudReport.findMany.mockResolvedValue([
        { reporterId: 'r1' }, { reporterId: 'r1' }, { reporterId: 'r2' },
        { reporterId: null }, { reporterId: null },
      ]);
      // distinct: r1, r2 (2) + 2 anonymous = 4
      const count = await ModerationService.countIndependentFraudReports('campaign-1');
      expect(count).toBe(4);
    });
  });

  // ─── evaluateFraudReports ──────────────────────────────────────

  describe('evaluateFraudReports', () => {
    it('does nothing when auto-suspension is disabled', async () => {
      config.moderation.autoSuspendEnabled = false;
      const result = await ModerationService.evaluateFraudReports('campaign-1');
      expect(result).toBe(false);
      expect(prismaMock.campaign.findUnique).not.toHaveBeenCalled();
    });

    it('suspends when independent reports meet the threshold', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.fraudReport.findMany.mockResolvedValue([
        { reporterId: 'r1' }, { reporterId: 'r2' }, { reporterId: 'r3' },
      ]);
      prismaMock.suspension.create.mockResolvedValue({ id: 's-1' });
      prismaMock.campaign.update.mockResolvedValue(baseCampaign({ status: CampaignStatus.SUSPENDED }));
      prismaMock.donation.findMany.mockResolvedValue([]);

      const result = await ModerationService.evaluateFraudReports('campaign-1');
      expect(result).toBe(true);
    });

    it('does not suspend below the threshold', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(baseCampaign());
      prismaMock.fraudReport.findMany.mockResolvedValue([{ reporterId: 'r1' }]);

      const result = await ModerationService.evaluateFraudReports('campaign-1');
      expect(result).toBe(false);
      expect(prismaMock.suspension.create).not.toHaveBeenCalled();
    });
  });

  // ─── evaluateVerification ──────────────────────────────────────

  describe('evaluateVerification', () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

    it('suspends a long-running campaign with low verification', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(
        baseCampaign({ createdAt: oldDate, organization: { status: OrganizationStatus.PENDING } })
      );
      prismaMock.suspension.create.mockResolvedValue({ id: 's-1' });
      prismaMock.campaign.update.mockResolvedValue(baseCampaign({ status: CampaignStatus.SUSPENDED }));
      prismaMock.donation.findMany.mockResolvedValue([]);

      const result = await ModerationService.evaluateVerification('campaign-1');
      expect(result).toBe(true);
    });

    it('respects the grace period for recently created campaigns', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(
        baseCampaign({ createdAt: new Date(), organization: { status: OrganizationStatus.PENDING } })
      );
      const result = await ModerationService.evaluateVerification('campaign-1');
      expect(result).toBe(false);
      expect(prismaMock.suspension.create).not.toHaveBeenCalled();
    });

    it('does not suspend a sufficiently verified organization', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(
        baseCampaign({ createdAt: oldDate, organization: { status: OrganizationStatus.APPROVED } })
      );
      const result = await ModerationService.evaluateVerification('campaign-1');
      expect(result).toBe(false);
    });
  });

  // ─── getModerationView ─────────────────────────────────────────

  describe('getModerationView', () => {
    it('returns no summary for a non-suspended campaign', async () => {
      const result = await ModerationService.getModerationView(baseCampaign());
      expect(result).toEqual({ suspensionSummary: null, canAppeal: false });
    });

    it('returns a summary and allows appeal when none is open', async () => {
      prismaMock.suspension.findFirst.mockResolvedValue({
        reasonCode: SuspensionReasonCode.FRAUD_REPORTS,
        reasonText: 'too many reports',
        source: SuspensionSource.AUTO,
        createdAt: new Date('2025-02-01'),
        appeals: [],
      });

      const result = await ModerationService.getModerationView(
        baseCampaign({ status: CampaignStatus.SUSPENDED, suspendedAt: new Date('2025-02-01') })
      );

      expect(result.canAppeal).toBe(true);
      expect(result.suspensionSummary.reasonCode).toBe(SuspensionReasonCode.FRAUD_REPORTS);
      expect(result.suspensionSummary.hasOpenAppeal).toBe(false);
    });

    it('disallows appeal when one is already open', async () => {
      prismaMock.suspension.findFirst.mockResolvedValue({
        reasonCode: SuspensionReasonCode.MANUAL_REVIEW,
        reasonText: null,
        source: SuspensionSource.ADMIN,
        createdAt: new Date('2025-02-01'),
        appeals: [{ id: 'a-1', status: AppealStatus.OPEN }],
      });

      const result = await ModerationService.getModerationView(
        baseCampaign({ status: CampaignStatus.SUSPENDED })
      );

      expect(result.canAppeal).toBe(false);
      expect(result.suspensionSummary.appealStatus).toBe(AppealStatus.OPEN);
    });
  });
});
