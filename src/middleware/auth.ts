import { Request, Response, NextFunction } from 'express';
import { JWTUtils } from '../utils/jwt';
import { AuthRequest } from '../types';
import logger from '../config/logger';
import prisma from '../config/database';

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'No token provided',
      });
      return;
    }

    const token = authHeader.substring(7);
    const payload = JWTUtils.verifyToken(token);

    req.user = {
      id: payload.id,
      email: payload.email,
      role: payload.role,
    };

    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
    });
  }
};

export const authorize = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        error: 'Insufficient permissions',
      });
      return;
    }

    next();
  };
};

export const optionalAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const payload = JWTUtils.verifyToken(token);
      req.user = {
        id: payload.id,
        email: payload.email,
        role: payload.role,
      };
    }
    
    next();
  } catch (error) {
    // Continue without authentication if token is invalid
    next();
  }
};

/**
 * Middleware that blocks access if the user's email is not verified.
 * Use on sensitive routes after `authenticate`.
 *
 * Example:
 *   router.post('/donate', authenticate, requireEmailVerified, DonationController.create);
 */
export const requireEmailVerified = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { emailVerified: true },
    });

    if (!user?.emailVerified) {
      res.status(403).json({
        success: false,
        error: 'Email verification required',
        code: 'EMAIL_NOT_VERIFIED',
      });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
};