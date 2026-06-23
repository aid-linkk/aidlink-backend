import { Request, Response, NextFunction } from 'express';
import { NotificationService } from '../services/notification.service';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import { NotificationType } from '@prisma/client';

export class NotificationController {
  static async createNotification(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const { type, title, message, metadata } = req.body;
      
      const result = await NotificationService.createNotification(
        req.user.id,
        type,
        title,
        message,
        metadata
      );
      
      res.status(201).json({
        success: true,
        data: result,
        message: 'Notification created successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async getUserNotifications(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const status = req.query.status as string;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;

      const result = await NotificationService.getUserNotifications(req.user.id, status as any, limit);
      
      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async markAsRead(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const { id } = req.params;
      
      const result = await NotificationService.markAsRead(id, req.user.id);
      
      res.status(200).json({
        success: true,
        data: result,
        message: 'Notification marked as read',
      });
    } catch (error) {
      next(error);
    }
  }

  static async markAllAsRead(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      await NotificationService.markAllAsRead(req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'All notifications marked as read',
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteNotification(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const { id } = req.params;
      
      await NotificationService.deleteNotification(id, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Notification deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async getUnreadCount(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const count = await NotificationService.getUnreadCount(req.user.id);
      
      res.status(200).json({
        success: true,
        data: { unreadCount: count },
      });
    } catch (error) {
      next(error);
    }
  }

  static async sendDonationNotification(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const { campaignTitle, amount, currency } = req.body;
      
      await NotificationService.sendDonationReceivedNotification(req.user.id, campaignTitle, amount, currency || 'XLM');
      
      res.status(200).json({
        success: true,
        message: 'Donation notification sent successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async sendCampaignUpdateNotification(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const { campaignTitle, update } = req.body;
      
      await NotificationService.sendCampaignUpdateNotification(req.user.id, campaignTitle, update);
      
      res.status(200).json({
        success: true,
        message: 'Campaign update notification sent successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async sendDistributionNotification(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }

      const { amount, currency } = req.body;
      
      await NotificationService.sendDistributionSentNotification(req.user.id, amount, currency || 'XLM');
      
      res.status(200).json({
        success: true,
        message: 'Distribution notification sent successfully',
      });
    } catch (error) {
      next(error);
    }
  }
}
