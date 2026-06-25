import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import path from 'path';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { createServer } from 'http';
import { config } from './config';
import logger from './config/logger';
import { validateEnv } from './config/envValidate';
import { connectDatabase, disconnectDatabase } from './config/database';
import { connectRedis, disconnectRedis } from './config/redis';
import { apiLimiter } from './middleware/rateLimit';
import { errorHandler, notFoundHandler } from './middleware/error';
import { requestLogger, errorLogger } from './middleware/requestLogger';
import authRoutes from './routes/auth.routes';
import campaignRoutes from './routes/campaign.routes';
import beneficiaryRoutes from './routes/beneficiary.routes';
import donationRoutes from './routes/donation.routes';
import distributionRoutes from './routes/distribution.routes';
import notificationRoutes from './routes/notification.routes';
import adminRoutes from './routes/admin.routes';
import analyticsRoutes from './routes/analytics.routes';
import searchRoutes from './routes/search.routes';
import uploadRoutes from './routes/upload.routes';
import organizationRoutes from './routes/organization.routes';
import webhookRoutes from './routes/webhook.routes';
import receiptRoutes from './routes/receipt.routes';
import blockchainRoutes from './routes/blockchain.routes';
import { sorobanIndexer } from './blockchain/soroban.indexer';
import { initializeWebSocket } from './websocket/socket.server';
import { stopRecoveryWorker } from './workers/recovery.worker';
import { EmailTemplateService } from './services/emailTemplate.service';
import userRoutes from './routes/user.routes';

const app: Application = express();
const httpServer = createServer(app);

// Request logging middleware
app.use(requestLogger);

// Security middleware
app.use(helmet());
app.use(cors({
  origin: config.cors.origin,
  credentials: true,
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Compression middleware
app.use(compression());

// Logging middleware
if (config.env === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Rate limiting
app.use('/api/', apiLimiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is healthy',
    timestamp: new Date().toISOString(),
    environment: config.env,
  });
});

// API routes
app.use(`/api/${config.apiVersion}/auth`, authRoutes);
app.use(`/api/${config.apiVersion}/campaigns`, campaignRoutes);
app.use(`/api/${config.apiVersion}/beneficiaries`, beneficiaryRoutes);
app.use(`/api/${config.apiVersion}/donations`, donationRoutes);
app.use(`/api/${config.apiVersion}/distributions`, distributionRoutes);
app.use(`/api/${config.apiVersion}/notifications`, notificationRoutes);
app.use(`/api/${config.apiVersion}/admin`, adminRoutes);
app.use(`/api/${config.apiVersion}/admin/receipts`, receiptRoutes);
app.use(`/api/${config.apiVersion}/analytics`, analyticsRoutes);
app.use(`/api/${config.apiVersion}/search`, searchRoutes);
app.use(`/api/${config.apiVersion}/upload`, uploadRoutes);
app.use(`/api/${config.apiVersion}/organizations`, organizationRoutes);
app.use(`/api/${config.apiVersion}/admin/webhooks`, webhookRoutes);
app.use(`/api/${config.apiVersion}/admin/blockchain`, blockchainRoutes);

// Serve openapi.yaml as a static file so Swagger UI can load it directly
app.use('/openapi.yaml', express.static(path.join(__dirname, '..', 'openapi.yaml')));

// Swagger UI — canonical path required by spec, legacy path kept for compat
const swaggerUiOptions = {
  swaggerUrl: '/openapi.yaml',
  customSiteTitle: 'AidLink API Docs',
};
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(undefined, swaggerUiOptions));

// Legacy alias kept for backward compatibility
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'AidLink Backend API',
      version: '1.0.0',
      description: 'Production-grade backend for AidLink - Blockchain-powered humanitarian aid platform',
    },
    servers: [
      {
        url: `http://localhost:${config.port}`,
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
  },
  apis: ['./src/routes/*.ts'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Error handling middleware
app.use(notFoundHandler);
app.use(errorHandler);

// Start server
const startServer = async (): Promise<void> => {
  try {
    // Validate required environment variables before connecting to services
    validateEnv();

    // Connect to database
    await connectDatabase();

    // Connect to Redis
    await connectRedis();

    // Initialize WebSocket server
    initializeWebSocket(httpServer);

    // Initialize HTML email template engine (Handlebars)
    EmailTemplateService.initialize();

    // Start blockchain indexer
    if (config.env === 'production' || config.env === 'development') {
      sorobanIndexer.start().catch((error) => {
        logger.error('Failed to start blockchain indexer:', error);
      });
    }

    // Start campaign moderation worker + scheduled evaluations (feature-flagged).
    // Dynamically imported so the BullMQ worker only connects when enabled.
    if (config.moderation.autoSuspendEnabled) {
      import('./workers/moderation.worker.js')
        .then(({ scheduleModerationEvaluations }) => scheduleModerationEvaluations())
        .then(() => logger.info('Campaign moderation worker started'))
        .catch((error) => logger.error('Failed to start moderation worker:', error));
    }
    
    // Start tax-receipt worker (generation, email delivery, batch processing).
    // Dynamically imported so the BullMQ worker only connects when enabled.
    if (config.receipts.enabled) {
      import('./workers/receipt.worker.js')
        .then(({ startReceiptWorker }) => startReceiptWorker())
        .catch((error) => logger.error('Failed to start receipt worker:', error));
    }

    // Start email notification worker (opt-in, controlled by EMAIL_QUEUE_ENABLED)
    if (config.email.queueEnabled) {
      import('./workers/email.worker.js')
        .then(({ startEmailWorker }) => startEmailWorker())
        .catch((error) => logger.error('Failed to start email worker:', error));
    }

    // Start webhook delivery worker
    import('./workers/webhook.worker.js')
      .then(() => logger.info('Webhook delivery worker started'))
      .catch((error) => logger.error('Failed to start webhook worker:', error));

    // Start recovery worker (auto-retry scheduled cases)
    import('./workers/recovery.worker.js')
      .then(({ startRecoveryWorker }) => startRecoveryWorker())
      .catch((error) => logger.error('Failed to start recovery worker:', error));


    // Start HTTP server
    httpServer.listen(config.port, () => {
      logger.info(`Server running on port ${config.port} in ${config.env} mode`);
      logger.info(`API documentation available at http://localhost:${config.port}/api-docs`);
      logger.info(`WebSocket server initialized`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
const gracefulShutdown = async (signal: string): Promise<void> => {
  logger.info(`${signal} received. Starting graceful shutdown...`);

  try {
    // Stop blockchain indexer
    await sorobanIndexer.stop();

    // Stop recovery worker
    stopRecoveryWorker();

    // Disconnect from database
    await disconnectDatabase();

    // Disconnect from Redis
    await disconnectRedis();

    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the server
startServer();

export default app;
