import { Router } from 'express';
import { BlockchainController } from '../controllers/blockchain.controller';
import { authenticate } from '../middleware/auth';

const router = Router();

/**
 * @route   GET /api/v1/admin/blockchain/transactions
 * @desc    List blockchain transactions with filtering and pagination
 * @access  Private (Admin, Auditor)
 * @query   status, contractAddress, txHash, fromAddress, toAddress, type, blockNumber,
 *          createdAtFrom, createdAtTo, sortBy, sortOrder, page, limit
 */
router.get('/transactions', authenticate, BlockchainController.getTransactions);

/**
 * @route   GET /api/v1/admin/blockchain/transactions/:id
 * @desc    Get a single blockchain transaction by ID
 * @access  Private (Admin, Auditor)
 */
router.get('/transactions/:id', authenticate, BlockchainController.getTransactionById);

/**
 * @route   GET /api/v1/admin/blockchain/events
 * @desc    List contract events with filtering and pagination
 * @access  Private (Admin, Auditor)
 * @query   contractAddress, eventName, processed, txHash,
 *          createdAtFrom, createdAtTo, sortBy, sortOrder, page, limit
 */
router.get('/events', authenticate, BlockchainController.getEvents);

/**
 * @route   GET /api/v1/admin/blockchain/events/:id
 * @desc    Get a single contract event by ID
 * @access  Private (Admin, Auditor)
 */
router.get('/events/:id', authenticate, BlockchainController.getEventById);

export default router;
