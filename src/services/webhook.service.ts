import crypto from 'crypto';
import prisma from '../config/database';
import config from '../config';
import logger from '../config/logger';
import { AppError } from '../middleware/error';
import { WebhookDeliveryStatus } from '@prisma/client';

export type WebhookEventType =
  | 'donation.confirmed'
  | 'distribution.completed'
  | 'campaign.milestone_reached'
  | 'kyc.status_changed';

export interface WebhookPayload {
  id: string;
  type: WebhookEventType;
  timestamp: string;
  resource: {
    type: string;
    id: string;
  };
  data: Record<string, unknown>;
}

interface RegisterWebhookInput {
  name: string;
  url: string;
  events: WebhookEventType[];
  secret: string;
  active?: boolean;
  description?: string;
  deliverTestPayload?: boolean;
}

interface UpdateWebhookInput {
  name?: string;
  url?: string;
  events?: WebhookEventType[];
  secret?: string;
  active?: boolean;
  description?: string | null;
}

interface DispatchEventInput {
  type: WebhookEventType;
  resource: {
    type: string;
    id: string;
  };
  data: Record<string, unknown>;
}

const TRANSIENT_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class WebhookService {
  static supportedEvents: WebhookEventType[] = [
    'donation.confirmed',
    'distribution.completed',
    'campaign.milestone_reached',
    'kyc.status_changed',
  ];

  private static httpClient: typeof fetch = fetch;

  static setHttpClient(client: typeof fetch): void {
    WebhookService.httpClient = client;
  }

  static resetHttpClient(): void {
    WebhookService.httpClient = fetch;
  }

  static signPayload(payload: unknown, secret: string): string {
    const body = typeof payload === 'string' ? payload : WebhookService.stringifyPayload(payload);
    const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
    return `sha256=${digest}`;
  }

  static verifySignature(payload: unknown, signature: string, secret: string): boolean {
    const expected = WebhookService.signPayload(payload, secret);
    if (expected.length !== signature.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  static async registerWebhook(data: RegisterWebhookInput, createdBy?: string): Promise<any> {
    WebhookService.validateEvents(data.events);

    const webhook = await prisma.webhookSubscription.create({
      data: {
        name: data.name,
        url: data.url,
        events: data.events,
        secret: data.secret,
        active: data.active ?? true,
        description: data.description,
        createdBy,
      },
    });

    if (data.deliverTestPayload) {
      WebhookService.deliverTestPayload(webhook.id).catch((error) => {
        logger.error(`Webhook test delivery failed after registration: ${webhook.id}`, error);
      });
    }

    return WebhookService.sanitizeWebhook(webhook);
  }

  static async listWebhooks(): Promise<any[]> {
    const webhooks = await prisma.webhookSubscription.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return Promise.all(webhooks.map((webhook: any) => WebhookService.withStatusSummary(webhook)));
  }

  static async getWebhook(id: string): Promise<any> {
    const webhook = await prisma.webhookSubscription.findUnique({
      where: { id },
    });

    if (!webhook) {
      throw new AppError('Webhook not found', 404);
    }

    return WebhookService.withStatusSummary(webhook);
  }

  static async updateWebhook(id: string, data: UpdateWebhookInput): Promise<any> {
    if (data.events) {
      WebhookService.validateEvents(data.events);
    }

    const existing = await prisma.webhookSubscription.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError('Webhook not found', 404);
    }

    const updated = await prisma.webhookSubscription.update({
      where: { id },
      data,
    });

    return WebhookService.sanitizeWebhook(updated);
  }

  static async deleteWebhook(id: string): Promise<void> {
    const existing = await prisma.webhookSubscription.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError('Webhook not found', 404);
    }

    await prisma.webhookSubscription.update({
      where: { id },
      data: { active: false },
    });
  }

  static async deliverTestPayload(id: string): Promise<any> {
    const webhook = await prisma.webhookSubscription.findUnique({ where: { id } });
    if (!webhook) {
      throw new AppError('Webhook not found', 404);
    }

    const payload = WebhookService.buildPayload({
      type: 'donation.confirmed',
      resource: { type: 'webhook_test', id },
      data: { test: true, webhookId: id },
    });

    const event = await prisma.webhookEvent.create({
      data: {
        webhookId: id,
        eventType: payload.type,
        payload: payload as any,
        status: webhook.active ? WebhookDeliveryStatus.PENDING : WebhookDeliveryStatus.DISABLED,
        maxAttempts: config.webhooks.maxAttempts,
      },
    });

    if (!webhook.active) {
      return event;
    }

    return WebhookService.deliverEvent(event.id);
  }

  static async dispatchEvent(input: DispatchEventInput): Promise<void> {
    WebhookService.validateEvents([input.type]);

    const subscriptions = await prisma.webhookSubscription.findMany({
      where: {
        active: true,
        events: { has: input.type },
      },
    });

    const payload = WebhookService.buildPayload(input);

    await Promise.all(subscriptions.map(async (webhook: any) => {
      const event = await prisma.webhookEvent.create({
        data: {
          webhookId: webhook.id,
          eventType: input.type,
          payload: payload as any,
          status: WebhookDeliveryStatus.PENDING,
          maxAttempts: config.webhooks.maxAttempts,
        },
      });

      WebhookService.deliverEvent(event.id).catch((error) => {
        logger.error(`Webhook delivery failed for event ${event.id}`, error);
      });
    }));
  }

  static dispatchEventSafely(input: DispatchEventInput): void {
    WebhookService.dispatchEvent(input).catch((error) => {
      logger.error(`Webhook dispatch failed for ${input.type}`, error);
    });
  }

  static async processDueRetries(now = new Date()): Promise<number> {
    const events = await prisma.webhookEvent.findMany({
      where: {
        status: WebhookDeliveryStatus.PENDING,
        nextRetryAt: { lte: now },
      },
      orderBy: { nextRetryAt: 'asc' },
      take: 100,
    });

    await Promise.all(events.map((event: any) => WebhookService.deliverEvent(event.id)));
    return events.length;
  }

  static async deliverEvent(eventId: string): Promise<any> {
    const event = await prisma.webhookEvent.findUnique({
      where: { id: eventId },
      include: { webhook: true },
    });

    if (!event) {
      throw new AppError('Webhook event not found', 404);
    }

    if (!event.webhook.active) {
      return prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: WebhookDeliveryStatus.DISABLED, errorMessage: 'Webhook is disabled' },
      });
    }

    const attemptNumber = event.attempts + 1;
    const body = WebhookService.stringifyPayload(event.payload);
    const signature = WebhookService.signPayload(body, event.webhook.secret);
    const startedAt = new Date();

    try {
      const response = await WebhookService.sendRequest(event.webhook.url, body, signature, event.eventType);
      const responseBody = await response.text();
      const responseHeaders = Object.fromEntries(response.headers.entries());
      const success = response.ok;
      const retryable = !success && WebhookService.isRetryableStatus(response.status);

      await prisma.webhookDeliveryAttempt.create({
        data: {
          webhookEventId: event.id,
          attemptNumber,
          responseCode: response.status,
          responseBody: responseBody.slice(0, 5000),
          responseHeaders,
        },
      });

      return prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          attempts: attemptNumber,
          lastAttemptAt: startedAt,
          sentAt: success ? startedAt : null,
          responseCode: response.status,
          responseBody: responseBody.slice(0, 5000),
          responseHeaders,
          errorMessage: success ? null : `HTTP ${response.status}`,
          status: success
            ? WebhookDeliveryStatus.SENT
            : WebhookService.nextFailureStatus(attemptNumber, event.maxAttempts, retryable),
          nextRetryAt: success || !retryable || attemptNumber >= event.maxAttempts
            ? null
            : WebhookService.calculateNextRetryAt(attemptNumber),
        },
      });
    } catch (error: any) {
      const errorMessage = error?.message || 'Webhook delivery failed';
      logger.warn(`Webhook delivery attempt failed for event ${event.id}: ${errorMessage}`);

      await prisma.webhookDeliveryAttempt.create({
        data: {
          webhookEventId: event.id,
          attemptNumber,
          errorMessage,
        },
      });

      return prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          attempts: attemptNumber,
          lastAttemptAt: startedAt,
          errorMessage,
          status: attemptNumber >= event.maxAttempts ? WebhookDeliveryStatus.FAILED : WebhookDeliveryStatus.PENDING,
          nextRetryAt: attemptNumber >= event.maxAttempts
            ? null
            : WebhookService.calculateNextRetryAt(attemptNumber),
        },
      });
    }
  }

  static async listEvents(filters: { webhookId?: string; status?: string; eventType?: string } = {}): Promise<any[]> {
    const where: any = {};
    if (filters.webhookId) where.webhookId = filters.webhookId;
    if (filters.status) where.status = filters.status;
    if (filters.eventType) where.eventType = filters.eventType;

    return prisma.webhookEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        webhook: {
          select: { id: true, name: true, url: true, active: true },
        },
      },
    });
  }

  static async getEvent(eventId: string): Promise<any> {
    const event = await prisma.webhookEvent.findUnique({
      where: { id: eventId },
      include: {
        webhook: {
          select: { id: true, name: true, url: true, active: true },
        },
        deliveryAttempts: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!event) {
      throw new AppError('Webhook event not found', 404);
    }

    return event;
  }

  private static buildPayload(input: DispatchEventInput): WebhookPayload {
    return {
      id: crypto.randomUUID(),
      type: input.type,
      timestamp: new Date().toISOString(),
      resource: input.resource,
      data: input.data,
    };
  }

  private static async sendRequest(url: string, body: string, signature: string, eventType: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.webhooks.timeoutMs);

    try {
      return await WebhookService.httpClient(url, {
        method: 'POST',
        body,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'AidLink-Webhooks/1.0',
          'X-AidLink-Event': eventType,
          'X-Hub-Signature-256': signature,
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private static validateEvents(events: string[]): void {
    const invalid = events.filter((event) => !WebhookService.supportedEvents.includes(event as WebhookEventType));
    if (invalid.length > 0) {
      throw new AppError(`Unsupported webhook event: ${invalid.join(', ')}`, 400);
    }
  }

  private static sanitizeWebhook(webhook: any): any {
    const safeWebhook = { ...webhook };
    delete safeWebhook.secret;
    return safeWebhook;
  }

  private static async withStatusSummary(webhook: any): Promise<any> {
    const [lastSuccess, failureCount, pendingRetries] = await Promise.all([
      prisma.webhookEvent.findFirst({
        where: { webhookId: webhook.id, status: WebhookDeliveryStatus.SENT },
        orderBy: { sentAt: 'desc' },
      }),
      prisma.webhookEvent.count({
        where: { webhookId: webhook.id, status: WebhookDeliveryStatus.FAILED },
      }),
      prisma.webhookEvent.count({
        where: { webhookId: webhook.id, status: WebhookDeliveryStatus.PENDING },
      }),
    ]);

    return {
      ...WebhookService.sanitizeWebhook(webhook),
      status: {
        lastSuccess: lastSuccess?.sentAt || null,
        failureCount,
        pendingRetries,
        active: webhook.active,
      },
    };
  }

  private static stringifyPayload(payload: unknown): string {
    return JSON.stringify(payload);
  }

  private static isRetryableStatus(statusCode: number): boolean {
    return TRANSIENT_STATUS_CODES.has(statusCode);
  }

  private static nextFailureStatus(
    attemptNumber: number,
    maxAttempts: number,
    retryable: boolean
  ): WebhookDeliveryStatus {
    if (!retryable || attemptNumber >= maxAttempts) {
      return WebhookDeliveryStatus.FAILED;
    }
    return WebhookDeliveryStatus.PENDING;
  }

  private static calculateNextRetryAt(attemptNumber: number): Date {
    const exponentialDelay = config.webhooks.retryBaseDelayMs * 2 ** Math.max(0, attemptNumber - 1);
    const delayMs = Math.min(exponentialDelay, config.webhooks.retryMaxDelayMs);
    return new Date(Date.now() + delayMs);
  }
}
