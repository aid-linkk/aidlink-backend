import prisma from '../config/database';
import { NotificationType, NotificationStatus } from '@prisma/client';
import logger from '../config/logger';
import nodemailer from 'nodemailer';
import { config } from '../config';
import { sendNotificationWithCount, sendUnreadCount } from '../websocket/socket.server';
import { EmailTemplateService } from './emailTemplate.service';
import { EmailPreferenceService } from './email-preference.service';

export class NotificationService {
  private static transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: false,
    auth: {
      user: config.email.user,
      pass: config.email.password,
    },
  });

  // ── Template Name Mapping ──────────────────────────────────────────

  /** Map a NotificationType to its Handlebars template name. */
  private static getTemplateName(type: NotificationType): string {
    const map: Partial<Record<NotificationType, string>> = {
      DONATION_RECEIVED: 'donation-received',
      CAMPAIGN_UPDATE: 'campaign-update',
      DISTRIBUTION_SENT: 'distribution-sent',
      KYC_APPROVED: 'kyc-approval',
      KYC_REJECTED: 'kyc-rejection',
      SECURITY_ALERT: 'security-alert',
    };
    return map[type] || EmailTemplateService.DEFAULT_TEMPLATE;
  }

  /** Build a structured context object from notification data for template rendering. */
  private static buildEmailContext(notification: any): Record<string, unknown> {
    const meta = notification.metadata || {};

    // Common context injected into every email
    const base: Record<string, unknown> = {
      subject: notification.title,
      title: notification.title,
      message: notification.message,
      userName: meta.userName || meta.donorName || meta.name || undefined,
      supportEmail: config.email.supportEmail,
      logoUrl: config.email.logoUrl,
      currentYear: new Date().getFullYear(),
      managePreferencesLink: `${config.email.appUrl}/settings/email-preferences`,
    };

    return { ...base, ...meta };
  }

  // ── Core Notification CRUD ─────────────────────────────────────────

  static async createNotification(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    metadata?: any
  ): Promise<any> {
    const notification = await prisma.notification.create({
      data: {
        userId,
        type,
        title,
        message,
        metadata,
        sentVia: [],
      },
    });

    logger.info('Notification created: ' + notification.id + ' for user ' + userId);

    // Broadcast real-time notification with unread count
    try {
      const unreadCount = await prisma.notification.count({
        where: {
          userId,
          status: NotificationStatus.UNREAD,
        },
      });
      sendNotificationWithCount(userId, notification, unreadCount);
    } catch (wsError) {
      logger.error('Error broadcasting notification via WebSocket:', wsError);
    }

    return notification;
  }

  // ── Email Sending ──────────────────────────────────────────────────

  /**
   * Send a raw email via the SMTP transporter.
   * Supports both HTML and plain-text bodies, plus attachments.
   */
  static async sendEmail(
    to: string,
    subject: string,
    html: string,
    options: {
      from?: string;
      text?: string;
      attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
    } = {}
  ): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: options.from || config.email.from,
        to,
        subject,
        html,
        text: options.text,
        attachments: options.attachments,
      });

      logger.info(`Email sent to ${to}`);
    } catch (error) {
      logger.error('Error sending email:', error);
      throw error;
    }
  }

  /**
   * Send a notification email using HTML templates.
   *
   * Flow:
   *  1. Check user email preferences (opt-in/out, emailVerified, etc.)
   *  2. Map notification type → template name
   *  3. Build context from notification metadata
   *  4. Render HTML + plain text via EmailTemplateService
   *  5. Deliver via SMTP
   *  6. Record template version in notification metadata
   *  7. Log template render to audit table
   */
  static async sendNotificationEmail(userId: string, notification: any): Promise<void> {
    // 1. Check preferences (user existence, emailVerified, category opt-in)
    const shouldSend = await EmailPreferenceService.shouldSendEmail(
      userId,
      notification.type as NotificationType
    );
    if (!shouldSend) {
      logger.info(
        `Email skipped for user ${userId} — notification ${notification.id} (type: ${notification.type}) — preferences or email not verified`
      );
      return;
    }

    // Fetch user email for sending
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!user?.email) {
      logger.warn(`Cannot send email to user ${userId} — no email address`);
      return;
    }

    // 2. Map to template name
    const templateName = this.getTemplateName(notification.type as NotificationType);

    // 3. Build template context
    const context = this.buildEmailContext(notification);

    // 4. Render
    const { html, text } = EmailTemplateService.render(templateName, context);
    const version = EmailTemplateService.getVersion(templateName);

    // 5. Send
    try {
      await this.sendEmail(user.email, notification.title, html, { text });
    } catch (err) {
      logger.error(`Failed to send email for notification ${notification.id}:`, err);
      throw err;
    }

    // 6. Update notification with sentVia + template version in metadata
    await prisma.notification.update({
      where: { id: notification.id },
      data: {
        sentVia: ['EMAIL'],
        metadata: {
          ...(notification.metadata || {}),
          templateVersion: version,
          templateName,
        },
      },
    });

    // 7. Audit log
    EmailTemplateService.logRender(templateName, notification.id, context).catch((err) =>
      logger.error('Template render audit log failed:', err)
    );
  }

  // ── User Notification Management ──────────────────────────────────

  static async getUserNotifications(
    userId: string,
    status?: NotificationStatus,
    limit: number = 20
  ): Promise<any[]> {
    const where: any = { userId };

    if (status) {
      where.status = status;
    }

    return prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  static async markAsRead(notificationId: string, userId: string): Promise<any> {
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notification) {
      throw new Error('Notification not found');
    }

    if (notification.userId !== userId) {
      throw new Error('You do not have permission to update this notification');
    }

    const updated = await prisma.notification.update({
      where: { id: notificationId },
      data: {
        status: NotificationStatus.READ,
        readAt: new Date(),
      },
    });

    // Broadcast updated unread count after marking as read
    try {
      const unreadCount = await this.getUnreadCount(userId);
      sendUnreadCount(userId, unreadCount);
    } catch (wsError) {
      logger.error('Error broadcasting unread count via WebSocket:', wsError);
    }

    return updated;
  }

  static async markAllAsRead(userId: string): Promise<void> {
    await prisma.notification.updateMany({
      where: {
        userId,
        status: NotificationStatus.UNREAD,
      },
      data: {
        status: NotificationStatus.READ,
        readAt: new Date(),
      },
    });

    // Broadcast unread count = 0 after marking all as read
    try {
      sendUnreadCount(userId, 0);
    } catch (wsError) {
      logger.error('Error broadcasting unread count via WebSocket:', wsError);
    }
  }

  static async deleteNotification(notificationId: string, userId: string): Promise<void> {
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notification) {
      throw new Error('Notification not found');
    }

    if (notification.userId !== userId) {
      throw new Error('You do not have permission to delete this notification');
    }

    await prisma.notification.delete({
      where: { id: notificationId },
    });
  }

  static async getUnreadCount(userId: string): Promise<number> {
    return prisma.notification.count({
      where: {
        userId,
        status: NotificationStatus.UNREAD,
      },
    });
  }

  // ── Notification Templates ─────────────────────────────────────────

  static async sendDonationReceivedNotification(
    userId: string,
    campaignTitle: string,
    amount: number
  ): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.DONATION_RECEIVED,
      'Donation Received',
      `Thank you for your donation of ${amount} XLM to "${campaignTitle}". Your contribution will help make a difference.`,
      {
        campaignName: campaignTitle,
        amount,
        currency: 'XLM',
        date: new Date().toISOString(),
        impactSummary: `Your donation to "${campaignTitle}" will help provide critical aid to those who need it most.`,
        nextStepLink: `${config.email.appUrl}/campaigns`,
      }
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendCampaignUpdateNotification(
    userId: string,
    campaignTitle: string,
    update: string
  ): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.CAMPAIGN_UPDATE,
      'Campaign Update',
      `Update for "${campaignTitle}": ${update}`,
      {
        campaignTitle,
        updateSummary: update,
        postedDate: new Date().toISOString(),
        fullUpdateLink: `${config.email.appUrl}/campaigns`,
      }
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendDistributionSentNotification(userId: string, amount: number): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.DISTRIBUTION_SENT,
      'Distribution Received',
      `You have received a distribution of ${amount} XLM.`,
      {
        amount,
        currency: 'XLM',
        deliveryDate: new Date().toISOString(),
      }
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendKYCApprovedNotification(userId: string): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.KYC_APPROVED,
      'KYC Approved',
      'Your KYC verification has been approved. You can now receive distributions.',
      {
        approvedDate: new Date().toISOString(),
        welcomeMessage:
          'Welcome to the AidLink community! Your identity has been verified successfully.',
        nextSteps:
          'You can now participate in aid programs, receive distributions, and track your impact through the AidLink platform.',
      }
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendKYCRejectedNotification(userId: string, reason: string): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.KYC_REJECTED,
      'KYC Rejected',
      `Your KYC verification was rejected. Reason: ${reason}`,
      {
        rejectionReason: reason,
        requiredDocuments:
          'A valid government-issued ID, proof of address, and a clear self-portrait.',
        correctionSteps:
          'Please review the reason above, gather the required documents, and resubmit your verification through the AidLink platform.',
        resubmitLink: `${config.email.appUrl}/kyc/resubmit`,
        appealInstructions:
          'If you believe this decision was made in error, you may contact our support team for assistance.',
      }
    );

    await this.sendNotificationEmail(userId, notification);
  }

  // ─── Organization templates ────────────────────────────────────────

  static async sendOrganizationProfileUpdatedNotification(
    userId: string,
    organizationName: string
  ): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.ORGANIZATION_PROFILE_UPDATED,
      'Organization Profile Updated',
      `Your organization profile for "${organizationName}" was updated successfully.`,
      { organizationName }
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendOrganizationVerificationSubmittedNotification(
    userId: string,
    organizationName: string
  ): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.ORGANIZATION_VERIFICATION_SUBMITTED,
      'Organization Verification Submitted',
      `Your verification package for "${organizationName}" has been submitted for review.`,
      { organizationName }
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendOrganizationVerificationApprovedNotification(
    userId: string,
    organizationName: string
  ): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.ORGANIZATION_VERIFICATION_APPROVED,
      'Organization Verification Approved',
      `Your organization "${organizationName}" has been verified.`,
      { organizationName }
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendOrganizationVerificationRejectedNotification(
    userId: string,
    organizationName: string,
    reason: string
  ): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.ORGANIZATION_VERIFICATION_REJECTED,
      'Organization Verification Rejected',
      `Your organization "${organizationName}" was not verified. Reason: ${reason}`,
      { organizationName, reason }
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendOrganizationVerificationInfoRequestedNotification(
    userId: string,
    organizationName: string,
    reason: string
  ): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.ORGANIZATION_VERIFICATION_INFO_REQUESTED,
      'More Information Requested',
      `Additional information is needed to verify "${organizationName}". ${reason}`,
      { organizationName, reason }
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendBankAccountAddedNotification(
    userId: string,
    organizationName: string,
    bankName: string
  ): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.BANK_ACCOUNT_ADDED,
      'Bank Account Added',
      `A bank account at "${bankName}" was added to "${organizationName}" and may require review.`,
      { organizationName, bankName }
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendBankAccountReviewRequiredNotification(
    userId: string,
    organizationName: string
  ): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.BANK_ACCOUNT_REVIEW_REQUIRED,
      'Bank Account Review Required',
      `A bank account for "${organizationName}" has been submitted for verification review.`,
      { organizationName }
    );

    await this.sendNotificationEmail(userId, notification);
  }

  // ─── Moderation templates ──────────────────────────────────────────

  static async sendCampaignSuspendedNotification(
    userId: string,
    campaignTitle: string,
    reasonSummary: string,
    options: { canAppeal?: boolean; evidenceSummary?: string; reviewTimeframe?: string; metadata?: any } = {}
  ): Promise<void> {
    const {
      canAppeal = true,
      evidenceSummary,
      reviewTimeframe = 'within 5 business days',
      metadata,
    } = options;

    const parts = [
      `Your campaign "${campaignTitle}" has been suspended.`,
      `Reason: ${reasonSummary}.`,
    ];
    if (evidenceSummary) {
      parts.push(`Supporting information: ${evidenceSummary}.`);
    }
    if (canAppeal) {
      parts.push(
        `If you believe this is a mistake, you can submit an appeal from your campaign page. ` +
        `Our team typically reviews appeals ${reviewTimeframe}.`
      );
    }

    const notification = await this.createNotification(
      userId,
      NotificationType.CAMPAIGN_SUSPENDED,
      'Campaign Suspended',
      parts.join(' '),
      {
        ...metadata,
        campaignTitle,
        reasonSummary,
        canAppeal,
        evidenceSummary,
        reviewTimeframe,
      }
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendCampaignReinstatedNotification(
    userId: string,
    campaignTitle: string,
    notes?: string
  ): Promise<void> {
    const message = notes
      ? `Good news — your campaign "${campaignTitle}" has been reinstated and is active again. Note from our team: ${notes}`
      : `Good news — your campaign "${campaignTitle}" has been reinstated and is active again.`;

    const notification = await this.createNotification(
      userId,
      NotificationType.CAMPAIGN_REINSTATED,
      'Campaign Reinstated',
      message,
      { campaignTitle, notes }
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendAppealResolvedNotification(
    userId: string,
    campaignTitle: string,
    decision: 'APPROVED' | 'DENIED',
    adminNotes?: string
  ): Promise<void> {
    const outcome = decision === 'APPROVED'
      ? `Your appeal for "${campaignTitle}" was approved and the campaign has been reinstated.`
      : `Your appeal for "${campaignTitle}" was denied and the campaign remains suspended.`;
    const message = adminNotes ? `${outcome} Reviewer notes: ${adminNotes}` : outcome;

    const notification = await this.createNotification(
      userId,
      NotificationType.APPEAL_UPDATE,
      'Appeal Update',
      message,
      { campaignTitle, decision, adminNotes }
    );

    await this.sendNotificationEmail(userId, notification);
  }

  // ─── Milestone verification templates ─────────────────────────

  static async sendMilestoneSubmissionReceivedNotification(
    verifierUserId: string,
    campaignTitle: string,
    milestoneTitle: string,
    submissionId: string
  ): Promise<void> {
    const notification = await this.createNotification(
      verifierUserId,
      NotificationType.MILESTONE_SUBMISSION_RECEIVED,
      'Milestone Submission Ready for Review',
      `A new milestone submission for "${milestoneTitle}" in campaign "${campaignTitle}" is awaiting your review.`,
      { submissionId, campaignTitle, milestoneTitle }
    );
    await this.sendNotificationEmail(verifierUserId, notification);
  }

  static async sendMilestoneApprovedNotification(
    organizationUserId: string,
    milestoneTitle: string,
    impactSummary?: string
  ): Promise<void> {
    const message = impactSummary
      ? `Your milestone "${milestoneTitle}" has been verified. Verifier summary: ${impactSummary}`
      : `Your milestone "${milestoneTitle}" has been verified.`;

    const notification = await this.createNotification(
      organizationUserId,
      NotificationType.MILESTONE_APPROVED,
      'Milestone Verified',
      message,
      { milestoneTitle }
    );
    await this.sendNotificationEmail(organizationUserId, notification);
  }

  static async sendMilestoneRejectedNotification(
    organizationUserId: string,
    milestoneTitle: string,
    reason: string
  ): Promise<void> {
    const notification = await this.createNotification(
      organizationUserId,
      NotificationType.MILESTONE_REJECTED,
      'Milestone Submission Rejected',
      `Your submission for milestone "${milestoneTitle}" was rejected. Reason: ${reason}`,
      { milestoneTitle, reason }
    );
    await this.sendNotificationEmail(organizationUserId, notification);
  }

  static async sendMilestoneRevisionRequestedNotification(
    organizationUserId: string,
    milestoneTitle: string,
    reason: string
  ): Promise<void> {
    const notification = await this.createNotification(
      organizationUserId,
      NotificationType.MILESTONE_REVISION_REQUESTED,
      'Revision Requested for Milestone Submission',
      `Additional information is needed for your milestone "${milestoneTitle}" submission. ${reason} Please update and resubmit.`,
      { milestoneTitle, reason }
    );
    await this.sendNotificationEmail(organizationUserId, notification);
  }

  static async sendDonorFraudSuspensionNotification(
    userId: string,
    campaignTitle: string
  ): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.SECURITY_ALERT,
      'Campaign You Supported Was Suspended',
      `A campaign you donated to, "${campaignTitle}", has been suspended while we review a possible policy or fraud concern. ` +
      `Distributions are paused during the review. We will keep you informed of any action regarding your donation.`,
      {
        alertType: 'account_change',
        campaignTitle,
        whatHappened: `The campaign "${campaignTitle}" that you donated to has been flagged for review due to a possible policy or fraud concern. We are investigating and will keep you informed.`,
        timestamp: new Date().toISOString(),
        recommendedActions:
          'No action is required from you at this time. We will notify you once the review is complete. If you have concerns, please contact our support team.',
      }
    );

    await this.sendNotificationEmail(userId, notification);
  }
}
