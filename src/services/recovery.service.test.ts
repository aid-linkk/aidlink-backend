import prisma from '../config/database';
import * as RecoveryService from './recovery.service';
import { RecoveryCaseType, RecoveryStatus, SettlementOption, DonationStatus, CampaignStatus, NotificationType } from '@prisma/client';

jest.mock('../config/database');
jest.mock('./notification.service', () => ({
  NotificationService: {
    createNotification: jest.fn().mockResolvedValue({}),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  // Re-establish $transaction default after clearAllMocks resets it
  (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
    typeof cb === 'function' ? cb(prisma) : Promise.all(cb)
  );
});

// ─── createFailedRefundCase ───────────────────────────────────────

describe('createFailedRefundCase', () => {
  it('creates a new recovery case for a failed refund', async () => {
    (prisma.recoveryCase.findFirst as jest.Mock).mockResolvedValue(null);
    const created = {
      id: 'rc1',
      type: RecoveryCaseType.FAILED_REFUND,
      donationId: 'd1',
      status: RecoveryStatus.PENDING,
      retryCount: 0,
      maxRetries: 3,
    };
    (prisma.recoveryCase.create as jest.Mock).mockResolvedValue(created);
    (prisma.donation.findUnique as jest.Mock).mockResolvedValue({ userId: 'u1', user: { id: 'u1' } });

    const result = await RecoveryService.createFailedRefundCase('d1', 'bad account');

    expect(prisma.recoveryCase.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: RecoveryCaseType.FAILED_REFUND }) })
    );
    expect(result.type).toBe(RecoveryCaseType.FAILED_REFUND);
    expect(result.status).toBe(RecoveryStatus.PENDING);
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('returns existing open case without creating a duplicate', async () => {
    const existing = { id: 'rc1', type: RecoveryCaseType.FAILED_REFUND, status: RecoveryStatus.RETRYING };
    (prisma.recoveryCase.findFirst as jest.Mock).mockResolvedValue(existing);

    const result = await RecoveryService.createFailedRefundCase('d1', 'bad account');

    expect(prisma.recoveryCase.create).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });
});

// ─── retryRefund ─────────────────────────────────────────────────

describe('retryRefund', () => {
  it('increments retry count and sets RETRYING status', async () => {
    const rc = {
      id: 'rc1',
      type: RecoveryCaseType.FAILED_REFUND,
      status: RecoveryStatus.PENDING,
      retryCount: 0,
      maxRetries: 3,
      donationId: 'd1',
    };
    (prisma.recoveryCase.findUnique as jest.Mock).mockResolvedValue(rc);
    const updated = { ...rc, retryCount: 1, status: RecoveryStatus.RETRYING };
    (prisma.recoveryCase.update as jest.Mock).mockResolvedValue(updated);

    const result = await RecoveryService.retryRefund('rc1', 'admin1');

    expect(prisma.recoveryCase.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: RecoveryStatus.RETRYING, retryCount: 1 }) })
    );
    expect(result.retryCount).toBe(1);
  });

  it('marks FAILED_PERMANENTLY when max retries reached', async () => {
    const rc = {
      id: 'rc1',
      type: RecoveryCaseType.FAILED_REFUND,
      status: RecoveryStatus.RETRYING,
      retryCount: 2,
      maxRetries: 3,
      donationId: 'd1',
    };
    (prisma.recoveryCase.findUnique as jest.Mock).mockResolvedValue(rc);
    const updated = { ...rc, retryCount: 3, status: RecoveryStatus.FAILED_PERMANENTLY };
    (prisma.recoveryCase.update as jest.Mock).mockResolvedValue(updated);
    (prisma.donation.findUnique as jest.Mock).mockResolvedValue({ userId: 'u1', user: { id: 'u1' } });

    const result = await RecoveryService.retryRefund('rc1', 'admin1');

    expect(result.status).toBe(RecoveryStatus.FAILED_PERMANENTLY);
    expect(prisma.auditLog.create).toHaveBeenCalled();
    expect(prisma.notification.create).toHaveBeenCalled();
  });

  it('throws if case is already resolved', async () => {
    (prisma.recoveryCase.findUnique as jest.Mock).mockResolvedValue({
      id: 'rc1',
      type: RecoveryCaseType.FAILED_REFUND,
      status: RecoveryStatus.RECOVERED,
      retryCount: 1,
      maxRetries: 3,
    });

    await expect(RecoveryService.retryRefund('rc1', 'admin1')).rejects.toThrow('Case is already resolved');
  });
});

