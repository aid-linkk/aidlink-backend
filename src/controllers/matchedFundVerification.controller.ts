import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import { Role } from '@prisma/client';
import {
  enqueueTriggedVerification,
  matchedFundVerificationQueue,
} from '../workers/matchedFundVerification.worker';
import {
  MatchedFundVerificationService,
  VerificationMode,
} from '../services/matchedFundVerification.service';
import logger from '../config/logger';

export class MatchedFundVerificationController {
  /**
   * POST /api/v1/admin/matched-fund-verification/trigger
   *
   * Enqueues an immediate triggered verification job. Returns the BullMQ job
   * ID so the caller can poll status via the GET endpoint.
   */
  static async triggerVerification(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!req.user || req.user.role !== Role.ADMIN) {
        throw new AppError('Admin access required', 403);
      }

      const autoRepair = req.body?.autoRepair !== false; // default true
      const correlationId = `admin-${req.user.id}-${Date.now()}`;

      const jobId = await enqueueTriggedVerification({ autoRepair, correlationId });

      logger.info('MatchedFundVerification: triggered by admin', {
        adminId: req.user.id,
        jobId,
        autoRepair,
      });

      res.status(202).json({
        success: true,
        data: { jobId, correlationId, autoRepair },
        message: 'Verification job enqueued',
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/matched-fund-verification/jobs/:jobId
   *
   * Returns the current state and (if finished) the full result of a
   * verification job.
   */
  static async getJobStatus(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!req.user || req.user.role !== Role.ADMIN) {
        throw new AppError('Admin access required', 403);
      }

      const { jobId } = req.params;
      const job = await matchedFundVerificationQueue.getJob(jobId);

      if (!job) {
        throw AppError.from('VERIFICATION_002');
      }

      const state = await job.getState();
      const returnValue = job.returnvalue;

      res.status(200).json({
        success: true,
        data: {
          jobId: job.id,
          type: job.data.type,
          state,
          progress: job.progress,
          attemptsMade: job.attemptsMade,
          createdAt: new Date(job.timestamp).toISOString(),
          processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
          finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
          failedReason: job.failedReason ?? null,
          result: returnValue ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/matched-fund-verification/run-sync
   *
   * Runs a verification synchronously (in-process) and returns the full
   * VerificationResult in the HTTP response. Intended for small datasets,
   * integration tests, or when the caller needs the result immediately.
   *
   * Request body:
   *   { mode?: 'FULL' | 'SAMPLE' | 'TRIGGERED', samplePct?: number, autoRepair?: boolean }
   */
  static async runSynchronous(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!req.user || req.user.role !== Role.ADMIN) {
        throw new AppError('Admin access required', 403);
      }

      const rawMode = (req.body?.mode as string | undefined) ?? 'TRIGGERED';
      const validModes: VerificationMode[] = ['FULL', 'SAMPLE', 'TRIGGERED'];
      if (!validModes.includes(rawMode as VerificationMode)) {
        throw AppError.from(
          'VERIFICATION_003',
          `mode must be one of: ${validModes.join(', ')}`,
        );
      }
      const mode = rawMode as VerificationMode;

      const rawSamplePct = req.body?.samplePct;
      if (rawSamplePct !== undefined) {
        const n = Number(rawSamplePct);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          throw AppError.from('VERIFICATION_003', 'samplePct must be an integer between 1 and 100');
        }
      }

      const autoRepair = req.body?.autoRepair !== false;
      const samplePct = rawSamplePct !== undefined ? Number(rawSamplePct) : undefined;

      logger.info('MatchedFundVerification: synchronous run requested by admin', {
        adminId: req.user.id,
        mode,
        autoRepair,
        samplePct,
      });

      const result = await MatchedFundVerificationService.verify(mode, autoRepair, samplePct);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }
}
