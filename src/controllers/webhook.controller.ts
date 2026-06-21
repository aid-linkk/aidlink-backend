import { Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import { WebhookService } from '../services/webhook.service';

export class WebhookController {
  static async listWebhooks(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      WebhookController.requireAdmin(req);
      const webhooks = await WebhookService.listWebhooks();
      res.status(200).json({ success: true, data: webhooks });
    } catch (error) {
      next(error);
    }
  }

  static async createWebhook(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      WebhookController.requireAdmin(req);
      const webhook = await WebhookService.registerWebhook(req.body, req.user!.id);
      res.status(201).json({
        success: true,
        data: webhook,
        message: 'Webhook registered successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async getWebhook(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      WebhookController.requireAdmin(req);
      const webhook = await WebhookService.getWebhook(req.params.id);
      res.status(200).json({ success: true, data: webhook });
    } catch (error) {
      next(error);
    }
  }

  static async updateWebhook(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      WebhookController.requireAdmin(req);
      const webhook = await WebhookService.updateWebhook(req.params.id, req.body);
      res.status(200).json({
        success: true,
        data: webhook,
        message: 'Webhook updated successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteWebhook(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      WebhookController.requireAdmin(req);
      await WebhookService.deleteWebhook(req.params.id);
      res.status(200).json({
        success: true,
        message: 'Webhook disabled successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async testWebhook(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      WebhookController.requireAdmin(req);
      const event = await WebhookService.deliverTestPayload(req.params.id);
      res.status(202).json({
        success: true,
        data: event,
        message: 'Webhook test delivery queued',
      });
    } catch (error) {
      next(error);
    }
  }

  static async listWebhookEvents(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      WebhookController.requireAdmin(req);
      const events = await WebhookService.listEvents({
        webhookId: req.params.id,
        status: req.query.status as string,
        eventType: req.query.eventType as string,
      });
      res.status(200).json({ success: true, data: events });
    } catch (error) {
      next(error);
    }
  }

  static async listAllEvents(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      WebhookController.requireAdmin(req);
      const events = await WebhookService.listEvents({
        status: req.query.status as string,
        eventType: req.query.eventType as string,
      });
      res.status(200).json({ success: true, data: events });
    } catch (error) {
      next(error);
    }
  }

  static async getEvent(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      WebhookController.requireAdmin(req);
      const event = await WebhookService.getEvent(req.params.eventId);
      res.status(200).json({ success: true, data: event });
    } catch (error) {
      next(error);
    }
  }

  private static requireAdmin(req: AuthRequest): void {
    if (!req.user || req.user.role !== Role.ADMIN) {
      throw new AppError('Admin access required', 403);
    }
  }
}