// ─── retryDistribution ───────────────────────────────────────────

describe('retryDistribution', () => {
  it('retries distribution and updates distribution status to IN_PROGRESS', async () => {
    const rc = {
      id: 'rc2',
      type: RecoveryCaseType.FAILED_DISTRIBUTION,
      status: RecoveryStatus.PENDING,
      retryCount: 0,
      maxRetries: 3,
      distributionId: 'dist1',
    };
    (prisma.recoveryCase.findUnique as jest.Mock).mockResolvedValue(rc);
    (prisma.recoveryCase.update as jest.Mock).mockResolvedValue({ ...rc, retryCount: 1, status: RecoveryStatus.RETRYING });
    (prisma.distribution.update as jest.Mock).mockResolvedValue({});

    await RecoveryService.retryDistribution('rc2', 'admin1');

    expect(prisma.distribution.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'IN_PROGRESS' }) })
    );
  });
});

// ─── settleCancelledCampaign ──────────────────────────────────────

describe('settleCancelledCampaign', () => {
  const baseCampaign = {
    id: 'camp1',
    title: 'Test Campaign',
    currentAmount: 500,
    donations: [
      { id: 'd1', amount: 300, currency: 'XLM', userId: 'u1', status: DonationStatus.CONFIRMED },
      { id: 'd2', amount: 200, currency: 'XLM', userId: 'u2', status: DonationStatus.CONFIRMED },
    ],
  };

  const baseRc = {
    id: 'rc3',
    type: RecoveryCaseType.CANCELLED_CAMPAIGN_FUNDS,
    status: RecoveryStatus.RECOVERY_REQUIRED,
    campaignId: 'camp1',
    donorCredits: [],
  };

  const txMock = {
    donation: { update: jest.fn().mockResolvedValue({}) },
    campaign: { update: jest.fn().mockResolvedValue({}) },
    notification: { create: jest.fn().mockResolvedValue({}) },
    recoveryCase: { update: jest.fn().mockResolvedValue({ ...baseRc, status: RecoveryStatus.RECOVERED }) },
  };

  beforeEach(() => {
    (prisma.recoveryCase.findUnique as jest.Mock).mockResolvedValue(baseRc);
    (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(baseCampaign);
    (prisma.$transaction as jest.Mock).mockImplementation((fn: (tx: any) => Promise<any>) => fn(txMock));
    (prisma.recoveryCase.findUnique as jest.Mock)
      .mockResolvedValueOnce(baseRc)
      .mockResolvedValue({ ...baseRc, status: RecoveryStatus.RECOVERED });
  });

  it('issues donor refunds for REFUND_TO_DONOR settlement', async () => {
    await RecoveryService.settleCancelledCampaign('rc3', SettlementOption.REFUND_TO_DONOR, 'admin1');

    expect(txMock.donation.update).toHaveBeenCalledTimes(2);
    expect(txMock.notification.create).toHaveBeenCalledTimes(2);
    expect(txMock.recoveryCase.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: RecoveryStatus.RECOVERED }) })
    );
  });

  it('transfers funds to target campaign for TRANSFER_TO_CAMPAIGN', async () => {
    (prisma.recoveryCase.findUnique as jest.Mock)
      .mockResolvedValueOnce(baseRc)                                           // settle() lookup
      .mockResolvedValue({ ...baseRc, status: RecoveryStatus.RECOVERED });     // final fetch

    // order: target campaign check first, then source campaign with donations
    (prisma.campaign.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: 'camp2', status: CampaignStatus.ACTIVE })   // target campaign
      .mockResolvedValueOnce(baseCampaign);                                    // source campaign

    await RecoveryService.settleCancelledCampaign(
      'rc3',
      SettlementOption.TRANSFER_TO_CAMPAIGN,
      'admin1',
      undefined,
      'camp2'
    );

    expect(txMock.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'camp2' } })
    );
  });

  it('throws when targetCampaignId missing for TRANSFER_TO_CAMPAIGN', async () => {
    (prisma.recoveryCase.findUnique as jest.Mock).mockResolvedValue(baseRc);

    await expect(
      RecoveryService.settleCancelledCampaign('rc3', SettlementOption.TRANSFER_TO_CAMPAIGN, 'admin1')
    ).rejects.toThrow('targetCampaignId required');
  });
});

