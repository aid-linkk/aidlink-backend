import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { WebhookService } from '../services/webhook.service';
import { WebhookEventType, WebhookDeliveryStatus } from '@prisma/client';
import { webhookQueue } from '../workers/webhook.worker';
import prisma from '../config/database';

export class WebhookController {
  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const authReq = req as AuthRequest;
      const webhook = await WebhookService.createWebhook({ ...req.body, createdBy: authReq.user!.id });
      res.status(201).json({ success: true, data: webhook });
    } catch (err) { next(err); }
  }

  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await WebhookService.getWebhooks(Number(req.query.page) || 1, Number(req.query.limit) || 20);
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }

  static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const webhook = await WebhookService.getWebhookById(req.params.id);
      res.json({ success: true, data: webhook });
    } catch (err) { next(err); }
  }

  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const webhook = await WebhookService.updateWebhook(req.params.id, req.body);
      res.json({ success: true, data: webhook });
    } catch (err) { next(err); }
  }

  static async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await WebhookService.deleteWebhook(req.params.id);
      res.json({ success: true, message: 'Webhook deleted' });
    } catch (err) { next(err); }
  }

  static async test(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await WebhookService.testWebhook(req.params.id);
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  }

  static async getEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await WebhookService.getEventsByWebhook(
        req.params.id,
        Number(req.query.page) || 1,
        Number(req.query.limit) || 20
      );
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }

  static async getAllEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await WebhookService.getAllEvents(Number(req.query.page) || 1, Number(req.query.limit) || 20);
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }

  static async getEventById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await WebhookService.getEventById(req.params.eventId);
      res.json({ success: true, data: event });
    } catch (err) { next(err); }
  }
}

// ─── Helper used by platform services to fire webhook events ─────────────────

export async function dispatchWebhookEvent(
  eventType: WebhookEventType,
  payload: Record<string, unknown>
): Promise<void> {
  await WebhookService.dispatch(eventType, payload);

  const pending = await prisma.webhookEvent.findMany({
    where: { eventType, status: WebhookDeliveryStatus.PENDING, lastAttemptAt: null, nextRetryAt: { lte: new Date() } },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true },
  });

  await Promise.all(
    pending.map((e: { id: string }) => webhookQueue.add('deliver', { eventId: e.id }, { removeOnComplete: 100 }))
  );
}
