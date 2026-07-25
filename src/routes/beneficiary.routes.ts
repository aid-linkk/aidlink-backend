import { Router } from 'express';
import { BeneficiaryController } from '../controllers/beneficiary.controller';
import { BulkBeneficiaryController } from '../controllers/bulkBeneficiary.controller';
import { authenticate, requireVerified, authorize } from '../middleware/auth';
import { z } from 'zod';
import { validate } from '../middleware/validation';
import { uploadSingle } from '../middleware/upload';

const router = Router();

// Validation schemas
const createBeneficiarySchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  dateOfBirth: z.string().datetime('Valid date of birth is required'),
  gender: z.string().min(1, 'Gender is required'),
  nationality: z.string().min(1, 'Nationality is required'),
  idDocumentType: z.string().min(1, 'ID document type is required'),
  idDocumentNumber: z.string().min(1, 'ID document number is required'),
  phoneNumber: z.string().min(1, 'Phone number is required'),
  address: z.string().min(1, 'Address is required'),
  city: z.string().min(1, 'City is required'),
  country: z.string().min(1, 'Country is required'),
  coordinates: z.string().optional(),
  familySize: z.number().int().min(1, 'Family size must be at least 1'),
  needsAssessment: z.string().optional(),
  needsCategory: z.string().optional(),
});

const updateBeneficiarySchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phoneNumber: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  country: z.string().min(1).optional(),
  needsAssessment: z.string().optional(),
  needsCategory: z.string().optional(),
}).partial();

const updateStatusSchema = z.object({
  status: z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED', 'ACTIVE']),
});

const kycSubmissionSchema = z.object({
  documentType: z.string().min(1, 'Document type is required'),
  documentUrl: z.string().url('Document URL must be valid'),
  submissionType: z.string().min(1, 'Submission type is required'),
  selfieUrl: z.string().url().optional(),
  additionalDocs: z.any().optional(),
});

const kycReviewSchema = z.object({
  status: z.enum(['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED']),
  reviewNotes: z.string().optional(),
});

/**
 * @route   POST /api/v1/beneficiaries
 * @desc    Create a new beneficiary profile
 * @access  Private (Beneficiary)
 */
router.post(
  '/',
  authenticate,
  validate(createBeneficiarySchema),
  BeneficiaryController.createBeneficiary
);

/**
 * @route   GET /api/v1/beneficiaries
 * @desc    Get all beneficiaries with filtering and pagination
 * @access  Private (Admin, Verifier)
 */
router.get(
  '/',
  authenticate,
  authorize('ADMIN', 'VERIFIER'),
  BeneficiaryController.getBeneficiaries
);

/**
 * @route   GET /api/v1/beneficiaries/me
 * @desc    Get the authenticated user's own beneficiary profile
 * @access  Private (Beneficiary)
 */
router.get(
  '/me',
  authenticate,
  BeneficiaryController.getMyBeneficiaryProfile
);

/**
 * @route   GET /api/v1/beneficiaries/my-profile
 * @desc    Get current user's beneficiary profile
 * @access  Private (Beneficiary)
 */
router.get(
  '/my-profile',
  authenticate,
  BeneficiaryController.getMyBeneficiaryProfile
);

/**
 * @route   GET /api/v1/beneficiaries/:id
 * @desc    Get beneficiary by ID
 * @access  Private (Admin, Verifier, Beneficiary for own profile)
 */
router.get(
  '/:id',
  authenticate,
  BeneficiaryController.getBeneficiaryById
);

/**
 * @route   PUT /api/v1/beneficiaries/:id
 * @desc    Update beneficiary profile
 * @access  Private (Admin, Verifier, Beneficiary for own profile)
 */
router.put(
  '/:id',
  authenticate,
  validate(updateBeneficiarySchema),
  BeneficiaryController.updateBeneficiary
);

/**
 * @route   PATCH /api/v1/beneficiaries/:id/status
 * @desc    Update beneficiary status
 * @access  Private (Admin, Verifier)
 */
router.patch(
  '/:id/status',
  authenticate,
  validate(updateStatusSchema),
  BeneficiaryController.updateBeneficiaryStatus
);

/**
 * @route   POST /api/v1/beneficiaries/:id/risk-score
 * @desc    Calculate risk score for beneficiary
 * @access  Private (Admin, Verifier)
 */
router.post(
  '/:id/risk-score',
  authenticate,
  BeneficiaryController.calculateRiskScore
);

/**
 * @route   POST /api/v1/beneficiaries/:id/kyc
 * @desc    Submit KYC documents for beneficiary
 * @access  Private (Beneficiary — verified only)
 */
router.post(
  '/:id/kyc',
  authenticate,
  requireVerified,
  validate(kycSubmissionSchema),
  BeneficiaryController.submitKYC
);

/**
 * @route   PATCH /api/v1/beneficiaries/kyc/:submissionId/review
 * @desc    Review KYC submission
 * @access  Private (Admin, Verifier)
 */
