import { UnrecoverableError } from 'bullmq';

export type DeliveryErrorClass = 'transient' | 'permanent';

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKET',
  'ECONNECTION',
  'ECONNREFUSED',
  'EDNS',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

const PERMANENT_CODES = new Set(['EAUTH', 'EENVELOPE', 'EMESSAGE']);

/**
 * Classifies a delivery error (Nodemailer/SMTP shapes) as retryable or not.
 * Unrecognized shapes default to 'transient' — retrying a permanent failure
 * wastes an attempt, but dropping a transient one silently loses the notification.
 */
export function classifyDeliveryError(error: unknown): DeliveryErrorClass {
  if (!error || typeof error !== 'object') {
    return 'transient';
  }

  const err = error as { code?: unknown; responseCode?: unknown };

  if (typeof err.responseCode === 'number') {
    if (err.responseCode >= 500) return 'permanent';
    if (err.responseCode >= 400) return 'transient';
  }

  if (typeof err.code === 'string') {
    if (PERMANENT_CODES.has(err.code)) return 'permanent';
    if (TRANSIENT_CODES.has(err.code)) return 'transient';
  }

  return 'transient';
}

/**
 * Rethrows `error` as a BullMQ UnrecoverableError when classified permanent
 * (stops further retries); otherwise rethrows it unchanged so BullMQ's normal
 * retry/backoff applies.
 */
export function throwIfPermanent(error: unknown): never {
  if (classifyDeliveryError(error) === 'permanent') {
    const message = error instanceof Error ? error.message : String(error);
    throw new UnrecoverableError(message);
  }
  throw error;
}
