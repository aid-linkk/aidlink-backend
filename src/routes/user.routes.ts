import { Router } from 'express';
import { UserController } from '../controllers/user.controller';
import { authenticate } from '../middleware/auth';
import { z } from 'zod';
import { validate } from '../middleware/validation';

const router = Router();

// ── Email Preferences ──────────────────────────────────────────

const emailPreferencesSchema = z.object({
  categories: z
    .object({
      donationReceived: z.boolean().optional(),
      campaignUpdates: z.boolean().optional(),
      distributionNotices: z.boolean().optional(),
      kycNotifications: z.boolean().optional(),
      securityAlerts: z.boolean().optional(),
    })
    .optional(),
  allEmailsDisabled: z.boolean().optional(),
});

/**
 * @route   GET /api/v1/users/email-preferences
 * @desc    Get current user's email notification preferences
 * @access  Private
 */
router.get('/email-preferences', authenticate, UserController.getEmailPreferences);

/**
 * @route   PUT /api/v1/users/email-preferences
 * @desc    Update current user's email notification preferences
 * @access  Private
 */
router.put(
  '/email-preferences',
  authenticate,
  validate(emailPreferencesSchema),
  UserController.updateEmailPreferences
);

export default router;
