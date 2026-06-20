import prisma from '../config/database';
import { NotificationType, NotificationStatus } from '@prisma/client';
import logger from '../config/logger';
import nodemailer from 'nodemailer';
import { config } from '../config';

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

    logger.info(`Notification created: ${notification.id} for user ${userId}`);

    return notification;
  }

  static async sendEmail(to: string, subject: string, html: string): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: config.email.from,
        to,
        subject,
        html,
      });

      logger.info(`Email sent to ${to}`);
    } catch (error) {
      logger.error('Error sending email:', error);
      throw error;
    }
  }

  static async sendNotificationEmail(userId: string, notification: any): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.emailVerified) {
      return;
    }

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">${notification.title}</h2>
        <p style="color: #666;">${notification.message}</p>
        <p style="color: #999; font-size: 12px;">This is an automated email from AidLink.</p>
      </div>
    `;

    await this.sendEmail(user.email, notification.title, html);

    // Update notification to include email in sentVia
    await prisma.notification.update({
      where: { id: notification.id },
      data: {
        sentVia: ['EMAIL'],
      },
    });
  }

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

    return prisma.notification.update({
      where: { id: notificationId },
      data: {
        status: NotificationStatus.READ,
        readAt: new Date(),
      },
    });
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

  // Notification templates
  static async sendDonationReceivedNotification(userId: string, campaignTitle: string, amount: number): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.DONATION_RECEIVED,
      'Donation Received',
      `Thank you for your donation of ${amount} XLM to "${campaignTitle}". Your contribution will help make a difference.`
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendCampaignUpdateNotification(userId: string, campaignTitle: string, update: string): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.CAMPAIGN_UPDATE,
      'Campaign Update',
      `Update for "${campaignTitle}": ${update}`
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendDistributionSentNotification(userId: string, amount: number): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.DISTRIBUTION_SENT,
      'Distribution Received',
      `You have received a distribution of ${amount} XLM.`
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendKYCApprovedNotification(userId: string): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.KYC_APPROVED,
      'KYC Approved',
      'Your KYC verification has been approved. You can now receive distributions.'
    );

    await this.sendNotificationEmail(userId, notification);
  }

  static async sendKYCRejectedNotification(userId: string, reason: string): Promise<void> {
    const notification = await this.createNotification(
      userId,
      NotificationType.KYC_REJECTED,
      'KYC Rejected',
      `Your KYC verification was rejected. Reason: ${reason}`
    );

    await this.sendNotificationEmail(userId, notification);
  }

  // ─── Moderation templates ──────────────────────────────────────

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
      metadata
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
      message
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
      message
    );

    await this.sendNotificationEmail(userId, notification);
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
      `Distributions are paused during the review. We will keep you informed of any action regarding your donation.`
    );

    await this.sendNotificationEmail(userId, notification);
  }
}
