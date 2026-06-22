import { Router } from 'express';
import { z } from 'zod';
import { WebhookController } from '../controllers/webhook.controller';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validation';
import { createRateLimiter } from '../middleware/rateLimit';

const router = Router();

const webhookLimiter = createRateLimiter(60 * 1000, 30, 'Too many webhook requests');

const VALID_EVENTS = [
  'DONATION_CONFIRMED',
  'DISTRIBUTION_COMPLETED',
  'CAMPAIGN_MILESTONE_REACHED',
  'KYC_STATUS_CHANGED',
] as const;

const createWebhookSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url().refine((u) => u.startsWith('https://'), 'URL must use HTTPS'),
  secret: z.string().min(16),
  events: z.array(z.enum(VALID_EVENTS)).min(1),
  description: z.string().max(500).optional(),
});

const updateWebhookSchema = createWebhookSchema.partial();

// All routes require ADMIN role
router.use(authenticate, authorize('ADMIN'), webhookLimiter);

router.post('/', validate(createWebhookSchema), WebhookController.create);
router.get('/', WebhookController.list);
router.get('/events', WebhookController.getAllEvents);
router.get('/events/:eventId', WebhookController.getEventById);
router.get('/:id', WebhookController.getById);
router.put('/:id', validate(updateWebhookSchema), WebhookController.update);
router.delete('/:id', WebhookController.remove);
router.post('/:id/test', WebhookController.test);
router.get('/:id/events', WebhookController.getEvents);

export default router;
