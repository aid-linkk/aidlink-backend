import { Router } from 'express';
import { AdminController } from '../controllers/admin.controller';
import { ModerationController } from '../controllers/moderation.controller';
import { OrganizationController } from '../controllers/organization.controller';
import { MilestoneController } from '../controllers/milestone.controller';
import { RecoveryController } from '../controllers/recovery.controller';
import { DatabaseController } from '../controllers/database.controller';
import { AdminNotificationPreferenceController } from '../controllers/adminNotificationPreference.controller';
import { MatchedFundVerificationController } from '../controllers/matchedFundVerification.controller';
import { authenticate, authorize } from '../middleware/auth';
import { z } from 'zod';
import { validate } from '../middleware/validation';
import {
  suspendCampaignSchema,
  reinstateCampaignSchema,
  resolveAppealSchema,
  organizationReviewSchema,
  organizationRejectSchema,
  milestoneReviewSchema,
} from '../utils/validation';

const router = Router();

// Validation schemas
const updateStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION', 'REJECTED', 'DELETED']),
});

const updateRoleSchema = z.object({
  role: z.enum(['ADMIN', 'ORGANIZATION', 'DONOR', 'BENEFICIARY', 'VERIFIER', 'AUDITOR']),
});

/**
 * @route   GET /api/v1/admin/dashboard
 * @desc    Get dashboard statistics
 * @access  Private (Admin)
 */
router.get(
  '/dashboard',
  authenticate,
  AdminController.getDashboardStats
);

/**
 * @route   GET /api/v1/admin/activity
 * @desc    Get recent activity across the platform
 * @access  Private (Admin)
 */
router.get(
  '/activity',
  authenticate,
  AdminController.getRecentActivity
);

/**
 * @route   GET /api/v1/admin/users
 * @desc    Get all users with filtering and pagination
 * @access  Private (Admin)
 */
router.get(
  '/users',
  authenticate,
  AdminController.getAllUsers
);

/**
 * @route   PATCH /api/v1/admin/users/:id/status
 * @desc    Update user status
 * @access  Private (Admin)
 */
router.patch(
  '/users/:id/status',
  authenticate,
  validate(updateStatusSchema),
  AdminController.updateUserStatus
);

/**
 * @route   PATCH /api/v1/admin/users/:id/role
 * @desc    Update user role
 * @access  Private (Admin)
 */
router.patch(
  '/users/:id/role',
  authenticate,
  validate(updateRoleSchema),
  AdminController.updateUserRole
);

/**
 * @route   GET /api/v1/admin/audit-logs
 * @desc    Get audit logs with filtering and pagination
 * @access  Private (Admin)
 */
router.get(
  '/audit-logs',
  authenticate,
  AdminController.getAuditLogs
);

/**
 * @route   GET /api/v1/admin/health
 * @desc    Get system health status
 * @access  Private (Admin)
 */
router.get(
  '/health',
  authenticate,
  AdminController.getSystemHealth
);

// ─── Campaign moderation (Admin) ───────────────────────────────

/**
 * @route   POST /api/v1/admin/campaigns/:id/suspend
 * @desc    Suspend a campaign with a recorded reason
 * @access  Private (Admin)
 */
router.post(
  '/campaigns/:id/suspend',
  authenticate,
  validate(suspendCampaignSchema),
  ModerationController.suspendCampaign
);

/**
 * @route   POST /api/v1/admin/campaigns/:id/reinstate
 * @desc    Reinstate a suspended campaign
 * @access  Private (Admin)
 */
router.post(
  '/campaigns/:id/reinstate',
  authenticate,
  validate(reinstateCampaignSchema),
  ModerationController.reinstateCampaign
);

/**
 * @route   GET /api/v1/admin/campaigns/:id/suspensions
 * @desc    List suspensions (with appeals) for a campaign
 * @access  Private (Admin)
 */
router.get(
  '/campaigns/:id/suspensions',
  authenticate,
  ModerationController.getSuspensions
);

/**
 * @route   GET /api/v1/admin/appeals
 * @desc    List and filter appeals across campaigns
 * @access  Private (Admin)
 */
router.get(
  '/appeals',
  authenticate,
  ModerationController.listAppeals
);

/**
 * @route   POST /api/v1/admin/appeals/:id/resolve
 * @desc    Approve or deny an appeal
 * @access  Private (Admin)
 */
