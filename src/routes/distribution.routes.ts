import { Router } from 'express';
import { DistributionController } from '../controllers/distribution.controller';
import { authenticate, requireVerified } from '../middleware/auth';
import { distributionLimiter } from '../middleware/rateLimit';
import { z } from 'zod';
import { validate } from '../middleware/validation';

const router = Router();

// Validation schemas
const createDistributionSchema = z.object({
  campaignId: z.string().min(1, 'Campaign ID is required'),
  beneficiaryId: z.string().min(1, 'Beneficiary ID is required'),
  amount: z.number().positive('Amount must be positive'),
  currency: z.string().default('XLM'),
  method: z.enum(['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CRYPTO', 'VOUCHER', 'IN_KIND']),
  notes: z.string().optional(),
});

const confirmDistributionSchema = z.object({
  txHash: z.string().min(1, 'Transaction hash is required'),
});

const updateStatusSchema = z.object({
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED']),
});

const addProofSchema = z.object({
  proofDocumentUrl: z.string().url('Proof document URL must be valid'),
});

/**
 * @route   POST /api/v1/distributions
 * @desc    Create a new distribution
 * @access  Private (Organization, Admin — verified only)
 */
router.post(
  '/',
  authenticate,
  requireVerified,
  distributionLimiter,
  validate(createDistributionSchema),
  DistributionController.createDistribution
);

/**
 * @route   GET /api/v1/distributions
 * @desc    Get all distributions with filtering and pagination
 * @access  Private (Admin, Organization)
 */
router.get(
  '/',
  authenticate,
  DistributionController.getDistributions
);

/**
 * @route   GET /api/v1/distributions/campaign/:campaignId
 * @desc    Get distributions for a specific campaign
 * @access  Private
 */
router.get(
  '/campaign/:campaignId',
  authenticate,
  DistributionController.getCampaignDistributions
);

/**
 * @route   GET /api/v1/distributions/beneficiary/:beneficiaryId
 * @desc    Get distributions for a specific beneficiary
 * @access  Private
 */
router.get(
  '/beneficiary/:beneficiaryId',
  authenticate,
  DistributionController.getBeneficiaryDistributions
);

/**
 * @route   POST /api/v1/distributions/:id/confirm
 * @desc    Confirm a distribution with blockchain transaction
 * @access  Private (Organization, Admin)
 */
router.post(
  '/:id/confirm',
  authenticate,
  validate(confirmDistributionSchema),
  DistributionController.confirmDistribution
);

/**
 * @route   PATCH /api/v1/distributions/:id/status
 * @desc    Update distribution status
 * @access  Private (Organization, Admin)
 */
router.patch(
  '/:id/status',
  authenticate,
  validate(updateStatusSchema),
  DistributionController.updateDistributionStatus
);

/**
 * @route   POST /api/v1/distributions/:id/proof
 * @desc    Add proof document to distribution
 * @access  Private (Organization, Admin)
 */
router.post(
  '/:id/proof',
  authenticate,
  validate(addProofSchema),
  DistributionController.addProofDocument
);

export default router;
