import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { Role } from '@prisma/client';
import { config } from '../config';
import logger from '../config/logger';
import prisma from '../config/database';
import { JWTUtils } from '../utils/jwt';
import {
  authorizeCampaignJoin,
  authorizeOrganizationJoin,
  authorizeBeneficiaryJoin,
  invalidateCampaignAuthorizationCache,
  AuthorizationContext,
} from './authorization';

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
    socket.on('join_campaign', async (campaignId: string) => {
      const authContext: AuthorizationContext = {
        userId,
        userRole: socket.data.userRole,
      };

      const authResult = await authorizeCampaignJoin(authContext, campaignId);

      if (!authResult.authorized) {
        socket.emit('room:join_error', {
          room: `campaign:${campaignId}`,
          reason: authResult.reason || 'forbidden',
        });
        logger.warn(
          `User ${userId} denied access to campaign ${campaignId}: ${authResult.reason}`
        );
        return;
      }

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
    socket.on('join_organization', async (organizationId: string) => {
      const authContext: AuthorizationContext = {
        userId,
        userRole: socket.data.userRole,
      };

      const authResult = await authorizeOrganizationJoin(authContext, organizationId);

      if (!authResult.authorized) {
        socket.emit('room:join_error', {
          room: `organization:${organizationId}`,
          reason: authResult.reason || 'forbidden',
        });
        logger.warn(
          `User ${userId} denied access to organization ${organizationId}: ${authResult.reason}`
        );
        return;
      }

      socket.join(`organization:${organizationId}`);
      logger.info(`User ${userId} joined organization ${organizationId}`);
    });

    socket.on('leave_organization', (organizationId: string) => {
      socket.leave(`organization:${organizationId}`);
      logger.info(`User ${userId} left organization ${organizationId}`);
    });

    // Handle beneficiary subscriptions
    socket.on('join_beneficiary', async (beneficiaryId: string) => {
      const authContext: AuthorizationContext = {
        userId,
        userRole: socket.data.userRole,
      };

      const authResult = await authorizeBeneficiaryJoin(authContext, beneficiaryId);

      if (!authResult.authorized) {
        socket.emit('room:join_error', {
          room: `beneficiary:${beneficiaryId}`,
          reason: authResult.reason || 'forbidden',
        });
        logger.warn(
          `User ${userId} denied access to beneficiary ${beneficiaryId}: ${authResult.reason}`
        );
        return;
      }

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

export const sendCampaignSuspended = async (
  campaignId: string,
  ownerId: string,
  payload: any
): Promise<void> => {
  const room = `campaign:${campaignId}`;

  // Step 1 — Invalidate authorization cache so that any reconnect attempt
  // re-queries the DB and finds the campaign suspended.
  await invalidateCampaignAuthorizationCache(campaignId);

  // Step 2 — Broadcast campaign:suspended to everyone currently in the room
  // *before* evicting them so clients know why they are being removed.
  // Socket.IO emit() is synchronous in the send queue, so the event is
  // enqueued before socketsLeave() runs.
  if (io) {
    io.in(room).emit('campaign:suspended', payload);
  }

  // Also notify the campaign owner via their personal user room.
  broadcastToUser(ownerId, 'campaign:suspended', payload);

  // Step 3 — Collect the socket IDs currently in the room *before* eviction
  // so we can send each one a personalised campaign:access_revoked event.
  // We snapshot the Set now because socketsLeave will empty it.
  const roomSockets = io
    ? (io.sockets.adapter.rooms.get(room) ?? new Set<string>())
    : new Set<string>();
  const evictedSocketIds = [...roomSockets];

  // Step 4 — Forcibly remove all sockets from the room.
  // socketsLeave is the Socket.IO v4 API that works with all official adapters
  // (in-memory, Redis, cluster) and atomically removes every socket in the
  // room from that room.
  if (io) {
    io.in(room).socketsLeave(room);
  }

  // Step 5 — Emit campaign:access_revoked to each evicted socket's personal
  // user room so the client can distinguish "campaign suspended" from
  // "connection dropped".  We look up the socket's userId from socket.data.
  if (io) {
    for (const socketId of evictedSocketIds) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        const socketUserId: string = socket.data.userId as string;
        if (socketUserId) {
          io.to(`user:${socketUserId}`).emit('campaign:access_revoked', {
            campaignId,
            reason: 'suspended',
          });
        }
      }
    }
  }

  logger.info(
    `Campaign ${campaignId} suspended: evicted ${evictedSocketIds.length} socket(s) from room ${room}`
  );
};

export const sendCampaignReinstated = async (
  campaignId: string,
  ownerId: string,
  payload: any
): Promise<void> => {
  // Broadcast reinstatement to any sockets still in the room (e.g. ADMIN/
  // AUDITOR who were not evicted on suspension).
  broadcastToCampaign(campaignId, 'campaign:reinstated', payload);

  // Notify the campaign owner via their personal user room so that client
  // code can listen on the user room and automatically re-emit join_campaign.
  broadcastToUser(ownerId, 'campaign:reinstated', payload);

  // Emit campaign:access_restored to the campaign owner's personal user room.
  // Previously-evicted clients should subscribe to this event on their own
  // user room so they know it is now safe to call join_campaign again.
  broadcastToUser(ownerId, 'campaign:access_restored', {
    campaignId,
    reason: 'reinstated',
  });

  logger.info(`Campaign ${campaignId} reinstated: notified owner ${ownerId}`);
};

export const sendAppealUpdate = (ownerId: string, payload: any): void => {
  broadcastToUser(ownerId, 'appeal:updated', payload);
};
