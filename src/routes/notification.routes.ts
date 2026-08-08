import { Router } from 'express';
import { NotificationController } from '../controllers/notification.controller';
import { authenticate } from '../middleware/auth';
import { notificationLimiter } from '../middleware/rateLimit';
import { z } from 'zod';
import { validate } from '../middleware/validation';

const router = Router();

// Validation schemas
const createNotificationSchema = z.object({
  type: z.enum(['DONATION_RECEIVED', 'CAMPAIGN_UPDATE', 'DISTRIBUTION_SENT', 'KYC_APPROVED', 'KYC_REJECTED', 'KYC_EXPIRED', 'SYSTEM_ALERT', 'SECURITY_ALERT']),
  title: z.string().min(1, 'Title is required'),
  message: z.string().min(1, 'Message is required'),
  metadata: z.any().optional(),
});

const donationNotificationSchema = z.object({
  campaignTitle: z.string().min(1, 'Campaign title is required'),
  amount: z.number().positive('Amount must be positive'),
});

const campaignUpdateSchema = z.object({
  campaignTitle: z.string().min(1, 'Campaign title is required'),
  update: z.string().min(1, 'Update is required'),
});

const distributionNotificationSchema = z.object({
  amount: z.number().positive('Amount must be positive'),
});

/**
 * @route   POST /api/v1/notifications
 * @desc    Create a new notification
 * @access  Private
 */
router.post(
  '/',
  authenticate,
  notificationLimiter,
  validate(createNotificationSchema),
  NotificationController.createNotification
);

/**
 * @route   GET /api/v1/notifications
 * @desc    Get current user's notifications
 * @access  Private
 */
router.get(
  '/',
  authenticate,
  NotificationController.getUserNotifications
);

/**
 * @route   GET /api/v1/notifications/unread-count
 * @desc    Get unread notification count
 * @access  Private
 */
router.get(
  '/unread-count',
  authenticate,
  NotificationController.getUnreadCount
);

/**
 * @route   PATCH /api/v1/notifications/:id/read
 * @desc    Mark notification as read
 * @access  Private
 */
router.patch(
  '/:id/read',
  authenticate,
  NotificationController.markAsRead
);

/**
 * @route   PATCH /api/v1/notifications/read-all
 * @desc    Mark all notifications as read
 * @access  Private
 */
router.patch(
  '/read-all',
  authenticate,
  NotificationController.markAllAsRead
);

/**
 * @route   DELETE /api/v1/notifications/:id
 * @desc    Delete notification
 * @access  Private
 */
router.delete(
  '/:id',
  authenticate,
  NotificationController.deleteNotification
);

/**
 * @route   POST /api/v1/notifications/donation
 * @desc    Send donation received notification
 * @access  Private
 */
router.post(
  '/donation',
  authenticate,
  validate(donationNotificationSchema),
  NotificationController.sendDonationNotification
);

/**
 * @route   POST /api/v1/notifications/campaign-update
 * @desc    Send campaign update notification
 * @access  Private
 */
router.post(
  '/campaign-update',
  authenticate,
  validate(campaignUpdateSchema),
  NotificationController.sendCampaignUpdateNotification
);

/**
 * @route   POST /api/v1/notifications/distribution
 * @desc    Send distribution notification
 * @access  Private
 */
router.post(
  '/distribution',
  authenticate,
  validate(distributionNotificationSchema),
  NotificationController.sendDistributionNotification
);

export default router;
