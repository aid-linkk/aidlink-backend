import { Router } from 'express';
import { MilestoneController } from '../controllers/milestone.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validation';
import { milestoneSubmissionSchema, milestoneSubmissionUpdateSchema } from '../utils/validation';

const router = Router({ mergeParams: true });

router.use(authenticate);

/**
 * @swagger
 * /api/v1/campaigns/{campaignId}/milestones/{milestoneId}/submissions:
 *   post:
 *     summary: Create a milestone submission draft
 *     tags: [Milestones]
 *     security:
 *       - bearerAuth: []
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - description
 *               - evidenceUrls
 *               - metricsData
 *             properties:
 *               description:
 *                 type: string
 *               evidenceUrls:
 *                 type: array
 *                 items:
 *                   type: string
 *               metricsData:
 *                 type: object
 *               submissionNotes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Submission draft created
 */
router.post('/', validate(milestoneSubmissionSchema), MilestoneController.createSubmission);

/**
 * @swagger
 * /api/v1/campaigns/{campaignId}/milestones/{milestoneId}/submissions:
 *   get:
 *     summary: List all submissions for a milestone
 *     tags: [Milestones]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Submissions retrieved
 */
router.get('/', MilestoneController.listSubmissions);

/**
 * @swagger
 * /api/v1/campaigns/{campaignId}/milestones/{milestoneId}/submissions/{submissionId}:
 *   get:
 *     summary: Get submission details with review history
 *     tags: [Milestones]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Submission retrieved
 */
router.get('/:submissionId', MilestoneController.getSubmission);

/**
 * @swagger
 * /api/v1/campaigns/{campaignId}/milestones/{milestoneId}/submissions/{submissionId}:
 *   put:
 *     summary: Update a draft or revision-requested submission
 *     tags: [Milestones]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Submission updated
 */
router.put('/:submissionId', validate(milestoneSubmissionUpdateSchema), MilestoneController.updateSubmission);

/**
 * @swagger
 * /api/v1/campaigns/{campaignId}/milestones/{milestoneId}/submissions/{submissionId}/submit:
 *   post:
 *     summary: Submit for verifier review (DRAFT or REVISION_REQUESTED → SUBMITTED)
 *     tags: [Milestones]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Submission sent for review
 */
router.post('/:submissionId/submit', MilestoneController.submitForReview);

export default router;
