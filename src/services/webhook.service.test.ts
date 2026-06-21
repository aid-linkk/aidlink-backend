import prisma from '../config/database';
import { WebhookService } from './webhook.service';
import { WebhookDeliveryStatus } from '@prisma/client';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    webhookSubscription: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    webhookEvent: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    webhookDeliveryAttempt: {
      create: jest.fn(),
    },
  },
}));

jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

describe('WebhookService', () => {
  const webhook = {
    id: 'webhook-1',
    name: 'CRM',
    url: 'https://example.com/webhook',
    secret: 'super-secret-webhook-value',
    events: ['donation.confirmed'],
    active: true,
    createdBy: 'admin-1',
    createdAt: new Date('2026-06-21T00:00:00.000Z'),
    updatedAt: new Date('2026-06-21T00:00:00.000Z'),
  };

  const event = {
    id: 'event-1',
    webhookId: webhook.id,
    eventType: 'donation.confirmed',
    payload: {
      id: 'payload-1',
      type: 'donation.confirmed',
      timestamp: '2026-06-21T00:00:00.000Z',
      resource: { type: 'donation', id: 'donation-1' },
      data: { donationId: 'donation-1' },
    },
    status: WebhookDeliveryStatus.PENDING,
    attempts: 0,
    maxAttempts: 3,
    webhook,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    WebhookService.resetHttpClient();
  });

  it('signs and verifies payloads with HMAC-SHA256', () => {
    const payload = { id: 'payload-1', type: 'donation.confirmed' };
    const signature = WebhookService.signPayload(payload, webhook.secret);

    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(WebhookService.verifySignature(payload, signature, webhook.secret)).toBe(true);
    expect(WebhookService.verifySignature(payload, 'sha256=bad', webhook.secret)).toBe(false);
  });

  it('registers a webhook and does not expose the secret', async () => {
    (prisma.webhookSubscription.create as jest.Mock).mockResolvedValue(webhook);

    const result = await WebhookService.registerWebhook({
      name: webhook.name,
      url: webhook.url,
      events: ['donation.confirmed'],
      secret: webhook.secret,
    }, 'admin-1');

    expect(prisma.webhookSubscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: webhook.name,
        url: webhook.url,
        events: ['donation.confirmed'],
        secret: webhook.secret,
        active: true,
        createdBy: 'admin-1',
      }),
    });
    expect(result.secret).toBeUndefined();
  });

  it('rejects unsupported event types', async () => {
    await expect(WebhookService.registerWebhook({
      name: webhook.name,
      url: webhook.url,
      events: ['unknown.event' as any],
      secret: webhook.secret,
    })).rejects.toThrow('Unsupported webhook event');
  });

  it('marks successful deliveries as sent', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response('ok', {
      status: 200,
      headers: { 'x-request-id': 'req-1' },
    }));
    WebhookService.setHttpClient(fetchMock as any);
    (prisma.webhookEvent.findUnique as jest.Mock).mockResolvedValue(event);
    (prisma.webhookDeliveryAttempt.create as jest.Mock).mockResolvedValue({});
    (prisma.webhookEvent.update as jest.Mock).mockImplementation(async ({ data }) => ({ ...event, ...data }));

    const result = await WebhookService.deliverEvent(event.id);

    expect(fetchMock).toHaveBeenCalledWith(webhook.url, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'X-AidLink-Event': 'donation.confirmed',
        'X-Hub-Signature-256': expect.stringMatching(/^sha256=/),
      }),
    }));
    expect(result.status).toBe(WebhookDeliveryStatus.SENT);
    expect(result.responseCode).toBe(200);
    expect(result.nextRetryAt).toBeNull();
  });

  it('keeps transient delivery failures pending with a retry time', async () => {
    WebhookService.setHttpClient(jest.fn().mockResolvedValue(new Response('busy', { status: 503 })) as any);
    (prisma.webhookEvent.findUnique as jest.Mock).mockResolvedValue(event);
    (prisma.webhookDeliveryAttempt.create as jest.Mock).mockResolvedValue({});
    (prisma.webhookEvent.update as jest.Mock).mockImplementation(async ({ data }) => ({ ...event, ...data }));

    const result = await WebhookService.deliverEvent(event.id);

    expect(result.status).toBe(WebhookDeliveryStatus.PENDING);
    expect(result.responseCode).toBe(503);
    expect(result.nextRetryAt).toBeInstanceOf(Date);
  });

  it('marks permanent client failures as failed without retry', async () => {
    WebhookService.setHttpClient(jest.fn().mockResolvedValue(new Response('bad request', { status: 400 })) as any);
    (prisma.webhookEvent.findUnique as jest.Mock).mockResolvedValue(event);
    (prisma.webhookDeliveryAttempt.create as jest.Mock).mockResolvedValue({});
    (prisma.webhookEvent.update as jest.Mock).mockImplementation(async ({ data }) => ({ ...event, ...data }));

    const result = await WebhookService.deliverEvent(event.id);

    expect(result.status).toBe(WebhookDeliveryStatus.FAILED);
    expect(result.responseCode).toBe(400);
    expect(result.nextRetryAt).toBeNull();
  });

  it('marks events disabled when the webhook is inactive', async () => {
    (prisma.webhookEvent.findUnique as jest.Mock).mockResolvedValue({
      ...event,
      webhook: { ...webhook, active: false },
    });
    (prisma.webhookEvent.update as jest.Mock).mockImplementation(async ({ data }) => ({ ...event, ...data }));

    const result = await WebhookService.deliverEvent(event.id);

    expect(result.status).toBe(WebhookDeliveryStatus.DISABLED);
    expect(prisma.webhookDeliveryAttempt.create).not.toHaveBeenCalled();
  });

  it('creates delivery events for active matching subscriptions', async () => {
    (prisma.webhookSubscription.findMany as jest.Mock).mockResolvedValue([webhook]);
    (prisma.webhookEvent.create as jest.Mock).mockResolvedValue({ id: event.id });
    (prisma.webhookEvent.findUnique as jest.Mock).mockResolvedValue(event);
    (prisma.webhookDeliveryAttempt.create as jest.Mock).mockResolvedValue({});
    (prisma.webhookEvent.update as jest.Mock).mockResolvedValue(event);
    WebhookService.setHttpClient(jest.fn().mockResolvedValue(new Response('ok', { status: 200 })) as any);

    await WebhookService.dispatchEvent({
      type: 'donation.confirmed',
      resource: { type: 'donation', id: 'donation-1' },
      data: { donationId: 'donation-1' },
    });

    expect(prisma.webhookSubscription.findMany).toHaveBeenCalledWith({
      where: {
        active: true,
        events: { has: 'donation.confirmed' },
      },
    });
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        webhookId: webhook.id,
        eventType: 'donation.confirmed',
        status: WebhookDeliveryStatus.PENDING,
      }),
    });
  });
});
