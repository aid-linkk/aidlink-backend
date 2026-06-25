import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import { Role } from '@prisma/client';
import { BlockchainService } from '../services/blockchain.service';

const ALLOWED_ROLES = [Role.ADMIN, Role.AUDITOR];

export class BlockchainController {
  static async getTransactions(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || !ALLOWED_ROLES.includes(req.user.role as Role)) {
        throw new AppError('Admin or Auditor access required', 403);
      }

      const {
        status,
        contractAddress,
        txHash,
        fromAddress,
        toAddress,
        type,
        blockNumber,
        createdAtFrom,
        createdAtTo,
        sortBy,
        sortOrder,
        page,
        limit,
      } = req.query as Record<string, string>;

      const result = await BlockchainService.getTransactions({
        status,
        contractAddress,
        txHash,
        fromAddress,
        toAddress,
        type,
        blockNumber: blockNumber ? BigInt(blockNumber) : undefined,
        createdAtFrom: createdAtFrom ? new Date(createdAtFrom) : undefined,
        createdAtTo: createdAtTo ? new Date(createdAtTo) : undefined,
        sortBy: sortBy as 'createdAt' | 'blockNumber' | 'status' | undefined,
        sortOrder: sortOrder as 'asc' | 'desc' | undefined,
        page: page ? parseInt(page) : undefined,
        limit: limit ? parseInt(limit) : undefined,
      });

      res.status(200).json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  static async getTransactionById(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || !ALLOWED_ROLES.includes(req.user.role as Role)) {
        throw new AppError('Admin or Auditor access required', 403);
      }

      const tx = await BlockchainService.getTransactionById(req.params.id);
      if (!tx) throw new AppError('Transaction not found', 404);

      res.status(200).json({ success: true, data: tx });
    } catch (error) {
      next(error);
    }
  }

  static async getEvents(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || !ALLOWED_ROLES.includes(req.user.role as Role)) {
        throw new AppError('Admin or Auditor access required', 403);
      }

      const {
        contractAddress,
        eventName,
        processed,
        txHash,
        createdAtFrom,
        createdAtTo,
        sortBy,
        sortOrder,
        page,
        limit,
      } = req.query as Record<string, string>;

      const result = await BlockchainService.getEvents({
        contractAddress,
        eventName,
        processed: processed !== undefined ? processed === 'true' : undefined,
        txHash,
        createdAtFrom: createdAtFrom ? new Date(createdAtFrom) : undefined,
        createdAtTo: createdAtTo ? new Date(createdAtTo) : undefined,
        sortBy: sortBy as 'createdAt' | 'processedAt' | undefined,
        sortOrder: sortOrder as 'asc' | 'desc' | undefined,
        page: page ? parseInt(page) : undefined,
        limit: limit ? parseInt(limit) : undefined,
      });

      res.status(200).json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  static async getEventById(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || !ALLOWED_ROLES.includes(req.user.role as Role)) {
        throw new AppError('Admin or Auditor access required', 403);
      }

      const event = await BlockchainService.getEventById(req.params.id);
      if (!event) throw new AppError('Event not found', 404);

      res.status(200).json({ success: true, data: event });
    } catch (error) {
      next(error);
    }
  }
}
