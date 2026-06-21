import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { createServer } from 'http';
import { config } from './config';
import logger from './config/logger';
import { connectDatabase, disconnectDatabase } from './config/database';
import { connectRedis, disconnectRedis } from './config/redis';
import { apiLimiter } from './middleware/rateLimit';
import { errorHandler, notFoundHandler } from './middleware/error';
import { requestLogger } from './middleware/requestLogger';
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
import { sorobanIndexer } from './blockchain/soroban.indexer';
import { initializeWebSocket } from './websocket/socket.server';
import { startWebhookRetryProcessor, stopWebhookRetryProcessor } from './workers/webhook.worker';

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
app.use(`/api/${config.apiVersion}/analytics`, analyticsRoutes);
app.use(`/api/${config.apiVersion}/search`, searchRoutes);
app.use(`/api/${config.apiVersion}/upload`, uploadRoutes);
app.use(`/api/${config.apiVersion}/organizations`, organizationRoutes);

// Swagger documentation
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
    // Connect to database
    await connectDatabase();

    // Connect to Redis
    await connectRedis();

    // Initialize WebSocket server
    initializeWebSocket(httpServer);

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

    startWebhookRetryProcessor();
    logger.info('Webhook retry processor started');

    // Start HTTP server
    httpServer.listen(config.port, () => {
      logger.info(`Server running on port ${config.port} in ${config.env} mode`);
      logger.info(`API documentation available at http://localhost:${config.port}/api/docs`);
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

    // Stop webhook retry processor
    stopWebhookRetryProcessor();

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
