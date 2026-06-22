import { Router } from 'express';
import { ReceiptController } from '../controllers/receipt.controller';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validation';
import { generateBatchReceiptsSchema } from '../utils/validation';

const router = Router();

/**
 * @route   GET /api/v1/admin/receipts
 * @desc    List tax receipts with filters and pagination
 * @access  Private (Admin, Auditor)
 */
router.get(
  '/',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  ReceiptController.listReceipts
);

/**
 * @route   POST /api/v1/admin/receipts/generate-batch
 * @desc    Start an asynchronous batch receipt-generation job
 * @access  Private (Admin)
 */
router.post(
  '/generate-batch',
  authenticate,
  authorize('ADMIN'),
  validate(generateBatchReceiptsSchema),
  ReceiptController.generateBatch
);

/**
 * @route   GET /api/v1/admin/receipts/batch-jobs/:jobId
 * @desc    Get status/progress of a batch job
 * @access  Private (Admin, Auditor)
 */
router.get(
  '/batch-jobs/:jobId',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  ReceiptController.getBatchJob
);

/**
 * @route   POST /api/v1/admin/receipts/:receiptId/resend-email
 * @desc    Resend the receipt email to the donor
 * @access  Private (Admin)
 */
router.post(
  '/:receiptId/resend-email',
  authenticate,
  authorize('ADMIN'),
  ReceiptController.resendEmail
);

/**
 * @route   GET /api/v1/admin/receipts/:receiptId
 * @desc    Get a single receipt with delivery details
 * @access  Private (Admin, Auditor)
 */
router.get(
  '/:receiptId',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  ReceiptController.getReceiptById
);

export default router;
