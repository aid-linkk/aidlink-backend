import dotenv from 'dotenv';

dotenv.config();

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  apiVersion: process.env.API_VERSION || 'v1',
  
  database: {
    url: process.env.DATABASE_URL!,
  },
  
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
  },
  
  jwt: {
    secret: process.env.JWT_SECRET!,
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },
  
  walletAuth: {
    secret: process.env.WALLET_AUTH_SECRET!,
  },
  
  email: {
    host: process.env.SMTP_HOST!,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER!,
    password: process.env.SMTP_PASSWORD!,
    from: process.env.EMAIL_FROM || 'noreply@aidlink.org',
    queueEnabled: process.env.EMAIL_QUEUE_ENABLED === 'true',
    appUrl: process.env.APP_URL || 'http://localhost:3000',
    logoUrl: process.env.EMAIL_LOGO_URL || 'https://aidlink.org/logo.png',
    supportEmail: process.env.SUPPORT_EMAIL || 'support@aidlink.org',
  },
  
  soroban: {
    networkUrl: process.env.SOROBAN_NETWORK_URL!,
    networkPassphrase: process.env.SOROBAN_NETWORK_PASSPHRASE!,
    contractAddress: process.env.CONTRACT_ADDRESS,
  },
  
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },
  
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  },
  
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    filePath: process.env.LOG_FILE_PATH || 'logs',
  },
  
  bullmq: {
    redisHost: process.env.BULLMQ_REDIS_HOST || 'localhost',
    redisPort: parseInt(process.env.BULLMQ_REDIS_PORT || '6379', 10),
    redisPassword: process.env.BULLMQ_REDIS_PASSWORD || undefined,
  },
  
  websocket: {
    port: parseInt(process.env.WS_PORT || '3001', 10),
  },
  
  monitoring: {
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '30000', 10),
  },

  receipts: {
    enabled: process.env.RECEIPTS_ENABLED !== 'false',
    storagePrefix: process.env.RECEIPT_STORAGE_PREFIX || 'receipts',
    senderEmail: process.env.RECEIPT_SENDER_EMAIL || process.env.EMAIL_FROM || 'noreply@aidlink.org',
    urlExpirySeconds: parseInt(process.env.RECEIPT_URL_EXPIRY_SECONDS || '86400', 10),
    defaultRegion: process.env.RECEIPT_DEFAULT_REGION || 'US',
    regionalRequirements: process.env.REGIONAL_TAX_REQUIREMENTS,
    maxBatchSize: parseInt(process.env.RECEIPT_MAX_BATCH_SIZE || '1000', 10),
  },

  moderation: {
    // Feature flag: when false, the worker still records reports but never
    // auto-suspends. Admins can always suspend/reinstate manually.
    autoSuspendEnabled: process.env.MODERATION_AUTO_SUSPEND_ENABLED === 'true',
    // Low-verification rule: campaigns whose owner verification score stays
    // below `verificationScoreThreshold` for `verificationGraceDays` get suspended.
    verificationScoreThreshold: parseInt(process.env.MODERATION_VERIFICATION_SCORE_THRESHOLD || '40', 10),
    verificationGraceDays: parseInt(process.env.MODERATION_VERIFICATION_GRACE_DAYS || '7', 10),
    // Fraud rule: N independent fraud reports within the rolling window.
    fraudReportThreshold: parseInt(process.env.MODERATION_FRAUD_REPORT_THRESHOLD || '3', 10),
    fraudReportWindowHours: parseInt(process.env.MODERATION_FRAUD_REPORT_WINDOW_HOURS || '24', 10),
    // Notify donors when a campaign is suspended for a fraud-related reason.
    notifyDonorsOnFraudSuspension: process.env.MODERATION_NOTIFY_DONORS_ON_FRAUD !== 'false',
  },

  analytics: {
    // Cron patterns for rollup jobs (configurable via env vars)
    hourlyRollupCron: process.env.ANALYTICS_HOURLY_CRON || '5 * * * *',
    monthlyRollupCron: process.env.ANALYTICS_MONTHLY_CRON || '0 2 1 * *',
    trendingRefreshCron: process.env.ANALYTICS_TRENDING_CRON || '*/15 * * * *',
    // Feature flag to disable analytics worker
    analyticsWorkerEnabled: process.env.ANALYTICS_WORKER_ENABLED !== 'false',
    // Cache TTL for campaign stats in seconds
    campaignStatsCacheTTL: parseInt(process.env.ANALYTICS_CACHE_TTL || '3600', 10),
    // Number of trending campaigns to track
    trendingCampaignsCount: parseInt(process.env.ANALYTICS_TRENDING_COUNT || '20', 10),
  },
};

export default config;
