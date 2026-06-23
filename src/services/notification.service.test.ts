import { NotificationType, NotificationStatus } from '@prisma/client';

jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({
    sendMail: jest.fn(),
  }),
}));

jest.mock('../config', () => ({
  config: {
    email: {
      host: 'smtp.test.com',
      port: 587,
      user: 'test@test.com',
      password: 'password',
      from: 'noreply@aidlink.org',
    },
  },
}));

jest.mock('./emailTemplate.service', () => ({
  EmailTemplateService: {
    TEMPLATE_VERSIONS: {
      'donation-received': '1.0.0',
      'campaign-update': '1.0.0',
      'distribution-sent': '1.0.0',
      'kyc-approved': '1.0.0',
      'kyc-rejected': '1.0.0',
      'security-alert': '1.0.0',
      receipt: '1.0.0',
      generic: '1.0.0',
    },
    DEFAULT_TEMPLATE: 'generic',
    initialize: jest.fn(),
    render: jest.fn().mockReturnValue({
      html: '<html><body><h1>Test Email</h1><p>Content</p></body></html>',
      text: 'Test Email\nContent',
    }),
    renderHtml: jest.fn().mockReturnValue('<html><body><h1>Test Email</h1></body></html>'),
    renderText: jest.fn().mockReturnValue('Test Email plain text'),
    getVersion: jest.fn().mockReturnValue('1.0.0'),
    logRender: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('./email-preference.service', () => ({
  EmailPreferenceService: {
    DEFAULT_PREFERENCES: {
      donationReceived: true,
      campaignUpdates: true,
      distributionNotices: true,
      kycNotifications: true,
      securityAlerts: true,
    },
    shouldSendEmail: jest.fn().mockResolvedValue(true),
    createDefault: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../config/database', () => {
  const mock = {
    __esModule: true,
    default: {
      notification: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      user: { findUnique: jest.fn() },
      emailPreference: { findUnique: jest.fn(), create: jest.fn() },
      emailTemplate: { create: jest.fn() },
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodemailer = require('nodemailer');

import { NotificationService } from './notification.service';

const mockNotification = (overrides: any = {}) => ({
  id: 'notif-1',
  userId: 'user-1',
  type: NotificationType.DONATION_RECEIVED,
  title: 'Donation Received',
  message: 'Thank you for your donation.',
  status: NotificationStatus.UNREAD,
  sentVia: [],
  metadata: null,
  readAt: null,
  createdAt: new Date(),
  ...overrides,
});

const mockUser = (overrides: any = {}) => ({
  id: 'user-1',
  email: 'test@example.com',
  emailVerified: true,
  username: 'testuser',
  ...overrides,
});

describe('NotificationService', () => {
  const transporter = nodemailer.createTransport();

  beforeEach(() => jest.clearAllMocks());

  describe('createNotification', () => {
    it('creates a notification successfully', async () => {
      prismaMock.notification.create.mockResolvedValue(mockNotification());

      const result = await NotificationService.createNotification(
        'user-1',
        NotificationType.DONATION_RECEIVED,
        'Donation Received',
        'Thank you for your donation.',
      );

      expect(result.id).toBe('notif-1');
      expect(prismaMock.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            type: NotificationType.DONATION_RECEIVED,
            title: 'Donation Received',
          }),
        })
      );
    });
  });

  describe('sendEmail', () => {
    it('sends email successfully', async () => {
      transporter.sendMail.mockResolvedValue({ messageId: 'msg-1' });

      await NotificationService.sendEmail('test@example.com', 'Subject', '<p>Body</p>');

      expect(transporter.sendMail).toHaveBeenCalledWith({
        from: 'noreply@aidlink.org',
        to: 'test@example.com',
        subject: 'Subject',
        html: '<p>Body</p>',
      });
    });

    it('re-throws error on send failure', async () => {
      transporter.sendMail.mockRejectedValue(new Error('SMTP error'));

      await expect(NotificationService.sendEmail('test@example.com', 'Subject', '<p>Body</p>')).rejects.toThrow('SMTP error');
    });
  });

  describe('sendNotificationEmail', () => {
    beforeEach(() => {
      // Default: preferences allow, user exists with email
      const EmailPreferenceService = require('./email-preference.service').EmailPreferenceService;
      EmailPreferenceService.shouldSendEmail.mockResolvedValue(true);
      prismaMock.user.findUnique.mockResolvedValue({ email: 'test@example.com' });
      transporter.sendMail.mockResolvedValue({ messageId: 'msg-1' });
      prismaMock.notification.update.mockResolvedValue(mockNotification());
    });

    it('sends email with rendered template and updates sentVia + metadata', async () => {
      const notification = mockNotification({ metadata: { campaignName: 'Test' } });

      await NotificationService.sendNotificationEmail('user-1', notification);

      expect(transporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'test@example.com',
          html: expect.any(String),
          text: expect.any(String),
        })
      );
      expect(prismaMock.notification.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'notif-1' },
          data: expect.objectContaining({
            sentVia: ['EMAIL'],
            metadata: expect.objectContaining({
              templateVersion: '1.0.0',
              templateName: expect.any(String),
            }),
          }),
        })
      );
    });

    it('skips when email preferences disallow sending', async () => {
      const EmailPreferenceService = require('./email-preference.service').EmailPreferenceService;
      EmailPreferenceService.shouldSendEmail.mockResolvedValue(false);

      await NotificationService.sendNotificationEmail('user-1', mockNotification());

      expect(transporter.sendMail).not.toHaveBeenCalled();
    });

    it('skips when user email is not found after preference check', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      await NotificationService.sendNotificationEmail('user-1', mockNotification());

      expect(transporter.sendMail).not.toHaveBeenCalled();
    });

    it('renders template with structured context from notification metadata', async () => {
      const EmailTemplateService = require('./emailTemplate.service').EmailTemplateService;
      const notification = mockNotification({
        type: 'DONATION_RECEIVED',
        title: 'Donation Received',
        message: 'Thank you!',
        metadata: {
          donorName: 'Alice',
          campaignName: 'Relief Fund',
          amount: 100,
          currency: 'XLM',
        },
      });

      await NotificationService.sendNotificationEmail('user-1', notification);

      expect(EmailTemplateService.render).toHaveBeenCalledWith(
        'donation-received',
        expect.objectContaining({
          donorName: 'Alice',
          campaignName: 'Relief Fund',
          amount: 100,
        })
      );
    });
  });

  describe('getUserNotifications', () => {
    it('returns notifications for user', async () => {
      const notifications = [mockNotification(), mockNotification({ id: 'notif-2' })];
      prismaMock.notification.findMany.mockResolvedValue(notifications);

      const result = await NotificationService.getUserNotifications('user-1');

      expect(result).toHaveLength(2);
    });

    it('filters by status', async () => {
      prismaMock.notification.findMany.mockResolvedValue([]);

      await NotificationService.getUserNotifications('user-1', NotificationStatus.UNREAD);

      expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', status: NotificationStatus.UNREAD } })
      );
    });

    it('limits results', async () => {
      prismaMock.notification.findMany.mockResolvedValue([]);

      await NotificationService.getUserNotifications('user-1', undefined, 5);

      expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 })
      );
    });
  });

  describe('markAsRead', () => {
    it('marks notification as read', async () => {
      prismaMock.notification.findUnique.mockResolvedValue(mockNotification());
      prismaMock.notification.update.mockResolvedValue(mockNotification({ status: NotificationStatus.READ, readAt: new Date() }));

      const result = await NotificationService.markAsRead('notif-1', 'user-1');

      expect(result.status).toBe(NotificationStatus.READ);
    });

    it('rejects non-existent notification', async () => {
      prismaMock.notification.findUnique.mockResolvedValue(null);

      await expect(NotificationService.markAsRead('nonexistent', 'user-1')).rejects.toThrow('Notification not found');
    });

    it('rejects unauthorized user', async () => {
      prismaMock.notification.findUnique.mockResolvedValue(mockNotification());

      await expect(NotificationService.markAsRead('notif-1', 'other-user')).rejects.toThrow(
        'You do not have permission to update this notification'
      );
    });
  });

  describe('markAllAsRead', () => {
    it('marks all as read', async () => {
      prismaMock.notification.updateMany.mockResolvedValue({ count: 5 });

      await NotificationService.markAllAsRead('user-1');

      expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', status: NotificationStatus.UNREAD },
        data: { status: NotificationStatus.READ, readAt: expect.any(Date) },
      });
    });
  });

  describe('deleteNotification', () => {
    it('deletes notification', async () => {
      prismaMock.notification.findUnique.mockResolvedValue(mockNotification());
      prismaMock.notification.delete.mockResolvedValue(mockNotification());

      await NotificationService.deleteNotification('notif-1', 'user-1');

      expect(prismaMock.notification.delete).toHaveBeenCalledWith({ where: { id: 'notif-1' } });
    });

    it('rejects non-existent notification', async () => {
      prismaMock.notification.findUnique.mockResolvedValue(null);

      await expect(NotificationService.deleteNotification('nonexistent', 'user-1')).rejects.toThrow('Notification not found');
    });

    it('rejects unauthorized user', async () => {
      prismaMock.notification.findUnique.mockResolvedValue(mockNotification());

      await expect(NotificationService.deleteNotification('notif-1', 'other-user')).rejects.toThrow(
        'You do not have permission to delete this notification'
      );
    });
  });

  describe('getUnreadCount', () => {
    it('returns unread count', async () => {
      prismaMock.notification.count.mockResolvedValue(3);

      const count = await NotificationService.getUnreadCount('user-1');

      expect(count).toBe(3);
    });
  });

  describe('template notification methods', () => {
    beforeEach(() => {
      prismaMock.notification.create.mockResolvedValue(mockNotification());
      prismaMock.user.findUnique.mockResolvedValue(mockUser());
      transporter.sendMail.mockResolvedValue({ messageId: 'msg-1' });
      prismaMock.notification.update.mockResolvedValue(mockNotification());
    });

    it('sendDonationReceivedNotification', async () => {
      await NotificationService.sendDonationReceivedNotification('user-1', 'Campaign Title', 100, 'USDC');
      expect(prismaMock.notification.create).toHaveBeenCalled();
      const callArgs = prismaMock.notification.create.mock.calls[0][0];
      expect(callArgs.data.message).toContain('100 USDC');
      expect(callArgs.data.message).not.toContain('XLM');
    });

    it('sendDonationReceivedNotification defaults to XLM', async () => {
      await NotificationService.sendDonationReceivedNotification('user-1', 'Campaign Title', 100);
      expect(prismaMock.notification.create).toHaveBeenCalled();
      const callArgs = prismaMock.notification.create.mock.calls[0][0];
      expect(callArgs.data.message).toContain('100 XLM');
    });

    it('sendCampaignUpdateNotification', async () => {
      await NotificationService.sendCampaignUpdateNotification('user-1', 'Campaign Title', 'Update content');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendDistributionSentNotification', async () => {
      await NotificationService.sendDistributionSentNotification('user-1', 50, 'EUR');
      expect(prismaMock.notification.create).toHaveBeenCalled();
      const callArgs = prismaMock.notification.create.mock.calls[0][0];
      expect(callArgs.data.message).toContain('50 EUR');
      expect(callArgs.data.message).not.toContain('XLM');
    });

    it('sendDistributionSentNotification defaults to XLM', async () => {
      await NotificationService.sendDistributionSentNotification('user-1', 50);
      expect(prismaMock.notification.create).toHaveBeenCalled();
      const callArgs = prismaMock.notification.create.mock.calls[0][0];
      expect(callArgs.data.message).toContain('50 XLM');
    });

    it('sendKYCApprovedNotification', async () => {
      await NotificationService.sendKYCApprovedNotification('user-1');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendKYCRejectedNotification', async () => {
      await NotificationService.sendKYCRejectedNotification('user-1', 'Invalid documents');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendOrganizationProfileUpdatedNotification', async () => {
      await NotificationService.sendOrganizationProfileUpdatedNotification('user-1', 'Org Name');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendOrganizationVerificationSubmittedNotification', async () => {
      await NotificationService.sendOrganizationVerificationSubmittedNotification('user-1', 'Org Name');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendOrganizationVerificationApprovedNotification', async () => {
      await NotificationService.sendOrganizationVerificationApprovedNotification('user-1', 'Org Name');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendOrganizationVerificationRejectedNotification', async () => {
      await NotificationService.sendOrganizationVerificationRejectedNotification('user-1', 'Org Name', 'Reason');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendOrganizationVerificationInfoRequestedNotification', async () => {
      await NotificationService.sendOrganizationVerificationInfoRequestedNotification('user-1', 'Org Name', 'Need more info');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendBankAccountAddedNotification', async () => {
      await NotificationService.sendBankAccountAddedNotification('user-1', 'Org Name', 'Bank Name');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendBankAccountReviewRequiredNotification', async () => {
      await NotificationService.sendBankAccountReviewRequiredNotification('user-1', 'Org Name');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendCampaignSuspendedNotification', async () => {
      await NotificationService.sendCampaignSuspendedNotification('user-1', 'Campaign Title', 'Policy violation');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendCampaignSuspendedNotification with all options', async () => {
      await NotificationService.sendCampaignSuspendedNotification('user-1', 'Campaign Title', 'Policy violation', {
        canAppeal: true,
        evidenceSummary: 'Evidence details',
        reviewTimeframe: 'within 3 days',
        metadata: { key: 'value' },
      });
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendCampaignReinstatedNotification', async () => {
      await NotificationService.sendCampaignReinstatedNotification('user-1', 'Campaign Title', 'Issue resolved');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendCampaignReinstatedNotification without notes', async () => {
      await NotificationService.sendCampaignReinstatedNotification('user-1', 'Campaign Title');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendAppealResolvedNotification approved', async () => {
      await NotificationService.sendAppealResolvedNotification('user-1', 'Campaign Title', 'APPROVED', 'Looks good');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendAppealResolvedNotification denied', async () => {
      await NotificationService.sendAppealResolvedNotification('user-1', 'Campaign Title', 'DENIED');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });

    it('sendDonorFraudSuspensionNotification', async () => {
      await NotificationService.sendDonorFraudSuspensionNotification('user-1', 'Campaign Title');
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });
  });
});
