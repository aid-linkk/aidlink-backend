import { Router } from 'express';
import { SearchController } from '../controllers/search.controller';
import { authenticate, authorize } from '../middleware/auth';
import { searchLimiter } from '../middleware/rateLimit';

const router = Router();

/**
 * @route   GET /api/v1/search/campaigns
 * @desc    Search campaigns with advanced filtering
 * @access  Private
 */
router.get(
  '/campaigns',
  authenticate,
  searchLimiter,
  SearchController.searchCampaigns
);

/**
 * @route   GET /api/v1/search/donations
 * @desc    Search donations with advanced filtering
 * @access  Private
 */
router.get(
  '/donations',
  authenticate,
  searchLimiter,
  SearchController.searchDonations
);

/**
 * @route   GET /api/v1/search/beneficiaries
 * @desc    Search beneficiaries with advanced filtering, pagination, sorting and facets
 * @query   q, country, city, needsCategory, verificationStatus,
 *          riskScoreMin, riskScoreMax, ageMin, ageMax, familySizeMin, familySizeMax,
 *          page, limit, sortBy (relevance|createdAt|updatedAt|riskScore|age|familySize),
 *          sortOrder (asc|desc)
 * @access  Private (Admin, Verifier) — exposes beneficiary PII
 */
router.get(
  '/beneficiaries',
  authenticate,
  authorize('ADMIN', 'VERIFIER'),
  searchLimiter,
  SearchController.searchBeneficiaries
);

/**
 * @route   GET /api/v1/search/distributions
 * @desc    Search distribution history with advanced filtering, pagination and sorting
 * @query   q, distributionId, campaignId, campaignName, beneficiaryId, beneficiaryName,
 *          status (PENDING|IN_PROGRESS|COMPLETED|FAILED|CANCELLED),
 *          method (CASH|BANK_TRANSFER|MOBILE_MONEY|CRYPTO|VOUCHER|IN_KIND),
 *          location, distributedBy, dateFrom, dateTo, minAmount, maxAmount,
 *          page, limit, sortBy (distributedAt|createdAt|amount|status|campaignName|beneficiaryName),
 *          sortOrder (asc|desc)
 * @access  Private (Admin, Verifier) — exposes beneficiary-linked delivery records
 */
router.get(
  '/distributions',
  authenticate,
  authorize('ADMIN', 'VERIFIER'),
  searchLimiter,
  SearchController.searchDistributions
);

/**
 * @route   GET /api/v1/search/assignments
 * @desc    Search beneficiary assignment records with advanced filtering, pagination and sorting
 * @query   q, assignmentId, campaignId, campaignName, beneficiaryId, beneficiaryName,
 *          needsCategory, location, priorityMin, priorityMax, dateFrom, dateTo,
 *          page, limit, sortBy (assignedAt|priority|campaignName|beneficiaryName),
 *          sortOrder (asc|desc)
 * @access  Private (Admin, Verifier) — exposes beneficiary PII
 */
router.get(
  '/assignments',
  authenticate,
  authorize('ADMIN', 'VERIFIER'),
  searchLimiter,
  SearchController.searchAssignments
);

/**
 * @route   GET /api/v1/search/global
 * @desc    Global search across all entities
 * @access  Private
 */
router.get(
  '/global',
  authenticate,
  searchLimiter,
  SearchController.globalSearch
);

/**
 * @route   GET /api/v1/search/advanced
 * @desc    Advanced search with entity type filtering
 * @query   entityType (campaign|donation|beneficiary|distribution|assignment|global), plus the
 *          shared filters (query, dateFrom, dateTo, status, country, minAmount, maxAmount,
 *          campaignId, beneficiaryId, sortBy, sortOrder, page, limit). For entity-specific
 *          filters not covered here, use the dedicated /distributions or /assignments endpoints.
 * @access  Private
 */
router.get(
  '/advanced',
  authenticate,
  searchLimiter,
  SearchController.advancedSearch
);

export default router;