router.patch(
  '/kyc/:submissionId/review',
  authenticate,
  validate(kycReviewSchema),
  BeneficiaryController.reviewKYC
);

// ── Bulk / Batch Routes ──────────────────────────────────────────────────────

const bulkStatusUpdateSchema = z.object({
  items: z.array(z.object({
    beneficiaryId: z.string().min(1),
    status: z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED', 'ACTIVE']),
    reason: z.string().optional(),
  })).min(1, 'At least one item is required').max(1000, 'Maximum 1000 items per batch'),
});

const bulkKYCSchema = z.object({
  items: z.array(z.object({
    beneficiaryId: z.string().min(1),
    documentType: z.string().min(1),
    documentUrl: z.string().url(),
    submissionType: z.string().min(1),
    selfieUrl: z.string().url().optional(),
  })).min(1).max(500),
});

const batchDistributionSchema = z.object({
  campaignId: z.string().min(1, 'Campaign ID is required'),
  items: z.array(z.object({
    beneficiaryId: z.string().min(1),
    amount: z.number().positive(),
    method: z.enum(['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CRYPTO', 'VOUCHER', 'IN_KIND']),
    notes: z.string().optional(),
  })).min(1).max(500),
});

const bulkNotifySchema = z.object({
  items: z.array(z.object({
    beneficiaryId: z.string().min(1),
    title: z.string().min(1).max(255),
    message: z.string().min(1).max(2000),
    metadata: z.record(z.unknown()).optional(),
  })).min(1).max(1000),
});

/**
 * @route   GET /api/v1/beneficiaries/bulk/import/template
 * @desc    Download CSV template for bulk import
 * @access  Private (Admin, Organization)
 */
router.get(
  '/bulk/import/template',
  authenticate,
  authorize('ADMIN', 'ORGANIZATION'),
  BulkBeneficiaryController.getImportTemplate
);

/**
 * @route   POST /api/v1/beneficiaries/bulk/import
 * @desc    Import beneficiaries from a CSV file
 * @access  Private (Admin, Organization)
 */
router.post(
  '/bulk/import',
  authenticate,
  authorize('ADMIN', 'ORGANIZATION'),
  uploadSingle('file'),
  BulkBeneficiaryController.importCSV
);

/**
 * @route   POST /api/v1/beneficiaries/bulk/status
 * @desc    Batch update beneficiary statuses
 * @access  Private (Admin, Verifier)
 */
router.post(
  '/bulk/status',
  authenticate,
  authorize('ADMIN', 'VERIFIER'),
  validate(bulkStatusUpdateSchema),
  BulkBeneficiaryController.batchStatusUpdate
);

/**
 * @route   POST /api/v1/beneficiaries/bulk/kyc
 * @desc    Bulk KYC submission for multiple beneficiaries
 * @access  Private (Admin, Organization)
 */
router.post(
  '/bulk/kyc',
  authenticate,
  authorize('ADMIN', 'ORGANIZATION'),
  validate(bulkKYCSchema),
  BulkBeneficiaryController.bulkKYCSubmit
);

/**
 * @route   POST /api/v1/beneficiaries/bulk/distributions
 * @desc    Batch create distributions for a campaign
 * @access  Private (Admin, Organization)
 */
router.post(
  '/bulk/distributions',
  authenticate,
  authorize('ADMIN', 'ORGANIZATION'),
  validate(batchDistributionSchema),
  BulkBeneficiaryController.batchCreateDistributions
);

/**
 * @route   POST /api/v1/beneficiaries/bulk/notify
 * @desc    Send bulk notifications to beneficiaries
 * @access  Private (Admin, Organization)
 */
router.post(
  '/bulk/notify',
  authenticate,
  authorize('ADMIN', 'ORGANIZATION'),
  validate(bulkNotifySchema),
  BulkBeneficiaryController.bulkNotify
);

/**
 * @route   GET /api/v1/beneficiaries/bulk/jobs
 * @desc    List batch jobs for the authenticated actor
 * @access  Private (Admin, Organization, Verifier)
 */
router.get(
  '/bulk/jobs',
  authenticate,
  authorize('ADMIN', 'ORGANIZATION', 'VERIFIER'),
  BulkBeneficiaryController.listJobs
);

/**
 * @route   GET /api/v1/beneficiaries/bulk/jobs/:jobId
 * @desc    Get batch job status and progress
 * @access  Private (Admin, Organization, Verifier)
 */
router.get(
  '/bulk/jobs/:jobId',
  authenticate,
  authorize('ADMIN', 'ORGANIZATION', 'VERIFIER'),
  BulkBeneficiaryController.getJobStatus
);

/**
 * @route   POST /api/v1/beneficiaries/bulk/jobs/:jobId/rollback
 * @desc    Rollback a completed or partial batch job
 * @access  Private (Admin)
 */
router.post(
  '/bulk/jobs/:jobId/rollback',
  authenticate,
  authorize('ADMIN'),
  BulkBeneficiaryController.rollbackJob
);

export default router;
