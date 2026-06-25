import { Router } from 'express';
import { AnalyticsController } from '../controllers/analytics.controller';
import { authenticate } from '../middleware/auth';
import { analyticsLimiter } from '../middleware/rateLimit';

const router = Router();

/**
 * @route   GET /api/v1/analytics/campaign/:campaignId
 * @desc    Get analytics for a specific campaign
 * @access  Private
 */
router.get(
  '/campaign/:campaignId',
  authenticate,
  analyticsLimiter,
  AnalyticsController.getCampaignAnalytics
);

/**
 * @route   GET /api/v1/analytics/donor
 * @desc    Get analytics for current donor
 * @access  Private
 */
router.get(
  '/donor',
  authenticate,
  analyticsLimiter,
  AnalyticsController.getDonorAnalytics
);

/**
 * @route   GET /api/v1/analytics/organization/:organizationId
 * @desc    Get analytics for an organization
 * @access  Private
 */
router.get(
  '/organization/:organizationId',
  authenticate,
  analyticsLimiter,
  AnalyticsController.getOrganizationAnalytics
);

/**
 * @route   GET /api/v1/analytics/platform
 * @desc    Get platform-wide analytics
 * @access  Private (Admin)
 */
router.get(
  '/platform',
  authenticate,
  analyticsLimiter,
  AnalyticsController.getPlatformAnalytics
);

/**
 * @route   POST /api/v1/analytics/report/:reportType
 * @desc    Generate a report
 * @access  Private
 */
router.post(
  '/report/:reportType',
  authenticate,
  analyticsLimiter,
  AnalyticsController.generateReport
);

/**
 * @route   GET /api/v1/analytics/campaigns
 * @desc    Admin endpoint to query aggregated campaign metrics
 * @access  Private (Admin)
 */
router.get(
  '/campaigns',
  authenticate,
  analyticsLimiter,
  AnalyticsController.getAggregatedCampaignAnalytics
);

export default router;
