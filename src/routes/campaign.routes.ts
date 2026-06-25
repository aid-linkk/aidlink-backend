import { Router } from 'express';
import { CampaignController } from '../controllers/campaign.controller';
import { ModerationController } from '../controllers/moderation.controller';
import { MilestoneController } from '../controllers/milestone.controller';
import { AnalyticsController } from '../controllers/analytics.controller';
import { authenticate } from '../middleware/auth';
import milestoneSubmissionRoutes from './milestone.routes';
import { campaignCreateLimiter, reportLimiter } from '../middleware/rateLimit';
import { validate } from '../middleware/validation';
import { campaignSchema, fraudReportSchema, appealSchema } from '../utils/validation';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * @swagger
 * /api/v1/campaigns:
 *   post:
 *     summary: Create a new campaign
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - description
 *               - targetAmount
 *               - startDate
 *               - organizationId
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               imageUrl:
 *                 type: string
 *               targetAmount:
 *                 type: number
 *               startDate:
 *                 type: string
 *                 format: date-time
 *               endDate:
 *                 type: string
 *                 format: date-time
 *               organizationId:
 *                 type: string
 *     responses:
 *       201:
 *         description: Campaign created successfully
 */
router.post('/', campaignCreateLimiter, validate(campaignSchema), CampaignController.createCampaign);

/**
 * @swagger
 * /api/v1/campaigns:
 *   get:
 *     summary: Get all campaigns
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: organizationId
 *         schema:
 *           type: string
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Campaigns retrieved successfully
 */
router.get('/', CampaignController.getCampaigns);

/**
 * @swagger
 * /api/v1/campaigns/trending:
 *   get:
 *     summary: Get trending campaigns by donation velocity, donor growth, or impact
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [last24h, last7d, last30d]
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [trendScore, donationVelocity, distributionImpact]
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Trending campaigns retrieved successfully
 */
router.get('/trending', AnalyticsController.getTrendingCampaigns);

/**
 * @swagger
 * /api/v1/campaigns/{id}:
 *   get:
 *     summary: Get campaign by ID
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Campaign retrieved successfully
 */
router.get('/:id', CampaignController.getCampaignById);

/**
 * @swagger
 * /api/v1/campaigns/{id}:
 *   put:
 *     summary: Update campaign
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Campaign updated successfully
 */
router.put('/:id', validate(campaignSchema), CampaignController.updateCampaign);

/**
 * @swagger
 * /api/v1/campaigns/{id}:
 *   delete:
 *     summary: Delete campaign
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Campaign deleted successfully
 */
router.delete('/:id', CampaignController.deleteCampaign);

/**
 * @swagger
 * /api/v1/campaigns/{id}/status:
 *   patch:
 *     summary: Update campaign status
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [DRAFT, ACTIVE, PAUSED, COMPLETED, CANCELLED]
 *     responses:
 *       200:
 *         description: Campaign status updated successfully
 */
router.patch('/:id/status', CampaignController.updateCampaignStatus);

/**
 * @swagger
 * /api/v1/campaigns/{campaignId}/milestones:
 *   post:
 *     summary: Add milestone to campaign
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - targetAmount
 *               - order
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               targetAmount:
 *                 type: number
 *               order:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Milestone added successfully
 */
router.post('/:campaignId/milestones', CampaignController.addMilestone);

/**
 * @swagger
 * /api/v1/campaigns/{campaignId}/beneficiaries:
 *   post:
 *     summary: Assign beneficiary to campaign
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - beneficiaryId
 *             properties:
 *               beneficiaryId:
 *                 type: string
 *               assignedAmount:
 *                 type: number
 *               priority:
 *                 type: integer
 *               notes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Beneficiary assigned successfully
 */
router.post('/:campaignId/beneficiaries', CampaignController.assignBeneficiary);

/**
 * @swagger
 * /api/v1/campaigns/{id}/stats:
 *   get:
 *     summary: Get campaign statistics
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Campaign statistics retrieved successfully
 */
router.get('/:id/stats', CampaignController.getCampaignStats);

/**
 * @swagger
 * /api/v1/campaigns/{id}/impact-metrics:
 *   get:
 *     summary: Get campaign impact metrics from aggregated data
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Campaign impact metrics retrieved successfully
 */
router.get('/:id/impact-metrics', AnalyticsController.getCampaignImpactMetrics);

/**
 * @swagger
 * /api/v1/campaigns/{id}/statistics/historical:
 *   get:
 *     summary: Get monthly or weekly rollup data for trend charts
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: granularity
 *         schema:
 *           type: string
 *           enum: [hourly, monthly]
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: Historical statistics retrieved successfully
 */
router.get('/:id/statistics/historical', AnalyticsController.getCampaignHistoricalStats);

/**
 * @swagger
 * /api/v1/campaigns/{id}/reports:
 *   post:
 *     summary: Report a campaign for fraud or policy violation
 *     tags: [Campaigns, Moderation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [SCAM, MISINFORMATION, INAPPROPRIATE_CONTENT, IMPERSONATION, DUPLICATE, OTHER]
 *               details:
 *                 type: string
 *     responses:
 *       201:
 *         description: Report submitted successfully
 */
router.post('/:id/reports', reportLimiter, validate(fraudReportSchema), ModerationController.reportCampaign);

/**
 * @swagger
 * /api/v1/campaigns/{id}/appeals:
 *   post:
 *     summary: Submit an appeal for a suspended campaign (owner only)
 *     tags: [Campaigns, Moderation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - message
 *             properties:
 *               message:
 *                 type: string
 *               attachments:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       201:
 *         description: Appeal submitted successfully
 *   get:
 *     summary: List appeals for a campaign (owner or admin)
 *     tags: [Campaigns, Moderation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Appeals retrieved successfully
 */
router.post('/:id/appeals', validate(appealSchema), ModerationController.submitAppeal);
router.get('/:id/appeals', ModerationController.getCampaignAppeals);

// ─── Milestone verification (Organization) ─────────────────────

router.use('/:campaignId/milestones/:milestoneId/submissions', milestoneSubmissionRoutes);

/**
 * @swagger
 * /api/v1/campaigns/{campaignId}/milestones/{milestoneId}/verification-report:
 *   get:
 *     summary: Public-facing verification report for a milestone
 *     tags: [Milestones]
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: milestoneId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Verification report retrieved
 */
router.get(
  '/:campaignId/milestones/:milestoneId/verification-report',
  MilestoneController.getVerificationReport
);

export default router;
