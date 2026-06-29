import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import logger from '../config/logger';

export class AuthController {
  static async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await AuthService.register(req.body, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(201).json({
        success: true,
        data: { userId: result.userId },
        message: result.message,
      });
    } catch (error) {
      next(error);
    }
  }

  static async verifyEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token } = req.query;

      if (!token || typeof token !== 'string') {
        throw new AppError('Verification token is required', 400);
      }

      await AuthService.verifyEmail(token, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(200).json({
        success: true,
        message: 'Email verified. You can now log in.',
      });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 400) {
        res.status(400).json({
          success: false,
          code: 'VERIFICATION_FAILED',
          message: error.message,
          resendUrl: '/api/v1/auth/resend-verification',
        });
        return;
      }
      next(error);
    }
  }

  static async resendVerification(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email } = req.body;

      if (!email) {
        throw new AppError('Email is required', 400);
      }

      const result = await AuthService.resendVerificationEmail(email, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await AuthService.login(req.body);

      res.status(200).json({
        success: true,
        data: result,
        message: 'Login successful',
      });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 403 && !req.body._suppressVerifyHint) {
        const message = error.message;
        if (message.includes('verify your email')) {
          res.status(403).json({
            success: false,
            code: 'EMAIL_NOT_VERIFIED',
            message,
            resendUrl: '/api/v1/auth/resend-verification',
          });
          return;
        }
      }
      next(error);
    }
  }

  static async walletAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletAddress, signature, message } = req.body;
      const result = await AuthService.walletAuth(walletAddress, signature, message);

      res.status(200).json({
        success: true,
        data: result,
        message: 'Wallet authentication successful',
      });
    } catch (error) {
      next(error);
    }
  }

  static async refreshToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        throw new AppError('Refresh token is required', 400);
      }

      const tokens = await AuthService.refreshToken(refreshToken);

      res.status(200).json({
        success: true,
        data: tokens,
        message: 'Token refreshed successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async logout(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const token = req.headers.authorization?.substring(7);

      if (!req.user || !token) {
        throw new AppError('Authentication required', 401);
      }

      await AuthService.logout(req.user.id, token);

      res.status(200).json({ success: true, message: 'Logout successful' });
    } catch (error) {
      next(error);
    }
  }

  static async logoutAll(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      await AuthService.logoutAll(req.user.id);

      res.status(200).json({ success: true, message: 'Logged out from all devices' });
    } catch (error) {
      next(error);
    }
  }

  static async getMe(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const user = await AuthService.getUserById(req.user.id);

      res.status(200).json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  }

  static async verifyEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token } = req.query;

      if (!token || typeof token !== 'string') {
        throw new AppError('Verification token is required', 400);
      }

      await AuthService.verifyEmail(token);

      res.status(200).json({
        success: true,
        message: 'Email verified successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async resendVerification(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      await AuthService.resendVerificationEmail(req.user.id);

      res.status(200).json({
        success: true,
        message: 'Verification email sent',
      });
    } catch (error) {
      next(error);
    }
  }
}