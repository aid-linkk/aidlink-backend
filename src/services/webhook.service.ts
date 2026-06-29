import crypto from 'crypto';
import axios from 'axios';
import prisma from '../config/database';
import { WebhookEventType, WebhookDeliveryStatus } from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { stripDonorPII } from '../utils/anonymity';

const MAX_ATTEMPTS = 5;

// Exponential backoff delays in ms: 0, 30s, 5m, 30m, 2h
const RETRY_DELAYS = [0, 30_000, 300_000, 1_800_000, 7_200_000];

export class WebhookService {
  // ─── CRUD ──────────────────────────────────────────────────────────────────

  static async createWebhook(data: {
    name: string;
    url: string;
    secret: string;
    events: WebhookEventType[];
    description?: string;
    createdBy: string;
  }) {
    if (!data.url.startsWith('https://')) {
      throw new AppError('Webhook URL must use HTTPS', 400);
    }
    return prisma.webhookSubscription.create({ data });
  }

  static async getWebhooks(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      prisma.webhookSubscription.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.webhookSubscription.count(),
    ]);
    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  static async getWebhookById(id: string) {
    const webhook = await prisma.webhookSubscription.findUnique({ where: { id } });
    if (!webhook) throw new AppError('Webhook not found', 404);
    return webhook;
  }

  static async updateWebhook(
    id: string,
    data: Partial<{
      name: string;
      url: string;
      secret: string;
      events: WebhookEventType[];
      active: boolean;
      description: string;
    }>
  ) {
    await this.getWebhookById(id);
    if (data.url && !data.url.startsWith('https://')) {
      throw new AppError('Webhook URL must use HTTPS', 400);
    }
    return prisma.webhookSubscription.update({ where: { id }, data });
  }

  static async deleteWebhook(id: string) {
    await this.getWebhookById(id);
    await prisma.webhookSubscription.delete({ where: { id } });
  }

  // ─── Event dispatch ─────────────────────────────────────────────────────────

  static async dispatch(eventType: WebhookEventType, payload: Record<string, unknown>) {
    const webhooks = await prisma.webhookSubscription.findMany({
      where: { active: true, events: { has: eventType } },
    });

    if (webhooks.length === 0) return;

    // Strip donor PII from outbound webhook payloads for anonymous donations
    const safePayload = payload.isAnonymous ? stripDonorPII(payload) : payload;
    const enriched = { event: eventType, timestamp: new Date().toISOString(), ...safePayload };

    await Promise.all(
      webhooks.map((wh: any) =>
        prisma.webhookEvent.create({
          data: {
            webhookId: wh.id,
            eventType,
            payload: enriched as any,
            status: WebhookDeliveryStatus.PENDING,
            maxAttempts: MAX_ATTEMPTS,
            nextRetryAt: new Date(),
          },
        })
      )
    );

    logger.info(`Dispatched webhook event ${eventType} to ${webhooks.length} subscriber(s)`);
  }

  // ─── Delivery ───────────────────────────────────────────────────────────────

  static signPayload(secret: string, body: string): string {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  static async deliverEvent(eventId: string): Promise<void> {
    const event = await prisma.webhookEvent.findUnique({
      where: { id: eventId },
      include: { webhook: true },
    });

    if (!event || event.status === WebhookDeliveryStatus.SENT) return;
    if (!event.webhook.active) {
      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: WebhookDeliveryStatus.DISABLED },
      });
      return;
    }

    const body = JSON.stringify(event.payload);
    const signature = this.signPayload(event.webhook.secret, body);
    const attempt = event.attempts + 1;

    try {
      const response = await axios.post(event.webhook.url, event.payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-AidLink-Signature': signature,
          'X-AidLink-Event': event.eventType,
          'X-AidLink-Delivery': event.id,
        },
        timeout: 10_000,
      });

      await prisma.$transaction([
        prisma.webhookEvent.update({
          where: { id: eventId },
          data: {
            status: WebhookDeliveryStatus.SENT,
            attempts: attempt,
            lastAttemptAt: new Date(),
            responseCode: response.status,
            responseBody: JSON.stringify(response.data).substring(0, 1000),
            errorMessage: null,
            nextRetryAt: null,
          },
        }),
        prisma.webhookSubscription.update({
          where: { id: event.webhookId },
          data: { lastSuccessAt: new Date(), failureCount: 0 },
        }),
      ]);

      logger.info(`Webhook event ${eventId} delivered to ${event.webhook.url}`);
    } catch (err: any) {
      const responseCode = err.response?.status ?? null;
      const responseBody = err.response ? JSON.stringify(err.response.data).substring(0, 1000) : null;
      const errorMessage = err.message;

      // Do not retry permanent 4xx errors (except 429)
      const isPermanentFailure =
        responseCode && responseCode >= 400 && responseCode < 500 && responseCode !== 429;

      const isFinalAttempt = attempt >= event.maxAttempts;

      let status: WebhookDeliveryStatus;
      let nextRetryAt: Date | null = null;

      if (isPermanentFailure || isFinalAttempt) {
        status = WebhookDeliveryStatus.FAILED;
      } else {
        status = WebhookDeliveryStatus.PENDING;
        const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1];
        nextRetryAt = new Date(Date.now() + delay);
      }

      await prisma.$transaction([
        prisma.webhookEvent.update({
          where: { id: eventId },
          data: {
            status,
            attempts: attempt,
            lastAttemptAt: new Date(),
            responseCode,
            responseBody,
            errorMessage,
            nextRetryAt,
          },
        }),
        prisma.webhookSubscription.update({
          where: { id: event.webhookId },
          data: { failureCount: { increment: 1 } },
        }),
      ]);

      logger.warn(`Webhook event ${eventId} delivery failed (attempt ${attempt}): ${errorMessage}`);
    }
  }

  // ─── Retry processor (called by worker) ────────────────────────────────────

  static async processDueRetries(): Promise<void> {
    const due = await prisma.webhookEvent.findMany({
      where: {
        status: WebhookDeliveryStatus.PENDING,
        nextRetryAt: { lte: new Date() },
      },
      take: 50,
    });

    await Promise.allSettled(due.map((e) => this.deliverEvent(e.id)));
  }

  // ─── Test delivery ──────────────────────────────────────────────────────────

  static async testWebhook(id: string) {
    const webhook = await this.getWebhookById(id);
    const testPayload = {
      event: 'webhook.test',
      timestamp: new Date().toISOString(),
      webhookId: id,
      message: 'This is a test delivery from AidLink',
    };

    const body = JSON.stringify(testPayload);
    const signature = this.signPayload(webhook.secret, body);

    try {
      const response = await axios.post(webhook.url, testPayload, {
        headers: {
          'Content-Type': 'application/json',
          'X-AidLink-Signature': signature,
          'X-AidLink-Event': 'webhook.test',
        },
        timeout: 10_000,
      });
      return { success: true, status: response.status };
    } catch (err: any) {
      return { success: false, status: err.response?.status, error: err.message };
    }
  }

  // ─── Event history ──────────────────────────────────────────────────────────

  static async getEventsByWebhook(webhookId: string, page = 1, limit = 20) {
    await this.getWebhookById(webhookId);
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      prisma.webhookEvent.findMany({
        where: { webhookId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.webhookEvent.count({ where: { webhookId } }),
    ]);
    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  static async getAllEvents(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      prisma.webhookEvent.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { webhook: { select: { id: true, name: true, url: true } } },
      }),
      prisma.webhookEvent.count(),
    ]);
    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  static async getEventById(eventId: string) {
    const event = await prisma.webhookEvent.findUnique({
      where: { id: eventId },
      include: { webhook: { select: { id: true, name: true, url: true } } },
    });
    if (!event) throw new AppError('Webhook event not found', 404);
    return event;
  }
}
