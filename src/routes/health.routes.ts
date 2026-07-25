import { Router, Request, Response } from 'express';
import { DatabaseController } from '../controllers/database.controller';
import { compressionMetrics } from '../utils/compressionMetrics';
import { compressionConfig } from '../middleware/compression';

const router = Router();

/**
 * @route   GET /health/db
 * @desc    Database readiness: round-trip latency, pool gauges and query stats
 * @access  Public
 */
router.get('/db', DatabaseController.getHealth);

/**
 * @route   GET /health/compression
 * @desc    Compression metrics: hit rate, bytes saved, ratio histogram, overhead
 * @access  Public — no secrets exposed
 */
router.get('/compression', (_req: Request, res: Response) => {
    res.status(200).json({
        success: true,
        data: {
            config: compressionConfig,
            metrics: compressionMetrics.snapshot(),
        },
    });
});

/**
 * @route   POST /health/compression/reset
 * @desc    Reset compression counters (useful before a benchmark run)
 * @access  Public (counters only, no data risk)
 */
router.post('/compression/reset', (_req: Request, res: Response) => {
    compressionMetrics.reset();
    res.status(200).json({ success: true, message: 'Compression metrics reset' });
});

export default router;
