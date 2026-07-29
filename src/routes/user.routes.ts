import { Router } from 'express';
import { UserController } from '../controllers/user.controller';
import { authenticate, authorize } from '../middleware/auth';
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

/**
 * @route   GET /api/v1/users/notification-preferences
 * @desc    Alias for email-preferences (issue #13: user dashboard endpoints)
 * @access  Private
 */
router.get('/notification-preferences', authenticate, UserController.getNotificationPreferences);

/**
 * @route   PUT /api/v1/users/notification-preferences
 * @desc    Alias for email-preferences (issue #13: user dashboard endpoints)
 * @access  Private
 */
router.put(
  '/notification-preferences',
  authenticate,
  validate(emailPreferencesSchema),
  UserController.updateNotificationPreferences
);

// ── Profile (issue #13) ──────────────────────────────────────────

const updateProfileSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(30, 'Username must be at most 30 characters')
    .regex(/^[a-zA-Z0-9_.-]+$/, 'Username may only contain letters, numbers, "_", "-", and "."')
    .optional(),
});

/**
 * @route   GET /api/v1/users/profile
 * @desc    Get the current user's profile (with role-specific summary)
 * @access  Private
 */
router.get('/profile', authenticate, UserController.getProfile);

/**
 * @route   PATCH /api/v1/users/profile
 * @desc    Update the current user's profile
 * @access  Private
 */
router.patch('/profile', authenticate, validate(updateProfileSchema), UserController.updateProfile);

// ── Donation history (issue #13) ─────────────────────────────────

/**
 * @route   GET /api/v1/users/donations
 * @desc    Get the current user's donation history
 * @access  Private
 */
router.get('/donations', authenticate, UserController.getDonationHistory);

// ── Beneficiary applications (issue #13) ─────────────────────────

/**
 * @route   GET /api/v1/users/beneficiary-application
 * @desc    Get the current user's beneficiary application/profile
 * @access  Private (Beneficiary)
 */
router.get(
  '/beneficiary-application',
  authenticate,
  authorize('BENEFICIARY', 'ADMIN'),
  UserController.getBeneficiaryApplication
);

// ── Organization campaigns (issue #13) ───────────────────────────

/**
 * @route   GET /api/v1/users/organization-campaigns
 * @desc    Get campaigns owned by the current user's organization
 * @access  Private (Organization)
 */
router.get(
  '/organization-campaigns',
  authenticate,
  authorize('ORGANIZATION', 'ADMIN'),
  UserController.getOrganizationCampaigns
);

// ── Privacy settings (issue #13) ─────────────────────────────────

const privacySettingsSchema = z.object({
  profileVisibility: z.enum(['PUBLIC', 'DONORS_ONLY', 'PRIVATE']).optional(),
  showDonationHistory: z.boolean().optional(),
  showRealName: z.boolean().optional(),
  defaultDonationAnonymous: z.boolean().optional(),
});

/**
 * @route   GET /api/v1/users/privacy-settings
 * @desc    Get the current user's privacy settings
 * @access  Private
 */
router.get('/privacy-settings', authenticate, UserController.getPrivacySettings);

/**
 * @route   PUT /api/v1/users/privacy-settings
 * @desc    Update the current user's privacy settings
 * @access  Private
 */
router.put(
  '/privacy-settings',
  authenticate,
  validate(privacySettingsSchema),
  UserController.updatePrivacySettings
);

// ── Account security (issue #13) ─────────────────────────────────

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

/**
 * @route   GET /api/v1/users/security/sessions
 * @desc    List the current user's active sessions
 * @access  Private
 */
router.get('/security/sessions', authenticate, UserController.listSessions);

/**
 * @route   DELETE /api/v1/users/security/sessions/:sessionId
 * @desc    Revoke a single session (sign out one device)
 * @access  Private
 */
router.delete('/security/sessions/:sessionId', authenticate, UserController.revokeSession);

/**
 * @route   POST /api/v1/users/security/password
 * @desc    Change the current user's password
 * @access  Private
 */
router.post(
  '/security/password',
  authenticate,
  validate(changePasswordSchema),
  UserController.changePassword
);

export default router;
