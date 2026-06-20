import { Router } from 'express';
import { UploadController } from '../controllers/upload.controller';
import { authenticate } from '../middleware/auth';
import { uploadSingle } from '../middleware/upload';

const router = Router();

router.use(authenticate);

/**
 * @swagger
 * /api/v1/upload/profile-picture:
 *   post:
 *     summary: Upload organization profile picture
 *     tags: [Upload]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Profile picture uploaded successfully
 */
router.post(
  '/profile-picture',
  uploadSingle('file'),
  UploadController.uploadProfilePicture,
);

/**
 * @swagger
 * /api/v1/upload/kyc/{submissionId}/document:
 *   post:
 *     summary: Upload KYC document for a submission
 *     tags: [Upload]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: submissionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: field
 *         schema:
 *           type: string
 *           enum: [document, selfie]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: KYC document uploaded successfully
 */
router.post(
  '/kyc/:submissionId/document',
  uploadSingle('file'),
  UploadController.uploadKycDocument,
);

/**
 * @swagger
 * /api/v1/upload/campaign/{campaignId}/image:
 *   post:
 *     summary: Upload campaign image
 *     tags: [Upload]
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
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Campaign image uploaded successfully
 */
router.post(
  '/campaign/:campaignId/image',
  uploadSingle('file'),
  UploadController.uploadCampaignImage,
);

/**
 * @swagger
 * /api/v1/upload/distribution/{distributionId}/proof:
 *   post:
 *     summary: Upload distribution proof document
 *     tags: [Upload]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: distributionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Proof document uploaded successfully
 */
router.post(
  '/distribution/:distributionId/proof',
  uploadSingle('file'),
  UploadController.uploadDistributionProof,
);

/**
 * @swagger
 * /api/v1/upload/presigned:
 *   post:
 *     summary: Generate a pre-signed URL for direct client-side upload
 *     tags: [Upload]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - uploadType
 *               - entityId
 *               - mimeType
 *             properties:
 *               uploadType:
 *                 type: string
 *                 enum: [profile-picture, kyc-document, campaign-image, distribution-proof]
 *               entityId:
 *                 type: string
 *               mimeType:
 *                 type: string
 *     responses:
 *       200:
 *         description: Pre-signed upload URL generated
 */
router.post('/presigned', UploadController.getPresignedUploadUrl);

export default router;
