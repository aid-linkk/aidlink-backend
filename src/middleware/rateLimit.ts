import rateLimit from 'express-rate-limit';
import { config } from '../config';

export const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: {
    success: false,
    error: 'Too many requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per window
  message: {
    success: false,
    error: 'Too many authentication attempts, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const strictLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per window
  message: {
    success: false,
    error: 'Rate limit exceeded',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-endpoint rate limiters
export const createRateLimiter = (windowMs: number, max: number, message?: string) => {
  return rateLimit({
    windowMs,
    max,
    message: {
      success: false,
      error: message || 'Rate limit exceeded',
    },
    standardHeaders: true,
    legacyHeaders: false,
  });
};

// Specific endpoint rate limiters
export const donationLimiter = createRateLimiter(
  60 * 1000, // 1 minute
  10, // 10 donations per minute
  'Too many donation attempts, please try again later'
);

export const campaignCreateLimiter = createRateLimiter(
  60 * 60 * 1000, // 1 hour
  3, // 3 campaigns per hour
  'Too many campaign creation attempts, please try again later'
);

export const searchLimiter = createRateLimiter(
  60 * 1000, // 1 minute
  30, // 30 searches per minute
  'Too many search requests, please try again later'
);

export const analyticsLimiter = createRateLimiter(
  60 * 1000, // 1 minute
  20, // 20 analytics requests per minute
  'Too many analytics requests, please try again later'
);

export const distributionLimiter = createRateLimiter(
  60 * 1000, // 1 minute
  5, // 5 distributions per minute
  'Too many distribution attempts, please try again later'
);

export const notificationLimiter = createRateLimiter(
  60 * 1000, // 1 minute
  10, // 10 notifications per minute
  'Too many notification requests, please try again later'
);

export const reportLimiter = createRateLimiter(
  60 * 60 * 1000, // 1 hour
  5, // 5 fraud reports per hour
  'Too many reports submitted, please try again later'
);

