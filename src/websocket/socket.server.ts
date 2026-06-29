import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { Role } from '@prisma/client';
import { config } from '../config';
import logger from '../config/logger';
import prisma from '../config/database';
import { JWTUtils } from '../utils/jwt';

let io: SocketIOServer;

export interface SocketAuthResult {
  userId: string;
  userRole: Role;
}

export const authenticateSocketToken = async (token: string): Promise<SocketAuthResult> => {
  try {
    const payload = JWTUtils.verifyToken(token);
    const userId = JWTUtils.getUserId(payload);

    if (!userId) {
      throw new Error('Authentication failed');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new Error('User not found');
    }

    return { userId: user.id, userRole: user.role };
  } catch (error) {
    throw new Error('Authentication failed');
  }
};

export const initializeWebSocket = (httpServer: HTTPServer): SocketIOServer => {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.cors.origin,
      credentials: true,
    },
    path: '/socket.io/',
  });

  // Authentication middleware for Socket.IO
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        return next(new Error('Authentication token required'));
      }

      const { userId, userRole } = await authenticateSocketToken(token);

      socket.data.userId = userId;
      socket.data.userRole = userRole;
      next();
    } catch (error) {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);

    // Join user's personal room
    const userId = socket.data.userId;
    socket.join(`user:${userId}`);

    // Handle campaign subscriptions
    socket.on('join_campaign', (campaignId: string) => {
      socket.join(`campaign:${campaignId}`);
      logger.info(`User ${userId} joined campaign ${campaignId}`);

      // Send current campaign data to the newly joined client
      sendCampaignUpdate(campaignId);
    });

    socket.on('leave_campaign', (campaignId: string) => {
      socket.leave(`campaign:${campaignId}`);
      logger.info(`User ${userId} left campaign ${campaignId}`);
    });

    // Handle organization subscriptions
    socket.on('join_organization', (organizationId: string) => {
      socket.join(`organization:${organizationId}`);
      logger.info(`User ${userId} joined organization ${organizationId}`);
    });

    socket.on('leave_organization', (organizationId: string) => {
      socket.leave(`organization:${organizationId}`);
      logger.info(`User ${userId} left organization ${organizationId}`);
    });

    // Handle beneficiary subscriptions
    socket.on('join_beneficiary', (beneficiaryId: string) => {
      socket.join(`beneficiary:${beneficiaryId}`);
      logger.info(`User ${userId} joined beneficiary ${beneficiaryId}`);
    });

    socket.on('leave_beneficiary', (beneficiaryId: string) => {
      socket.leave(`beneficiary:${beneficiaryId}`);
      logger.info(`User ${userId} left beneficiary ${beneficiaryId}`);
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });

    // Send welcome message with initial unread count
    socket.emit('connected', {
      message: 'Successfully connected to AidLink real-time updates',
      userId,
    });

    // Send initial unread notification count on connect
    prisma.notification
      .count({
        where: { userId, status: 'UNREAD' },
      })
      .then(function (count) {
        socket.emit('notification:unread_count', { unreadCount: count });
      })
      .catch(function (err) {
        logger.error('Error fetching initial unread count:', err);
      });

    // Handle unread count requests from clients
    socket.on('notification:get_unread_count', function () {
      prisma.notification
        .count({
          where: { userId, status: 'UNREAD' },
        })
        .then(function (count) {
          socket.emit('notification:unread_count', { unreadCount: count });
        })
        .catch(function (err) {
          logger.error('Error fetching unread count:', err);
        });
    });
  });

  logger.info('WebSocket server initialized');

  return io;
};

export const getSocketIO = (): SocketIOServer => {
  if (!io) {
    throw new Error('WebSocket not initialized');
  }
  return io;
};

// Helper functions to broadcast events
export const broadcastToUser = (userId: string, event: string, data: any): void => {
  if (io) {
    io.to(`user:${userId}`).emit(event, data);
  }
};

export const broadcastToCampaign = (campaignId: string, event: string, data: any): void => {
  if (io) {
    io.to(`campaign:${campaignId}`).emit(event, data);
  }
};

export const broadcastToOrganization = (organizationId: string, event: string, data: any): void => {
  if (io) {
    io.to(`organization:${organizationId}`).emit(event, data);
  }
};

export const broadcastToBeneficiary = (beneficiaryId: string, event: string, data: any): void => {
  if (io) {
    io.to(`beneficiary:${beneficiaryId}`).emit(event, data);
  }
};

export const broadcastToAll = (event: string, data: any): void => {
  if (io) {
    io.emit(event, data);
  }
};

// Real-time update functions
export const sendCampaignUpdate = async (campaignId: string): Promise<void> => {
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        _count: {
          select: {
            donations: true,
            beneficiaries: true,
            distributions: true,
          },
        },
      },
    });

    if (campaign) {
      broadcastToCampaign(campaignId, 'campaign:updated', campaign);
    }
  } catch (error) {
    logger.error('Error sending campaign update:', error);
  }
};

export const sendDonationUpdate = async (donationId: string): Promise<void> => {
  try {
    const donation = await prisma.donation.findUnique({
      where: { id: donationId },
      include: {
        campaign: true,
        user: true,
      },
    });

    if (donation) {
      // Notify campaign subscribers
      broadcastToCampaign(donation.campaignId, 'donation:created', donation);

      // Notify the donor
      if (donation.userId) {
        broadcastToUser(donation.userId, 'donation:created', donation);
      }

      // Send updated campaign data
      await sendCampaignUpdate(donation.campaignId);
    }
  } catch (error) {
    logger.error('Error sending donation update:', error);
  }
};

export const sendDistributionUpdate = async (distributionId: string): Promise<void> => {
  try {
    const distribution = await prisma.distribution.findUnique({
      where: { id: distributionId },
      include: {
        campaign: true,
        beneficiary: true,
      },
    });

    if (distribution) {
      // Notify campaign subscribers
      broadcastToCampaign(distribution.campaignId, 'distribution:updated', distribution);

      // Notify the beneficiary
      broadcastToBeneficiary(distribution.beneficiaryId, 'distribution:updated', distribution);

      // Send updated campaign data
      await sendCampaignUpdate(distribution.campaignId);
    }
  } catch (error) {
    logger.error('Error sending distribution update:', error);
  }
};

export const sendNotification = (userId: string, notification: any): void => {
  broadcastToUser(userId, 'notification:new', notification);
};

export const sendNotificationWithCount = (
  userId: string,
  notification: any,
  unreadCount: number
): void => {
  broadcastToUser(userId, 'notification:new', notification);
  broadcastToUser(userId, 'notification:unread_count', { unreadCount });
};

export const sendUnreadCount = (userId: string, unreadCount: number): void => {
  broadcastToUser(userId, 'notification:unread_count', { unreadCount });
};

// ─── Moderation events ─────────────────────────────────────────

export const sendCampaignSuspended = (campaignId: string, ownerId: string, payload: any): void => {
  broadcastToCampaign(campaignId, 'campaign:suspended', payload);
  broadcastToUser(ownerId, 'campaign:suspended', payload);
};

export const sendCampaignReinstated = (campaignId: string, ownerId: string, payload: any): void => {
  broadcastToCampaign(campaignId, 'campaign:reinstated', payload);
  broadcastToUser(ownerId, 'campaign:reinstated', payload);
};

export const sendAppealUpdate = (ownerId: string, payload: any): void => {
  broadcastToUser(ownerId, 'appeal:updated', payload);
};
