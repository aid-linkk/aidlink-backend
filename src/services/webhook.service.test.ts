import { WebhookService } from './webhook.service';

// Mock prisma
jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    webhookSubscription: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    webhookEvent: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
  },
}));

jest.mock('axios');
import axios from 'axios';
import prisma from '../config/database';

const mockWebhook = {
  id: 'wh_1',
  name: 'Test Webhook',
  url: 'https://example.com/hook',
  secret: 'supersecretkey1234',
  events: ['DONATION_CONFIRMED'],
  active: true,
  description: null,
  createdBy: 'user_1',
  lastSuccessAt: null,
  failureCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockEvent = {
  id: 'evt_1',
  webhookId: 'wh_1',
  eventType: 'DONATION_CONFIRMED' as any,
  payload: { donationId: 'd_1' },
  status: 'PENDING' as any,
  attempts: 0,
  maxAttempts: 5,
  lastAttemptAt: null,
  nextRetryAt: new Date(),
  responseCode: null,
  responseBody: null,
  errorMessage: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  webhook: mockWebhook,
};

describe('WebhookService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('createWebhook', () => {
    it('rejects non-HTTPS URLs', async () => {
      await expect(
        WebhookService.createWebhook({ name: 'x', url: 'http://example.com', secret: 'abc123456789abcd', events: ['DONATION_CONFIRMED' as any], createdBy: 'u1' })
      ).rejects.toThrow('Webhook URL must use HTTPS');
    });

    it('creates a webhook with valid data', async () => {
      (prisma.webhookSubscription.create as jest.Mock).mockResolvedValue(mockWebhook);
      const result = await WebhookService.createWebhook({
        name: 'Test', url: 'https://example.com/hook', secret: 'supersecretkey1234',
        events: ['DONATION_CONFIRMED' as any], createdBy: 'u1',
      });
      expect(result).toEqual(mockWebhook);
    });
  });

  describe('signPayload', () => {
    it('produces a deterministic sha256 signature', () => {
      const sig = WebhookService.signPayload('mysecret', '{"foo":"bar"}');
      expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(sig).toBe(WebhookService.signPayload('mysecret', '{"foo":"bar"}'));
    });

    it('produces different signatures for different secrets', () => {
      const s1 = WebhookService.signPayload('secret1', 'body');
      const s2 = WebhookService.signPayload('secret2', 'body');
      expect(s1).not.toBe(s2);
    });
  });

  describe('dispatch', () => {
    it('creates webhook events for active subscribed webhooks', async () => {
      (prisma.webhookSubscription.findMany as jest.Mock).mockResolvedValue([mockWebhook]);
      (prisma.webhookEvent.create as jest.Mock).mockResolvedValue(mockEvent);

      await WebhookService.dispatch('DONATION_CONFIRMED' as any, { donationId: 'd_1' });

      expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
      expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ webhookId: 'wh_1', eventType: 'DONATION_CONFIRMED' }),
        })
      );
    });

    it('does nothing when no active webhooks match', async () => {
      (prisma.webhookSubscription.findMany as jest.Mock).mockResolvedValue([]);
      await WebhookService.dispatch('DONATION_CONFIRMED' as any, {});
      expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('deliverEvent', () => {
    it('marks event as SENT on successful delivery', async () => {
      (prisma.webhookEvent.findUnique as jest.Mock).mockResolvedValue(mockEvent);
      (axios.post as jest.Mock).mockResolvedValue({ status: 200, data: 'ok' });
      (prisma.$transaction as jest.Mock).mockResolvedValue([]);

      await WebhookService.deliverEvent('evt_1');

      expect(axios.post).toHaveBeenCalledWith(
        'https://example.com/hook',
        mockEvent.payload,
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-AidLink-Signature': expect.stringMatching(/^sha256=/) }),
        })
      );
    });

    it('marks event as PENDING with retry on 5xx failure', async () => {
      (prisma.webhookEvent.findUnique as jest.Mock).mockResolvedValue(mockEvent);
      (axios.post as jest.Mock).mockRejectedValue({ response: { status: 503, data: 'error' }, message: 'Service unavailable' });
      (prisma.$transaction as jest.Mock).mockResolvedValue([]);

      await WebhookService.deliverEvent('evt_1');

      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('marks event as FAILED on permanent 4xx failure', async () => {
      (prisma.webhookEvent.findUnique as jest.Mock).mockResolvedValue(mockEvent);
      (axios.post as jest.Mock).mockRejectedValue({ response: { status: 400, data: 'bad request' }, message: 'Bad Request' });
      (prisma.$transaction as jest.Mock).mockImplementation(async (ops: any[]) => {
        for (const op of ops) await op;
      });
      (prisma.webhookEvent.update as jest.Mock).mockResolvedValue({});
      (prisma.webhookSubscription.update as jest.Mock).mockResolvedValue({});

      await WebhookService.deliverEvent('evt_1');

      expect(prisma.webhookEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) })
      );
    });

    it('skips already SENT events', async () => {
      (prisma.webhookEvent.findUnique as jest.Mock).mockResolvedValue({ ...mockEvent, status: 'SENT' });
      await WebhookService.deliverEvent('evt_1');
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  describe('testWebhook', () => {
    it('returns success on 200 response', async () => {
      (prisma.webhookSubscription.findUnique as jest.Mock).mockResolvedValue(mockWebhook);
      (axios.post as jest.Mock).mockResolvedValue({ status: 200 });

      const result = await WebhookService.testWebhook('wh_1');
      expect(result).toEqual({ success: true, status: 200 });
    });

    it('returns failure on network error', async () => {
      (prisma.webhookSubscription.findUnique as jest.Mock).mockResolvedValue(mockWebhook);
      (axios.post as jest.Mock).mockRejectedValue({ message: 'ECONNREFUSED', response: undefined });

      const result = await WebhookService.testWebhook('wh_1');
      expect(result.success).toBe(false);
    });
  });
});
