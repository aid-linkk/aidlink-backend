import { Router } from 'express';
import { DatabaseController } from '../controllers/database.controller';

const router = Router();

/**
 * @route   GET /health/db
 * @desc    Database readiness: round-trip latency, pool gauges and query stats
 * @access  Public (no query contents or credentials are exposed)
 */
router.get('/db', DatabaseController.getHealth);

export default router;
