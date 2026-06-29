import { Router } from 'express';
import { DonationController } from '../controllers/donation.controller';
import { ReceiptController } from '../controllers/receipt.controller';
import { authenticate } from '../middleware/auth';
import { donationLimiter, receiptDownloadLimiter } from '../middleware/rateLimit';
import { z } from 'zod';
import { validate } from '../middleware/validation';

const router = Router();

// Validation schemas
const createDonationSchema = z.object({
  campaignId: z.string().min(1, 'Campaign ID is required'),
  amount: z.number().positive('Amount must be positive'),
  currency: z.string().default('XLM'),
  fromWallet: z.string().optional(),
  toWallet: z.string().optional(),
  memo: z.string().optional(),
  donorMessage: z.string().optional(),
  isAnonymous: z.boolean().default(false),
  groupId: z.string().optional(),
  retentionPolicy: z.string().optional(),
});

const confirmDonationSchema = z.object({
  txHash: z.string().min(1, 'Transaction hash is required'),
});

/**
 * @route   POST /api/v1/donations
 * @desc    Create a new donation
 * @access  Private (verified users only)
 */
router.post(
  '/',
  authenticate,
  requireVerified,
  donationLimiter,
  validate(createDonationSchema),
  DonationController.createDonation
);

/**
 * @route   GET /api/v1/donations
 * @desc    Get all donations with filtering and pagination
 * @access  Private (Admin, Organization)
 */
router.get(
  '/',
  authenticate,
  DonationController.getDonations
);

/**
 * @route   GET /api/v1/donations/my-donations
 * @desc    Get current user's donations
 * @access  Private
 */
router.get(
  '/my-donations',
  authenticate,
  DonationController.getMyDonations
);

/**
 * @route   GET /api/v1/donations/campaign/:campaignId
 * @desc    Get donations for a specific campaign
 * @access  Private
 */
router.get(
  '/campaign/:campaignId',
  authenticate,
  DonationController.getCampaignDonations
);

/**
 * @route   GET /api/v1/donations/:donationId/receipt
 * @desc    Download the tax receipt PDF for a donation
 * @access  Private (Donor who owns it, owning Organization, Admin/Auditor)
 */
router.get(
  '/:donationId/receipt',
  authenticate,
  receiptDownloadLimiter,
  ReceiptController.downloadDonationReceipt
);

/**
 * @route   GET /api/v1/donations/:donationId/receipt/status
 * @desc    Get tax receipt generation/delivery status for a donation
 * @access  Private (Donor who owns it, owning Organization, Admin/Auditor)
 */
router.get(
  '/:donationId/receipt/status',
  authenticate,
  ReceiptController.getDonationReceiptStatus
);

/**
 * @route   GET /api/v1/donations/:id
 * @desc    Get donation by ID
 * @access  Private
 */
router.get(
  '/:id',
  authenticate,
  DonationController.getDonationById
);

/**
 * @route   POST /api/v1/donations/:id/confirm
 * @desc    Confirm a donation with blockchain transaction
 * @access  Private
 */
router.post(
  '/:id/confirm',
  authenticate,
  validate(confirmDonationSchema),
  DonationController.confirmDonation
);

/**
 * @route   POST /api/v1/donations/:id/reveal-identity
 * @desc    Donor opts in to reveal their identity for an anonymous donation
 * @access  Private (Donor who owns the donation)
 */
router.post(
  '/:id/reveal-identity',
  authenticate,
  DonationController.revealIdentity
);

/**
 * @route   POST /api/v1/donations/:id/refund
 * @desc    Refund a donation
 * @access  Private (Admin, Donor for own donation)
 */
router.post(
  '/:id/refund',
  authenticate,
  DonationController.refundDonation
);

export default router;
