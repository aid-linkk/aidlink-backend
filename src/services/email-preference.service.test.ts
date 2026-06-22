import { EmailPreferenceService } from './email-preference.service';
import { NotificationType } from '@prisma/client';

jest.mock('../config/database', () => {
  const mock = {
    __esModule: true,
    default: {
      emailPreference: {
        findUnique: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
    },
  };
  return mock;
});

jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

const prismaMock = require('../config/database').default;

describe('EmailPreferenceService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('createDefault', () => {
    it('creates default preferences with all categories enabled', async () => {
      prismaMock.emailPreference.create.mockResolvedValue({
        userId: 'user-1',
        categories: EmailPreferenceService.DEFAULT_PREFERENCES,
        allEmailsDisabled: false,
      });

      const result = await EmailPreferenceService.createDefault('user-1');

      expect(result.categories.donationReceived).toBe(true);
      expect(result.categories.campaignUpdates).toBe(true);
      expect(result.categories.distributionNotices).toBe(true);
      expect(result.categories.kycNotifications).toBe(true);
      expect(result.categories.securityAlerts).toBe(true);
      expect(result.allEmailsDisabled).toBe(false);

      expect(prismaMock.emailPreference.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          categories: EmailPreferenceService.DEFAULT_PREFERENCES,
          allEmailsDisabled: false,
        },
      });
    });
  });

  describe('getPreferences', () => {
    it('returns existing preferences', async () => {
      prismaMock.emailPreference.findUnique.mockResolvedValue({
        userId: 'user-1',
        categories: {
          donationReceived: true,
          campaignUpdates: false,
          distributionNotices: true,
          kycNotifications: true,
          securityAlerts: true,
        },
        allEmailsDisabled: false,
      });

      const result = await EmailPreferenceService.getPreferences('user-1');

      expect(result.categories.campaignUpdates).toBe(false);
      expect(result.allEmailsDisabled).toBe(false);
    });

    it('creates defaults when none exist', async () => {
      prismaMock.emailPreference.findUnique.mockResolvedValue(null);
      prismaMock.emailPreference.create.mockResolvedValue({
        userId: 'user-1',
        categories: EmailPreferenceService.DEFAULT_PREFERENCES,
        allEmailsDisabled: false,
      });

      const result = await EmailPreferenceService.getPreferences('user-1');

      expect(result.categories.donationReceived).toBe(true);
      expect(prismaMock.emailPreference.create).toHaveBeenCalled();
    });
  });

  describe('upsertPreferences', () => {
    it('merges partial preference updates', async () => {
      const existingCategories = {
        donationReceived: true,
        campaignUpdates: true,
        distributionNotices: true,
        kycNotifications: true,
        securityAlerts: true,
      };

      prismaMock.emailPreference.findUnique.mockResolvedValue({
        userId: 'user-1',
        categories: existingCategories,
        allEmailsDisabled: false,
      });

      prismaMock.emailPreference.upsert.mockResolvedValue({
        userId: 'user-1',
        categories: { ...existingCategories, campaignUpdates: false },
        allEmailsDisabled: false,
      });

      const result = await EmailPreferenceService.upsertPreferences('user-1', {
        campaignUpdates: false,
      });

      expect(result.categories.campaignUpdates).toBe(false);
      // Other categories unchanged
      expect(result.categories.donationReceived).toBe(true);
    });

    it('enforces security alerts cannot be disabled', async () => {
      prismaMock.emailPreference.findUnique.mockResolvedValue(null);

      prismaMock.emailPreference.upsert.mockImplementation(async ({ create }: any) => ({
        userId: 'user-1',
        categories: create.categories,
        allEmailsDisabled: create.allEmailsDisabled,
      }));

      const result = await EmailPreferenceService.upsertPreferences('user-1', {
        securityAlerts: false,
      });

      // Security alerts must remain true regardless of input
      expect(result.categories.securityAlerts).toBe(true);
    });
  });

  describe('shouldSendEmail', () => {
    const mockUser = (emailVerified: boolean) => {
      prismaMock.user.findUnique.mockResolvedValue({
        emailVerified,
      });
    };

    const mockPrefs = (categories?: Partial<Record<string, boolean>>, allEmailsDisabled = false) => {
      prismaMock.emailPreference.findUnique.mockResolvedValue(
        categories || allEmailsDisabled
          ? {
              userId: 'user-1',
              categories: {
                donationReceived: categories?.donationReceived ?? true,
                campaignUpdates: categories?.campaignUpdates ?? true,
                distributionNotices: categories?.distributionNotices ?? true,
                kycNotifications: categories?.kycNotifications ?? true,
                securityAlerts: true,
              },
              allEmailsDisabled,
            }
          : null
      );
    };

    it('returns false when user not found', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      const result = await EmailPreferenceService.shouldSendEmail('user-1', 'DONATION_RECEIVED');
      expect(result).toBe(false);
    });

    it('returns false when email is not verified', async () => {
      mockUser(false);

      const result = await EmailPreferenceService.shouldSendEmail('user-1', 'DONATION_RECEIVED');
      expect(result).toBe(false);
    });

    it('returns true for verified user with defaults', async () => {
      mockUser(true);
      mockPrefs(); // null — creates defaults

      const result = await EmailPreferenceService.shouldSendEmail('user-1', 'DONATION_RECEIVED');
      expect(result).toBe(true);
    });

    it('respects category opt-out', async () => {
      mockUser(true);
      mockPrefs({ campaignUpdates: false });

      const result = await EmailPreferenceService.shouldSendEmail('user-1', 'CAMPAIGN_UPDATE');
      expect(result).toBe(false);
    });

    it('allows sending for opted-in category', async () => {
      mockUser(true);
      mockPrefs({ donationReceived: true, campaignUpdates: false });

      const result = await EmailPreferenceService.shouldSendEmail('user-1', 'DONATION_RECEIVED');
      expect(result).toBe(true);
    });

    it('always allows SECURITY_ALERT regardless of preferences', async () => {
      mockUser(true);
      mockPrefs({}, true); // all emails disabled

      const result = await EmailPreferenceService.shouldSendEmail('user-1', 'SECURITY_ALERT');
      expect(result).toBe(true);
    });

    it('returns false for non-security types when all emails disabled', async () => {
      mockUser(true);
      mockPrefs({}, true);

      const result = await EmailPreferenceService.shouldSendEmail('user-1', 'CAMPAIGN_UPDATE');
      expect(result).toBe(false);
    });

    it('returns true for unmapped notification types (default allow)', async () => {
      mockUser(true);
      // Provide valid preferences so createDefault is not triggered
      prismaMock.emailPreference.findUnique.mockResolvedValue({
        userId: 'user-1',
        categories: EmailPreferenceService.DEFAULT_PREFERENCES,
        allEmailsDisabled: false,
      });

      // ORGANIZATION_PROFILE_UPDATED is not in CATEGORY_MAP
      const result = await EmailPreferenceService.shouldSendEmail(
        'user-1',
        'ORGANIZATION_PROFILE_UPDATED'
      );
      expect(result).toBe(true);
    });
  });
});
