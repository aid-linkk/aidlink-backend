/**
 * Integration test for the campaign moderation lifecycle:
 *   auto-suspend (fraud threshold) → owner appeal → admin resolve → reinstate.
 *
 * Runs the real ModerationService against a stateful in-memory Prisma fake so
 * the full orchestration (state transitions, idempotency, audit, appeal rules)
 * is exercised without a live database.
 */
import {
  CampaignStatus,
  SuspensionSource,
  SuspensionReasonCode,
  AppealStatus,
  FraudReportType,
  Role,
} from '@prisma/client';

// ─── Stateful in-memory store ──────────────────────────────────
const store: any = {
  campaigns: new Map<string, any>(),
  suspensions: [] as any[],
  appeals: [] as any[],
  fraudReports: [] as any[],
  auditLogs: [] as any[],
  donations: [] as any[],
};

let idSeq = 0;
const nextId = (prefix: string) => `${prefix}-${++idSeq}`;
const byCreatedDesc = (a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime();

const prismaFake: any = {
  __esModule: true,
  default: {
    campaign: {
      findUnique: jest.fn(async ({ where }: any) => {
        const c = store.campaigns.get(where.id);
        return c ? { ...c } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const c = store.campaigns.get(where.id);
        Object.assign(c, data);
        return { ...c };
      }),
      findMany: jest.fn(async () => [...store.campaigns.values()]),
    },
    suspension: {
      create: jest.fn(async ({ data }: any) => {
        const s = { id: nextId('susp'), createdAt: new Date(), appeals: [], ...data };
        store.suspensions.push(s);
        return { ...s };
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const matches = store.suspensions
          .filter((s: any) =>
            (where.campaignId === undefined || s.campaignId === where.campaignId) &&
            (where.active === undefined || s.active === where.active))
          .sort(byCreatedDesc);
        return matches[0] ? { ...matches[0], appeals: [] } : null;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        store.suspensions.forEach((s: any) => {
          if (s.campaignId === where.campaignId && s.active === where.active) {
            Object.assign(s, data);
            count++;
          }
        });
        return { count };
      }),
      findMany: jest.fn(async ({ where }: any) =>
        store.suspensions.filter((s: any) => s.campaignId === where.campaignId).sort(byCreatedDesc)),
    },
    appeal: {
      create: jest.fn(async ({ data }: any) => {
        const a = { id: nextId('appeal'), createdAt: new Date(), updatedAt: new Date(), ...data };
        store.appeals.push(a);
        return { ...a };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const a = store.appeals.find((x: any) => x.id === where.id);
        if (!a) return null;
        return { ...a, campaign: { ...store.campaigns.get(a.campaignId) } };
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const a = store.appeals.find((x: any) =>
          x.suspensionId === where.suspensionId && where.status.in.includes(x.status));
        return a ? { ...a } : null;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        store.appeals.filter((x: any) => !where?.campaignId || x.campaignId === where.campaignId).sort(byCreatedDesc)),
      update: jest.fn(async ({ where, data }: any) => {
        const a = store.appeals.find((x: any) => x.id === where.id);
        Object.assign(a, data, { updatedAt: new Date() });
        return { ...a };
      }),
      count: jest.fn(async () => store.appeals.length),
    },
    fraudReport: {
      create: jest.fn(async ({ data }: any) => {
        const r = { id: nextId('fr'), createdAt: new Date(), ...data };
        store.fraudReports.push(r);
        return { ...r };
      }),
      findMany: jest.fn(async ({ where }: any) =>
        store.fraudReports.filter((r: any) => r.campaignId === where.campaignId)),
    },
    donation: { findMany: jest.fn(async () => [...store.donations]) },
    auditLog: { create: jest.fn(async ({ data }: any) => { store.auditLogs.push(data); return data; }) },
    $transaction: jest.fn(async (cb: any) =>
      typeof cb === 'function' ? cb(prismaFake.default) : Promise.all(cb)),
  },
};

jest.mock('../../src/config/database', () => prismaFake);
jest.mock('../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../src/services/notification.service', () => ({
  NotificationService: {
    sendCampaignSuspendedNotification: jest.fn().mockResolvedValue(undefined),
    sendCampaignReinstatedNotification: jest.fn().mockResolvedValue(undefined),
    sendAppealResolvedNotification: jest.fn().mockResolvedValue(undefined),
    sendDonorFraudSuspensionNotification: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../../src/websocket/socket.server', () => ({
  sendCampaignSuspended: jest.fn(),
  sendCampaignReinstated: jest.fn(),
  sendAppealUpdate: jest.fn(),
}));
jest.mock('../../src/config', () => ({
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
const { ModerationService } = require('../../src/services/moderation.service');

describe('Moderation lifecycle (integration)', () => {
  beforeEach(() => {
    store.campaigns.clear();
    store.suspensions.length = 0;
    store.appeals.length = 0;
    store.fraudReports.length = 0;
    store.auditLogs.length = 0;
    store.donations.length = 0;
    store.campaigns.set('c1', {
      id: 'c1',
      userId: 'owner-1',
      organizationId: 'org-1',
      title: 'Clean Water Drive',
      status: CampaignStatus.ACTIVE,
      suspendedAt: null,
      createdAt: new Date('2025-01-01'),
    });
  });

  it('auto-suspends after the fraud threshold, then handles an approved appeal', async () => {
    // Two reports — below threshold (3): still active.
    await ModerationService.reportCampaign('c1', 'r1', FraudReportType.SCAM);
    await ModerationService.reportCampaign('c1', 'r2', FraudReportType.MISINFORMATION);
    expect(store.campaigns.get('c1').status).toBe(CampaignStatus.ACTIVE);

    // Third independent report crosses the threshold → auto-suspended.
    await ModerationService.reportCampaign('c1', 'r3', FraudReportType.SCAM);
    const campaign = store.campaigns.get('c1');
    expect(campaign.status).toBe(CampaignStatus.SUSPENDED);

    const activeSuspension = store.suspensions.find((s: any) => s.active);
    expect(activeSuspension).toBeDefined();
    expect(activeSuspension.source).toBe(SuspensionSource.AUTO);
    expect(activeSuspension.reasonCode).toBe(SuspensionReasonCode.FRAUD_REPORTS);

    // Owner submits an appeal.
    const appeal = await ModerationService.submitAppeal('c1', 'owner-1', 'This campaign is legitimate, please review.');
    expect(appeal.status).toBe(AppealStatus.OPEN);

    // A second concurrent appeal is rejected.
    await expect(
      ModerationService.submitAppeal('c1', 'owner-1', 'Submitting again while pending.')
    ).rejects.toThrow('An appeal is already in progress for this suspension');

    // Admin approves the appeal → campaign reinstated, suspension lifted.
    const resolved = await ModerationService.resolveAppeal(appeal.id, 'APPROVE', 'admin-1', 'Verified legitimate');
    expect(resolved.status).toBe(AppealStatus.APPROVED);
    expect(store.campaigns.get('c1').status).toBe(CampaignStatus.ACTIVE);
    expect(store.suspensions.find((s: any) => s.id === activeSuspension.id).active).toBe(false);

    // Audit trail recorded each transition (reports + suspend + appeal + resolve + reinstate).
    expect(store.auditLogs.length).toBeGreaterThanOrEqual(5);
  });

  it('keeps admin suspend idempotent and supports a denied appeal', async () => {
    // Manual admin suspension.
    await ModerationService.suspendCampaign('c1', {
      source: SuspensionSource.ADMIN,
      actorId: 'admin-1',
      reasonCode: SuspensionReasonCode.POLICY_VIOLATION,
      reasonText: 'Disallowed content',
    });
    expect(store.campaigns.get('c1').status).toBe(CampaignStatus.SUSPENDED);
    expect(store.suspensions.length).toBe(1);

    // Repeated suspend is a no-op (idempotent) — no duplicate record.
    const repeat = await ModerationService.suspendCampaign('c1', {
      source: SuspensionSource.ADMIN,
      actorId: 'admin-1',
      reasonCode: SuspensionReasonCode.POLICY_VIOLATION,
    });
    expect(repeat.alreadySuspended).toBe(true);
    expect(store.suspensions.length).toBe(1);

    // Owner appeals; admin denies → campaign stays suspended.
    const appeal = await ModerationService.submitAppeal('c1', 'owner-1', 'Please reconsider this decision.');
    await ModerationService.resolveAppeal(appeal.id, 'DENY', 'admin-1', 'Violation confirmed');
    expect(store.campaigns.get('c1').status).toBe(CampaignStatus.SUSPENDED);

    // Owner-only appeal listing is permission checked.
    await expect(
      ModerationService.getCampaignAppeals('c1', 'stranger', Role.DONOR)
    ).rejects.toThrow('You do not have permission to view these appeals');
    const adminView = await ModerationService.getCampaignAppeals('c1', 'admin-1', Role.ADMIN);
    expect(adminView.length).toBe(1);
  });
});
