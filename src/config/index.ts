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

  storage: {
    provider: process.env.STORAGE_PROVIDER || 'local',
    aws: {
      region: process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      bucket: process.env.AWS_S3_BUCKET,
      baseUrl: process.env.AWS_S3_BASE_URL,
    },
    azure: {
      accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME,
      accountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY,
      container: process.env.AZURE_STORAGE_CONTAINER,
    },
    local: {
      uploadDir: process.env.LOCAL_UPLOAD_DIR || 'uploads',
      baseUrl: process.env.LOCAL_UPLOAD_BASE_URL || `http://localhost:${process.env.PORT || 3000}/uploads`,
    },
  },
};

export default config;
