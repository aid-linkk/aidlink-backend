/**
 * Unit tests for the KYC expiration automation in src/workers/kyc.worker.ts:
 *  - scheduleKYCExpirationJob(): registers/skips the repeatable BullMQ job
 *  - EXPIRE_KYC_SUBMISSIONS job processor: orchestrates notifications for
 *    submissions BeneficiaryService.expireKYCSubmissions() just expired
 *
 * The BullMQ Worker processor callback isn't exported directly, so it's
 * captured from the (mocked) `new Worker(name, processor, opts)` call —
 * mirrors the mocking approach already used in beneficiary.service.test.ts
 * for the Queue/Worker constructors.
 */

const mockQueueAdd = jest.fn().mockResolvedValue(undefined);
const mockWorkerCapture: { processor?: (job: any) => Promise<any> } = {};

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: mockQueueAdd })),
  Worker: jest.fn().mockImplementation((_name: string, processor: any) => {
    mockWorkerCapture.processor = processor;
    return { on: jest.fn(), close: jest.fn().mockResolvedValue(undefined) };
  }),
}));

jest.mock('@prisma/client', () => ({
  KYCStatus: { PENDING: 'PENDING', UNDER_REVIEW: 'UNDER_REVIEW', APPROVED: 'APPROVED', REJECTED: 'REJECTED', EXPIRED: 'EXPIRED' },
  Role: { ADMIN: 'ADMIN', VERIFIER: 'VERIFIER', DONOR: 'DONOR', BENEFICIARY: 'BENEFICIARY' },
}));

jest.mock('../config', () => ({
  config: {
    bullmq: { redisHost: 'localhost', redisPort: 6379, redisPassword: undefined },
    kycExpiration: {
      enabled: true,
      checkIntervalCron: '0 * * * *',
      batchSize: 100,
      notifyAdminsOnHighRisk: true,
      highRiskFraudScoreThreshold: 50,
    },
  },
}));

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    kYCSubmission: { findUnique: jest.fn() },
    user: { findMany: jest.fn() },
  },
}));

jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../services/beneficiary.service', () => ({
  BeneficiaryService: {
    calculateRiskScore: jest.fn(),
    reviewKYC: jest.fn(),
    expireKYCSubmissions: jest.fn(),
  },
}));

jest.mock('../services/kycFraud.service', () => ({
  assessFraud: jest.fn(),
  getThirdPartyFraudScore: jest.fn(),
}));

jest.mock('../services/notification.service', () => ({
  NotificationService: {
    sendKYCExpiredNotification: jest.fn().mockResolvedValue(undefined),
    sendKYCExpirationAdminAlert: jest.fn().mockResolvedValue(undefined),
  },
}));

import { config } from '../config';
import prisma from '../config/database';
import { BeneficiaryService } from '../services/beneficiary.service';
import { NotificationService } from '../services/notification.service';

// Importing the module registers the (mocked) Worker/Queue and captures the
// processor + schedule function as a side effect.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const kycWorkerModule = require('./kyc.worker');

const prismaMock = prisma as unknown as { kYCSubmission: any; user: any };
const expireKYCSubmissionsMock = BeneficiaryService.expireKYCSubmissions as jest.Mock;
const sendKYCExpiredNotificationMock = NotificationService.sendKYCExpiredNotification as jest.Mock;
const sendKYCExpirationAdminAlertMock = NotificationService.sendKYCExpirationAdminAlert as jest.Mock;

function runProcessor(jobData: any) {
  if (!mockWorkerCapture.processor) throw new Error('Worker processor was not captured');
  return mockWorkerCapture.processor({ id: 'job-1', data: jobData } as any);
}

