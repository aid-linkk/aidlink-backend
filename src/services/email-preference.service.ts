import prisma from '../config/database';
import logger from '../config/logger';
import { NotificationType } from '@prisma/client';

/** Shape of the categories JSON stored in EmailPreference */
export interface EmailPreferenceCategories {
  donationReceived: boolean;
  campaignUpdates: boolean;
  distributionNotices: boolean;
  kycNotifications: boolean;
  securityAlerts: boolean;
}

/** Helper: safely cast a Prisma JsonValue to EmailPreferenceCategories */
function toCategories(json: unknown): EmailPreferenceCategories {
  const defaults: EmailPreferenceCategories = {
    donationReceived: true,
    campaignUpdates: true,
    distributionNotices: true,
    kycNotifications: true,
    securityAlerts: true,
  };
  if (!json || typeof json !== 'object') return defaults;
  const obj = json as Record<string, unknown>;
  return {
    donationReceived: obj.donationReceived !== false,
    campaignUpdates: obj.campaignUpdates !== false,
    distributionNotices: obj.distributionNotices !== false,
    kycNotifications: obj.kycNotifications !== false,
    securityAlerts: true, // always enforced
  };
}

export class EmailPreferenceService {
  /** Default preferences — all enabled for new users */
  static readonly DEFAULT_PREFERENCES: EmailPreferenceCategories = {
    donationReceived: true,
    campaignUpdates: true,
    distributionNotices: true,
    kycNotifications: true,
    securityAlerts: true,
  };

  /**
   * Which preference category key each notification type maps to.
   * Types not listed here map to `null` (always allowed).
   */
  private static readonly CATEGORY_MAP: Partial<
    Record<NotificationType, keyof EmailPreferenceCategories>
  > = {
    DONATION_RECEIVED: 'donationReceived',
    CAMPAIGN_UPDATE: 'campaignUpdates',
    DISTRIBUTION_SENT: 'distributionNotices',
    KYC_APPROVED: 'kycNotifications',
    KYC_REJECTED: 'kycNotifications',
    SYSTEM_ALERT: 'securityAlerts',
    SECURITY_ALERT: 'securityAlerts',
    CAMPAIGN_SUSPENDED: 'campaignUpdates',
    CAMPAIGN_REINSTATED: 'campaignUpdates',
    APPEAL_UPDATE: 'campaignUpdates',
    DONOR_CREDIT_ISSUED: 'donationReceived',
    REFUND_FAILED: 'donationReceived',
    CAMPAIGN_SETTLEMENT: 'donationReceived',
  };

  /**
   * Notification types that MUST be sent regardless of user preferences.
   * These are critical security / compliance notifications.
   */
  private static readonly MANDATORY_TYPES: NotificationType[] = ['SECURITY_ALERT'];

  // ── CRUD ──────────────────────────────────────────────────────────

  /** Fetch preferences for a user; creates defaults if none exist. */
  static async getPreferences(userId: string): Promise<{
    categories: EmailPreferenceCategories;
    allEmailsDisabled: boolean;
  }> {
    const existing = await prisma.emailPreference.findUnique({
      where: { userId },
    });

    if (!existing) {
      return this.createDefault(userId);
    }

    return {
      categories: toCategories(existing.categories),
      allEmailsDisabled: existing.allEmailsDisabled,
    };
  }

  /** Create or update preferences for a user. */
  static async upsertPreferences(
    userId: string,
    categories: Partial<EmailPreferenceCategories>,
    allEmailsDisabled?: boolean
  ): Promise<{
    categories: EmailPreferenceCategories;
    allEmailsDisabled: boolean;
  }> {
    const existing = await prisma.emailPreference.findUnique({
      where: { userId },
    });

    const existingCategories = existing
      ? toCategories(existing.categories)
      : this.DEFAULT_PREFERENCES;

    const mergedCategories: EmailPreferenceCategories = {
      ...existingCategories,
      ...categories,
      securityAlerts: true, // cannot be disabled
    };

    const mergedAllEmailsDisabled =
      allEmailsDisabled !== undefined
        ? allEmailsDisabled
        : existing?.allEmailsDisabled ?? false;

    const prefs = await prisma.emailPreference.upsert({
      where: { userId },
      create: {
        userId,
        categories: mergedCategories as unknown as object,
        allEmailsDisabled: mergedAllEmailsDisabled,
      },
      update: {
        categories: mergedCategories as unknown as object,
        allEmailsDisabled: mergedAllEmailsDisabled,
      },
    });

    logger.info(`Email preferences updated for user ${userId}`);

    return {
      categories: toCategories(prefs.categories),
      allEmailsDisabled: prefs.allEmailsDisabled,
    };
  }

  /** Create default preferences for a newly registered user. */
  static async createDefault(userId: string): Promise<{
    categories: EmailPreferenceCategories;
    allEmailsDisabled: boolean;
  }> {
    await prisma.emailPreference.create({
      data: {
        userId,
        categories: this.DEFAULT_PREFERENCES as unknown as object,
        allEmailsDisabled: false,
      },
    });

    logger.info(`Default email preferences created for user ${userId}`);
    return {
      categories: { ...this.DEFAULT_PREFERENCES },
      allEmailsDisabled: false,
    };
  }

  // ── Gate Logic ────────────────────────────────────────────────────

  /**
   * Determine whether an email should be sent to a user for a given
   * notification type. Checks (in order):
   *   1. User exists and has a verified email
   *   2. Notification type is mandatory (SECURITY_ALERT, etc.)
   *   3. User hasn't globally disabled emails
   *   4. The specific category for this type is opted-in
   */
  static async shouldSendEmail(
    userId: string,
    notificationType: NotificationType
  ): Promise<boolean> {
    // 1. User exists + email verified
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerified: true },
    });

    if (!user || !user.emailVerified) {
      return false;
    }

    // 2. Mandatory types always send
    if (this.MANDATORY_TYPES.includes(notificationType)) {
      return true;
    }

    // 3. Fetch preferences
    const prefs = await prisma.emailPreference.findUnique({
      where: { userId },
    });

    // No preferences record yet — create defaults and allow
    if (!prefs) {
      await this.createDefault(userId);
      return true;
    }

    // 4. Global opt-out
    if (prefs.allEmailsDisabled) {
      return false;
    }

    // 5. Category-specific check
    const categoryKey = this.CATEGORY_MAP[notificationType];
    if (!categoryKey) {
      // Unknown notification type — allow by default
      return true;
    }

    const categories = toCategories(prefs.categories);
    return categories[categoryKey] !== false;
  }
}