router.post(
  '/appeals/:id/resolve',
  authenticate,
  validate(resolveAppealSchema),
  ModerationController.resolveAppeal
);

// ─── Organization verification (Admin) ──────────────────────────

router.post(
  '/organizations/:id/verification/approve',
  authenticate,
  validate(organizationReviewSchema),
  OrganizationController.approveVerification
);

router.post(
  '/organizations/:id/verification/reject',
  authenticate,
  validate(organizationRejectSchema),
  OrganizationController.rejectVerification
);

router.post(
  '/organizations/:id/verification/request-more-info',
  authenticate,
  validate(organizationRejectSchema),
  OrganizationController.requestMoreInfo
);

// ─── Milestone verification (Admin / Verifier) ─────────────────

router.get(
  '/milestone-submissions',
  authenticate,
  authorize('ADMIN', 'VERIFIER'),
  MilestoneController.listAdminSubmissions
);

router.get(
  '/milestone-submissions/:submissionId',
  authenticate,
  authorize('ADMIN', 'VERIFIER'),
  MilestoneController.getAdminSubmission
);

router.post(
  '/milestone-submissions/:submissionId/reviews',
  authenticate,
  authorize('ADMIN', 'VERIFIER'),
  validate(milestoneReviewSchema),
  MilestoneController.createReview
);

router.get(
  '/milestone-submissions/:submissionId/reviews',
  authenticate,
  authorize('ADMIN', 'VERIFIER'),
  MilestoneController.listSubmissionReviews
);

router.get(
  '/milestones/:milestoneId/verification-status',
  authenticate,
  authorize('ADMIN', 'VERIFIER'),
  MilestoneController.getMilestoneVerificationStatus
);

// ─── Recovery Workflow (Admin) ───────────────────────────────────

router.get('/recoveries/reconciliation', authenticate, RecoveryController.reconciliation);
router.get('/recoveries', authenticate, RecoveryController.listCases);
router.get('/recoveries/:id', authenticate, RecoveryController.getCase);

router.post('/recoveries/failed-refund', authenticate, RecoveryController.createFailedRefundCase);
router.post('/recoveries/failed-distribution', authenticate, RecoveryController.createFailedDistributionCase);
router.post('/recoveries/:id/donor-credit', authenticate, RecoveryController.issueDonorCredit);

router.post('/refunds/:id/retry', authenticate, RecoveryController.retryRefund);
router.post('/refunds/:id/update-destination', authenticate, RecoveryController.updateRefundDestination);

router.post('/distributions/:id/retry', authenticate, RecoveryController.retryDistribution);
router.post('/distributions/:id/flag-recovery', authenticate, RecoveryController.flagDistributionRecovery);

router.post('/campaigns/:id/settle', authenticate, RecoveryController.settleCampaign);

// ─── Database Connection Pool (Admin) ────────────────────────────

/**
 * @route   GET /api/v1/admin/database/metrics
 */
router.get('/database/metrics', authenticate, authorize('ADMIN'), DatabaseController.getMetrics);

/**
 * @route   POST /api/v1/admin/database/metrics/reset
 */
router.post(
  '/database/metrics/reset',
  authenticate,
  authorize('ADMIN'),
  DatabaseController.resetMetrics
);

// ─── Admin Notification Preferences ──────────────────────────────────

const notifPrefSchema = z.object({
  typePreferences: z.record(
    z.enum([
      'DONATION_RECEIVED', 'CAMPAIGN_UPDATE', 'DISTRIBUTION_SENT', 'KYC_APPROVED', 'KYC_REJECTED',
      'ORGANIZATION_PROFILE_UPDATED', 'ORGANIZATION_VERIFICATION_SUBMITTED',
      'ORGANIZATION_VERIFICATION_APPROVED', 'ORGANIZATION_VERIFICATION_REJECTED',
      'ORGANIZATION_VERIFICATION_INFO_REQUESTED', 'BANK_ACCOUNT_ADDED',
      'BANK_ACCOUNT_REVIEW_REQUIRED', 'SYSTEM_ALERT', 'SECURITY_ALERT',
      'CAMPAIGN_SUSPENDED', 'CAMPAIGN_REINSTATED', 'APPEAL_UPDATE',
      'MILESTONE_SUBMISSION_RECEIVED', 'MILESTONE_APPROVED', 'MILESTONE_REJECTED',
      'MILESTONE_REVISION_REQUESTED', 'REFUND_FAILED', 'REFUND_RECOVERED',
      'DISTRIBUTION_FAILED', 'CAMPAIGN_SETTLEMENT', 'DONOR_CREDIT_ISSUED',
    ]),
    z.enum(['ALL', 'ALERTS_ONLY', 'NONE'])
  ).optional(),
  channels: z.array(z.enum(['EMAIL', 'IN_APP', 'SMS'])).min(1).optional(),
  frequency: z.enum(['IMMEDIATE', 'DAILY_DIGEST', 'WEEKLY']).optional(),
  campaignFilter: z.array(z.string()).optional(),
  userRoleFilter: z.array(z.enum(['ADMIN', 'ORGANIZATION', 'DONOR', 'BENEFICIARY', 'VERIFIER', 'AUDITOR'])).optional(),
  muteAll: z.boolean().optional(),
  quietHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  quietHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
}).refine(
  (d) => {
    if (d.quietHoursStart && !d.quietHoursEnd) return false;
    if (d.quietHoursEnd && !d.quietHoursStart) return false;
    return true;
  },
  { message: 'quietHoursStart and quietHoursEnd must both be set or both omitted' }
);

