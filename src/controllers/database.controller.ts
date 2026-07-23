import { Request, Response } from 'express';
import {
  checkDatabaseHealth,
  databaseMetrics,
  getPoolStats,
  poolSettings,
} from '../config/database';
import { config } from '../config';

export class DatabaseController {
  /**
   * Liveness/readiness probe for the database.
   * Returns 200 when healthy or degraded, 503 when the database is unreachable
   * so load balancers can drain the instance.
   */
  static async getHealth(_req: Request, res: Response): Promise<void> {
    const health = await checkDatabaseHealth();

    res.status(health.status === 'unhealthy' ? 503 : 200).json({
      success: health.status !== 'unhealthy',
      data: {
        ...health,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /** Full query + pool metrics snapshot for this process. */
  static async getMetrics(_req: Request, res: Response): Promise<void> {
    const [pool, snapshot] = await Promise.all([
      getPoolStats(),
      Promise.resolve(databaseMetrics.snapshot()),
    ]);

    res.status(200).json({
      success: true,
      data: {
        pool: {
          ...pool,
          settings: poolSettings,
          monitorIntervalMs: config.database.monitoring.intervalMs,
        },
        ...snapshot,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /** Clears the in-memory counters, e.g. before a load-test run. */
  static async resetMetrics(_req: Request, res: Response): Promise<void> {
    databaseMetrics.reset();
    res.status(200).json({ success: true, message: 'Database metrics reset' });
  }
}

export default DatabaseController;
