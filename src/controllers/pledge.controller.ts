import { Request, Response, NextFunction } from 'express';
import { PledgeService } from '../services/pledge.service';
import { PledgeType, PledgeStatus } from '@prisma/client';
import { AuthRequest } from '../types';
import { ApiErrorCode, createErrorResponse } from '../middleware/error';

export function createPledgeController(pledgeService: PledgeService) {
  /**
   * @notice POST /pledges
   * Create a new pledge
   */
  async function createPledge(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        donorId,
        campaignId,
        amount,
        currency,
        type,
        cadence,
        startDate,
        endDate,
        idempotencyKey,
        metadata,
      } = req.body;

      if (!amount || !type || !startDate) {
        return res
          .status(400)
          .json(createErrorResponse(ApiErrorCode.BAD_REQUEST, 'amount, type, and startDate are required'));
      }

      if (!Object.values(PledgeType).includes(type)) {
        return res
          .status(400)
          .json(createErrorResponse(ApiErrorCode.BAD_REQUEST, 'type must be ONE_OFF or RECURRING'));
      }

      const pledge = await pledgeService.createPledge({
        donorId: donorId ?? (req as AuthRequest).user?.id,
        campaignId,
        amount: Number(amount),
        currency,
        type,
        cadence,
        startDate: new Date(startDate),
        endDate: endDate ? new Date(endDate) : undefined,
        idempotencyKey,
        metadata,
      });

      return res.status(201).json({ status: 'success', data: pledge });
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('required')) {
        return res.status(400).json(createErrorResponse(ApiErrorCode.BAD_REQUEST, error.message));
      }
      next(error);
    }
  }

  /**
   * @notice GET /pledges/:id
   * Get pledge details with recent attempts
   */
  async function getPledge(req: Request, res: Response, next: NextFunction) {
    try {
      const pledge = await pledgeService.getPledgeById(req.params.id);
      if (!pledge) {
        return res.status(404).json(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Pledge not found'));
      }
      return res.json({ status: 'success', data: pledge });
    } catch (error) {
      next(error);
    }
  }

  /**
   * @notice GET /pledges
   * List pledges with pagination
   */
  async function listPledges(req: Request, res: Response, next: NextFunction) {
    try {
      const { status, page, limit } = req.query;
      const donorId = (req as AuthRequest).user?.id;

      const result = await pledgeService.listPledges({
        donorId,
        status: status as PledgeStatus | undefined,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      });

      return res.json({ status: 'success', ...result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * @notice POST /pledges/:id/cancel
   * Cancel a pledge
   */
  async function cancelPledge(req: Request, res: Response, next: NextFunction) {
    try {
      const { reason } = req.body;
      const pledge = await pledgeService.cancelPledge(req.params.id, reason);
      return res.json({ status: 'success', data: pledge });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'Pledge not found') {
        return res.status(404).json(createErrorResponse(ApiErrorCode.NOT_FOUND, error.message));
      }
      if (error instanceof Error && error.message.includes('already cancelled')) {
        return res.status(409).json(createErrorResponse(ApiErrorCode.CONFLICT, error.message));
      }
      next(error);
    }
  }

  /**
   * @notice GET /admin/pledges
   * Admin: list all pledges
   */
  async function adminListPledges(req: Request, res: Response, next: NextFunction) {
    try {
      const { status, donorId, page, limit } = req.query;
      const result = await pledgeService.listPledges({
        donorId: donorId as string | undefined,
        status: status as PledgeStatus | undefined,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      });
      return res.json({ status: 'success', ...result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * @notice POST /admin/pledges/:id/pause
   * Admin: pause or resume a pledge
   */
  async function adminPausePledge(req: Request, res: Response, next: NextFunction) {
    try {
      const { action } = req.body;
      const pledge = action === 'resume'
        ? await pledgeService.resumePledge(req.params.id)
        : await pledgeService.pausePledge(req.params.id);
      return res.json({ status: 'success', data: pledge });
    } catch (error) {
      next(error);
    }
  }

  /**
   * @notice GET /admin/pledges/:id/attempts
   * Admin: list attempts for a pledge
   */
  async function adminListAttempts(req: Request, res: Response, next: NextFunction) {
    try {
      const attempts = await pledgeService.listAttempts(req.params.id);
      return res.json({ status: 'success', data: attempts });
    } catch (error) {
      next(error);
    }
  }

  return {
    createPledge,
    getPledge,
    listPledges,
    cancelPledge,
    adminListPledges,
    adminPausePledge,
    adminListAttempts,
  };
}