/**
 * @route   GET  /api/v1/admin/notification-preferences
 * @desc    Get the authenticated admin's notification preferences
 * @access  Private (ADMIN, VERIFIER, AUDITOR)
 */
router.get(
  '/notification-preferences',
  authenticate,
  authorize('ADMIN', 'VERIFIER', 'AUDITOR'),
  AdminNotificationPreferenceController.getPreferences
);

/**
 * @route   PUT  /api/v1/admin/notification-preferences
 * @desc    Create or update notification preferences (partial merge)
 * @access  Private (ADMIN, VERIFIER, AUDITOR)
 */
router.put(
  '/notification-preferences',
  authenticate,
  authorize('ADMIN', 'VERIFIER', 'AUDITOR'),
  validate(notifPrefSchema),
  AdminNotificationPreferenceController.upsertPreferences
);

/**
 * @route   DELETE /api/v1/admin/notification-preferences
 * @desc    Reset notification preferences to platform defaults
 * @access  Private (ADMIN, VERIFIER, AUDITOR)
 */
router.delete(
  '/notification-preferences',
  authenticate,
  authorize('ADMIN', 'VERIFIER', 'AUDITOR'),
  AdminNotificationPreferenceController.resetPreferences
);

/**
 * @route   GET  /api/v1/admin/notification-preferences/digest
 * @desc    List pending digest-queue entries
 * @access  Private (ADMIN, VERIFIER, AUDITOR)
 */
router.get(
  '/notification-preferences/digest',
  authenticate,
  authorize('ADMIN', 'VERIFIER', 'AUDITOR'),
  AdminNotificationPreferenceController.getPendingDigest
);

/**
 * @route   POST /api/v1/admin/notification-preferences/digest/flush
 * @desc    Manually flush all due digest notifications
 * @access  Private (ADMIN, VERIFIER, AUDITOR)
 */
router.post(
  '/notification-preferences/digest/flush',
  authenticate,
  authorize('ADMIN', 'VERIFIER', 'AUDITOR'),
  AdminNotificationPreferenceController.flushDigest
);

// ─── Matched Fund Verification (Admin) ───────────────────────────────────────

/**
 * @route   POST /api/v1/admin/matched-fund-verification/trigger
 * @desc    Enqueue an immediate (asynchronous) triggered verification job.
 *          Returns jobId for status polling.
 * @access  Private (ADMIN)
 */
router.post(
  '/matched-fund-verification/trigger',
  authenticate,
  authorize('ADMIN'),
  MatchedFundVerificationController.triggerVerification,
);

/**
 * @route   GET /api/v1/admin/matched-fund-verification/jobs/:jobId
 * @desc    Get status and result of a specific verification job.
 * @access  Private (ADMIN)
 */
router.get(
  '/matched-fund-verification/jobs/:jobId',
  authenticate,
  authorize('ADMIN'),
  MatchedFundVerificationController.getJobStatus,
);

/**
 * @route   POST /api/v1/admin/matched-fund-verification/run-sync
 * @desc    Run a verification synchronously and return the full result in the
 *          HTTP response. Use for small datasets or integration tests.
 * @access  Private (ADMIN)
 */
router.post(
  '/matched-fund-verification/run-sync',
  authenticate,
  authorize('ADMIN'),
  MatchedFundVerificationController.runSynchronous,
);

export default router;
