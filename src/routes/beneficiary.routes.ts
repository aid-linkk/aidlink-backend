import { Router } from 'express';
import { BeneficiaryController } from '../controllers/beneficiary.controller';
import { authenticate, requireVerified } from '../middleware/auth';
import { z } from 'zod';
import { validate } from '../middleware/validation';

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

export default router;