// ─── issueDonorCredit ─────────────────────────────────────────────

describe('issueDonorCredit', () => {
  it('creates a donor credit and sends notification', async () => {
    (prisma.recoveryCase.findUnique as jest.Mock).mockResolvedValue({ id: 'rc1' });
    (prisma.donorCredit.create as jest.Mock).mockResolvedValue({
      id: 'credit1', userId: 'u1', amount: 100, currency: 'XLM',
    });

    const result = await RecoveryService.issueDonorCredit('rc1', 'u1', 100, 'XLM', 'compensation', 'admin1');

    expect(prisma.donorCredit.create).toHaveBeenCalled();
    expect(result).toHaveProperty('id', 'credit1');
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          type: NotificationType.DONOR_CREDIT_ISSUED,
          metadata: expect.objectContaining({ donorCreditId: 'credit1' }),
        }),
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });
});

// ─── Transaction rollback tests ──────────────────────────────────

describe('recovery transaction rollbacks', () => {
  describe('createFailedRefundCase', () => {
    it('rolls back when auditLog.create fails inside transaction', async () => {
      (prisma.recoveryCase.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.recoveryCase.create as jest.Mock).mockResolvedValue({
        id: 'rc1', type: RecoveryCaseType.FAILED_REFUND, donationId: 'd1',
      });
      (prisma.donation.findUnique as jest.Mock).mockResolvedValue({ userId: 'u1' });
      (prisma.auditLog.create as jest.Mock).mockRejectedValue(new Error('DB constraint'));

      await expect(
        RecoveryService.createFailedRefundCase('d1', 'bad account')
      ).rejects.toThrow('DB constraint');

      // recoveryCase.create was called but logically rolled back
      expect(prisma.recoveryCase.create).toHaveBeenCalled();
      // notification should NOT be called (execution halted at auditLog)
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });
  });

  describe('issueDonorCredit', () => {
    it('rolls back when notification.create fails inside transaction', async () => {
      (prisma.recoveryCase.findUnique as jest.Mock).mockResolvedValue({ id: 'rc1' });
      (prisma.donorCredit.create as jest.Mock).mockResolvedValue({
        id: 'credit1', userId: 'u1', amount: 100,
      });
      (prisma.notification.create as jest.Mock).mockRejectedValue(new Error('DB error'));

      await expect(
        RecoveryService.issueDonorCredit('rc1', 'u1', 100, 'XLM', 'compensation', 'admin1')
      ).rejects.toThrow('DB error');

      expect(prisma.donorCredit.create).toHaveBeenCalled();
      expect(prisma.notification.create).toHaveBeenCalled();
      // auditLog should NOT be called (execution halted at notification)
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });
});

// ─── getReconciliationReport ──────────────────────────────────────

describe('getReconciliationReport', () => {
  it('returns aggregated reconciliation data', async () => {
    (prisma.recoveryCase.groupBy as jest.Mock)
      .mockResolvedValueOnce([{ status: RecoveryStatus.RECOVERED, _count: { id: 5 } }])
      .mockResolvedValueOnce([{ type: RecoveryCaseType.FAILED_REFUND, _count: { id: 3 } }]);
    (prisma.recoveryCase.count as jest.Mock).mockResolvedValue(2);
    (prisma.donorCredit.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: 400 }, _count: { id: 4 } });

    const report = await RecoveryService.getReconciliationReport();

    expect(report).toHaveProperty('byStatus');
    expect(report).toHaveProperty('byType');
    expect(report).toHaveProperty('retriesDue', 2);
    expect(report.donorCredits.totalAmount).toBe(400);
  });
});
