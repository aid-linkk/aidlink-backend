import dotenv from 'dotenv';

dotenv.config();

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  apiVersion: process.env.API_VERSION || 'v1',
  
  database: {
    url: process.env.DATABASE_URL!,

    // Connection pool. Defaults are derived from CPU count and the server
    // connection budget at startup; see src/config/dbPool.ts and
    // docs/DATABASE_POOLING.md.
    pool: {
      // Explicit per-process pool size. Leave unset to auto-size.
      max: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : undefined,
      // Number of app processes/replicas sharing this PostgreSQL server.
      instances: parseInt(process.env.DB_POOL_INSTANCES || '1', 10),
      // Connections reserved for the app across the whole fleet. PostgreSQL
      // defaults to max_connections=100; leave headroom for psql/migrations.
      serverConnectionBudget: parseInt(process.env.DB_SERVER_CONNECTION_BUDGET || '80', 10),
      // Seconds a query waits for a free pooled connection before failing.
      timeoutSeconds: parseInt(process.env.DB_POOL_TIMEOUT_SECONDS || '10', 10),
      // Seconds to wait while establishing a new connection.
      connectTimeoutSeconds: parseInt(process.env.DB_CONNECT_TIMEOUT_SECONDS || '10', 10),
      // Seconds a single statement may hold a connection (0 disables).
      socketTimeoutSeconds: parseInt(process.env.DB_SOCKET_TIMEOUT_SECONDS || '0', 10),
      // Startup connect retries with exponential backoff.
      connectRetries: parseInt(process.env.DB_CONNECT_RETRIES || '5', 10),
      connectRetryBaseDelayMs: parseInt(process.env.DB_CONNECT_RETRY_BASE_DELAY_MS || '500', 10),
    },

    monitoring: {
      // Periodic pool sampling. 0 disables the sampler.
      intervalMs: parseInt(process.env.DB_MONITOR_INTERVAL_MS || '60000', 10),
      // Warn once pool utilisation crosses this fraction of the limit.
      saturationThreshold: parseFloat(process.env.DB_POOL_SATURATION_THRESHOLD || '0.8'),
      // Queries slower than this are counted and logged.
      slowQueryThresholdMs: parseInt(process.env.DB_SLOW_QUERY_THRESHOLD_MS || '500', 10),
      logSlowQueries: process.env.DB_LOG_SLOW_QUERIES !== 'false',
      // Client-side abort for runaway queries (0 disables, the default).
      queryTimeoutMs: parseInt(process.env.DB_QUERY_TIMEOUT_MS || '0', 10),
    },
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
    // Domain string embedded in and checked against every signed wallet-auth
    // challenge, so a signature obtained for another service/domain can't be
    // replayed against this one. Falls back to the CORS origin if unset.
    appDomain: process.env.APP_DOMAIN || process.env.CORS_ORIGIN || 'aidlink.org',
    challengeTtlSeconds: parseInt(process.env.WALLET_AUTH_CHALLENGE_TTL_SECONDS || '300', 10),
    maxFailedAttempts: parseInt(process.env.WALLET_AUTH_MAX_FAILED_ATTEMPTS || '5', 10),
    failedAttemptWindowSeconds: parseInt(process.env.WALLET_AUTH_FAILED_ATTEMPT_WINDOW_SECONDS || '900', 10),
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

  indexer: {
    /**
     * Horizon REST API base URL.
     * Defaults to the public Stellar mainnet Horizon; override for testnet or
     * a local standalone network.
     */
    horizonUrl: process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org',

    /**
     * Maximum number of ledgers to process per indexLoop() tick when
     * catching up after a gap.  Smaller values reduce per-tick DB write
     * latency; larger values close gaps faster.
     * Default: 50
     */
    batchSize: parseInt(process.env.SOROBAN_INDEXER_BATCH_SIZE || '50', 10),

    /**
     * Maximum Horizon / Soroban-RPC requests per second.
     * The token-bucket rate limiter will block until a token is available.
     * Default: 5 (conservative; Horizon public instances allow ~20 rps but
     * we share bandwidth with other consumers).
     */
    rpsLimit: parseInt(process.env.SOROBAN_INDEXER_RPS_LIMIT || '5', 10),

    /**
     * How long to wait between normal (non-catch-up) loop ticks in ms.
     * Default: 10 000 (10 s) — Stellar closes a new ledger every ~5 s so
     * this is a 2× safety margin with minimal overhead.
     */
    pollIntervalMs: parseInt(process.env.SOROBAN_INDEXER_POLL_INTERVAL_MS || '10000', 10),

    /**
     * How long to wait after a fatal error before retrying the loop in ms.
     * Default: 30 000
     */
    errorBackoffMs: parseInt(process.env.SOROBAN_INDEXER_ERROR_BACKOFF_MS || '30000', 10),
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

  kycFraud: {
    // Velocity window in minutes
    velocityWindowMinutes: parseInt(process.env.KYC_FRAUD_VELOCITY_WINDOW_MINUTES || '60', 10),
    // Max submissions per IP within the velocity window before flagging
    velocityMaxSubmissionsPerIp: parseInt(process.env.KYC_FRAUD_VELOCITY_MAX_PER_IP || '5', 10),
    // Max submissions per user within the velocity window before flagging
    velocityMaxSubmissionsPerUser: parseInt(process.env.KYC_FRAUD_VELOCITY_MAX_PER_USER || '3', 10),
    // Geographic anomaly: max km/h travel speed considered plausible
    geoMaxPlausibleSpeedKmh: parseInt(process.env.KYC_FRAUD_GEO_MAX_SPEED_KMH || '900', 10),
    // Number of prior submissions to look back when checking multi-hop impossible travel
    geoAnomalyLookback: parseInt(process.env.GEO_ANOMALY_LOOKBACK || '5', 10),
    // Score at which a submission is considered high risk (triggers FRAUD_DETECTION job)
    highRiskThreshold: parseInt(process.env.KYC_FRAUD_HIGH_RISK_THRESHOLD || '50', 10),
    // Signal weights (must sum to 100)
    weights: {
      documentReuse: parseInt(process.env.KYC_FRAUD_WEIGHT_DOC_REUSE || '30', 10),
      geoAnomaly: parseInt(process.env.KYC_FRAUD_WEIGHT_GEO || '20', 10),
      velocity: parseInt(process.env.KYC_FRAUD_WEIGHT_VELOCITY || '25', 10),
      deviceFingerprint: parseInt(process.env.KYC_FRAUD_WEIGHT_DEVICE || '15', 10),
      thirdParty: parseInt(process.env.KYC_FRAUD_WEIGHT_THIRD_PARTY || '10', 10),
    },
    // Third-party fraud service (optional)
    thirdPartyEnabled: process.env.KYC_FRAUD_THIRD_PARTY_ENABLED === 'true',
    thirdPartyApiUrl: process.env.KYC_FRAUD_THIRD_PARTY_API_URL || '',
    thirdPartyApiKey: process.env.KYC_FRAUD_THIRD_PARTY_API_KEY || '',
    thirdPartyTimeoutMs: parseInt(process.env.KYC_FRAUD_THIRD_PARTY_TIMEOUT_MS || '5000', 10),
  },

  fraudRecalibration: {
    /**
     * Minimum labels of each class (APPROVED and REJECTED) required before
     * the re-calibration job attempts a fit.  Default: 50.
     */
    minCalibrationSamples: parseInt(process.env.FRAUD_MIN_CALIBRATION_SAMPLES || '50', 10),

    /**
     * If the Platt-fitted model's validation ECE exceeds this threshold, the
     * job falls back to isotonic regression.  Default: 0.05.
     */
    isotonicEceThreshold: parseFloat(process.env.FRAUD_ISOTONIC_ECE_THRESHOLD || '0.05'),

    /**
     * Cron expression for the periodic recalibration job.
     * Default: 0 3 * * * (3 AM UTC daily).
     */
    cron: process.env.FRAUD_RECALIBRATION_CRON || '0 3 * * *',

    /**
     * Number of new labels (since last calibration) that trigger an
     * immediate recalibration job enqueue.  Default: 200.
     */
    labelTrigger: parseInt(process.env.FRAUD_RECALIBRATION_LABEL_TRIGGER || '200', 10),

    /**
     * Redis cache TTL for the active model version parameters, in seconds.
     * After a version swap the worker invalidates the cache immediately;
     * this TTL only applies to cache misses under Redis failure.  Default: 300 s.
     */
    cacheTtlSeconds: parseInt(process.env.FRAUD_MODEL_CACHE_TTL_SECONDS || '300', 10),
  },

  fraudDrift: {
    // Runs in the recalibration worker only; it never affects scoring latency.
    enabled: process.env.FRAUD_DRIFT_ENABLED !== 'false',
    methods: (process.env.FRAUD_DRIFT_METHODS || 'ks,psi,chiSquared').split(',').map(method => method.trim()) as Array<'ks' | 'psi' | 'chiSquared'>,
    significanceLevel: parseFloat(process.env.FRAUD_DRIFT_SIGNIFICANCE_LEVEL || '0.01'),
    psiThreshold: parseFloat(process.env.FRAUD_DRIFT_PSI_THRESHOLD || '0.2'),
    minSamples: parseInt(process.env.FRAUD_DRIFT_MIN_SAMPLES || '30', 10),
    bins: parseInt(process.env.FRAUD_DRIFT_HISTOGRAM_BINS || '10', 10),
    baselineWindowHours: parseInt(process.env.FRAUD_DRIFT_BASELINE_WINDOW_HOURS || '720', 10),
    currentWindowHours: parseInt(process.env.FRAUD_DRIFT_CURRENT_WINDOW_HOURS || '168', 10),
    detectionIntervalMinutes: parseInt(process.env.FRAUD_DRIFT_DETECTION_INTERVAL_MINUTES || '60', 10),
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

  bulk: {
    /**
     * Maximum number of rows accepted in a single CSV beneficiary import.
     * Requests exceeding this limit are rejected with HTTP 413 before any
     * database operations are attempted.  1 000 rows at ~5 ms RTT = ~10 ms
     * for the two batch inserts, well within a 30 s request timeout.
     * Raise via BULK_IMPORT_MAX_ROWS env var when deploying on faster infra.
     */
    importMaxRows: parseInt(process.env.BULK_IMPORT_MAX_ROWS || '1000', 10),
  },

  matchedFundVerification: {
    /**
     * Feature flag: set MATCHED_FUND_VERIFICATION_ENABLED=false to disable
     * the worker entirely (useful in test environments or during migrations).
     * Defaults to enabled.
     */
    enabled: process.env.MATCHED_FUND_VERIFICATION_ENABLED !== 'false',

    /**
     * Cron pattern for the full verification job (checks all multipliers).
     * Default: 30 2 * * * (02:30 UTC daily, off-peak).
     */
    fullVerificationCron: process.env.MATCHED_FUND_VERIFICATION_FULL_CRON || '30 2 * * *',

    /**
     * Cron pattern for the sample verification job (checks a random subset).
     * Default: 45 * * * * (hourly at :45).
     */
    sampleVerificationCron: process.env.MATCHED_FUND_VERIFICATION_SAMPLE_CRON || '45 * * * *',

    /**
     * Percentage of Multiplier rows sampled in SAMPLE mode (1–100).
     * Default: 10 (10%).
     */
    samplePercent: parseInt(process.env.MATCHED_FUND_VERIFICATION_SAMPLE_PCT || '10', 10),

    /**
     * Minimum absolute difference (in currency units) to treat a multiplier
     * as inconsistent. Values at or below this threshold are considered
     * precision noise and are ignored.
     * Default: 0.00000001 (8 decimal places — one Satoshi-equivalent).
     */
    inconsistencyThreshold: process.env.MATCHED_FUND_VERIFICATION_THRESHOLD || '0.00000001',

    /**
     * Fraction of checked multipliers that, when inconsistent, triggers the
     * SYSTEMIC_INCONSISTENCY alert. E.g. 0.05 means "alert if >5% are wrong".
     * Default: 0.05.
     */
    alertSystemicThreshold: parseFloat(
      process.env.MATCHED_FUND_VERIFICATION_SYSTEMIC_THRESHOLD || '0.05',
    ),

    /**
     * Absolute discrepancy (in currency units) above which a single-multiplier
     * LARGE_DISCREPANCY alert is emitted.
     * Default: 1000 (one thousand units — e.g. USD 1,000).
     */
    alertLargeDiscrepancyAmount: process.env.MATCHED_FUND_VERIFICATION_LARGE_AMOUNT || '1000',

    /**
     * Maximum milliseconds the repair transaction may hold the FOR UPDATE lock
     * on a single Multiplier row. Keeps repair latency bounded so normal
     * allocation operations are not blocked for long.
     * Default: 5000 ms.
     */
    repairTimeoutMs: parseInt(
      process.env.MATCHED_FUND_VERIFICATION_REPAIR_TIMEOUT_MS || '5000',
      10,
    ),
  },
};

export default config;