describe('kyc.worker — expiration automation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (config as any).kycExpiration.enabled = true;
    (config as any).kycExpiration.notifyAdminsOnHighRisk = true;
    (config as any).kycExpiration.highRiskFraudScoreThreshold = 50;
    prismaMock.user.findMany.mockResolvedValue([]);
  });

  describe('scheduleKYCExpirationJob', () => {
    it('registers a repeatable job using the configured cron pattern', async () => {
      await kycWorkerModule.scheduleKYCExpirationJob();

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'EXPIRE_KYC_SUBMISSIONS',
        { type: 'EXPIRE_KYC_SUBMISSIONS', data: {} },
        expect.objectContaining({
          repeat: { pattern: '0 * * * *' },
          jobId: 'kyc-expiration-scan',
        })
      );
    });

    it('does nothing when KYC expiration automation is disabled', async () => {
      (config as any).kycExpiration.enabled = false;

      await kycWorkerModule.scheduleKYCExpirationJob();

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });

  describe('EXPIRE_KYC_SUBMISSIONS processor', () => {
    it('notifies each newly-expired beneficiary and skips admin lookup when nothing is high-risk', async () => {
      expireKYCSubmissionsMock.mockResolvedValue({
        scanned: 2,
        expired: 2,
        errors: 0,
        expiredSubmissions: [
          { id: 'kyc-1', userId: 'user-1', beneficiaryId: 'ben-1', expiresAt: new Date('2026-08-01'), fraudScore: 10 },
          { id: 'kyc-2', userId: 'user-2', beneficiaryId: 'ben-2', expiresAt: new Date('2026-08-02'), fraudScore: 20 },
        ],
      });

      const result = await runProcessor({ type: 'EXPIRE_KYC_SUBMISSIONS', data: {} });

      expect(sendKYCExpiredNotificationMock).toHaveBeenCalledTimes(2);
      expect(sendKYCExpiredNotificationMock).toHaveBeenCalledWith('user-1', 'kyc-1', new Date('2026-08-01'));
      expect(sendKYCExpiredNotificationMock).toHaveBeenCalledWith('user-2', 'kyc-2', new Date('2026-08-02'));
      // Neither submission is high-risk, so reviewers are never looked up or alerted.
      expect(prismaMock.user.findMany).not.toHaveBeenCalled();
      expect(sendKYCExpirationAdminAlertMock).not.toHaveBeenCalled();
      expect(result.status).toBe('expiration_scan_completed');
      expect(result.notified).toBe(2);
      expect(result.adminAlerts).toBe(0);
    });

    it('alerts active admins/verifiers only for high-risk expired submissions', async () => {
      expireKYCSubmissionsMock.mockResolvedValue({
        scanned: 2,
        expired: 2,
        errors: 0,
        expiredSubmissions: [
          { id: 'kyc-low', userId: 'user-1', beneficiaryId: 'ben-1', expiresAt: new Date('2026-08-01'), fraudScore: 10 },
          { id: 'kyc-high', userId: 'user-2', beneficiaryId: 'ben-2', expiresAt: new Date('2026-08-02'), fraudScore: 75 },
        ],
      });
      prismaMock.user.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'verifier-1' }]);

      const result = await runProcessor({ type: 'EXPIRE_KYC_SUBMISSIONS', data: {} });

      expect(prismaMock.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ role: { in: ['VERIFIER', 'ADMIN'] } }),
        })
      );
      expect(sendKYCExpirationAdminAlertMock).toHaveBeenCalledTimes(2);
      expect(sendKYCExpirationAdminAlertMock).toHaveBeenCalledWith('admin-1', 'kyc-high', 'user-2', 75);
      expect(sendKYCExpirationAdminAlertMock).toHaveBeenCalledWith('verifier-1', 'kyc-high', 'user-2', 75);
      expect(result.adminAlerts).toBe(1);
    });

    it('does not alert admins when notifyAdminsOnHighRisk is disabled', async () => {
      (config as any).kycExpiration.notifyAdminsOnHighRisk = false;
      expireKYCSubmissionsMock.mockResolvedValue({
        scanned: 1,
        expired: 1,
        errors: 0,
        expiredSubmissions: [
          { id: 'kyc-high', userId: 'user-2', beneficiaryId: 'ben-2', expiresAt: new Date('2026-08-02'), fraudScore: 90 },
        ],
      });

      await runProcessor({ type: 'EXPIRE_KYC_SUBMISSIONS', data: {} });

      expect(prismaMock.user.findMany).not.toHaveBeenCalled();
      expect(sendKYCExpirationAdminAlertMock).not.toHaveBeenCalled();
    });

    it('continues notifying remaining submissions if one notification fails', async () => {
      expireKYCSubmissionsMock.mockResolvedValue({
        scanned: 2,
        expired: 2,
        errors: 0,
        expiredSubmissions: [
          { id: 'kyc-1', userId: 'user-1', beneficiaryId: 'ben-1', expiresAt: new Date('2026-08-01'), fraudScore: 0 },
          { id: 'kyc-2', userId: 'user-2', beneficiaryId: 'ben-2', expiresAt: new Date('2026-08-02'), fraudScore: 0 },
        ],
      });
      sendKYCExpiredNotificationMock
        .mockRejectedValueOnce(new Error('smtp down'))
        .mockResolvedValueOnce(undefined);

      const result = await runProcessor({ type: 'EXPIRE_KYC_SUBMISSIONS', data: {} });

      expect(sendKYCExpiredNotificationMock).toHaveBeenCalledTimes(2);
      expect(result.notified).toBe(1);
    });

    it('handles a scan with no expired submissions as a no-op', async () => {
      expireKYCSubmissionsMock.mockResolvedValue({ scanned: 5, expired: 0, errors: 0, expiredSubmissions: [] });

      const result = await runProcessor({ type: 'EXPIRE_KYC_SUBMISSIONS', data: {} });

      expect(sendKYCExpiredNotificationMock).not.toHaveBeenCalled();
      expect(sendKYCExpirationAdminAlertMock).not.toHaveBeenCalled();
      expect(result.notified).toBe(0);
      expect(result.adminAlerts).toBe(0);
    });
  });
});
