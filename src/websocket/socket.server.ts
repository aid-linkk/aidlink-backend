/**
 * socket.server.ts
 *
 * Initialises the Socket.IO server and wires up the backpressure sub-system:
 *
 *   BackpressureMonitor      — inspects send-buffer sizes
 *   FlowController           — wraps every broadcast with throttle/coalesce logic
 *   ClientEvictionManager    — enforces slow/idle eviction and rate limiting
 *   BackpressureObservability — periodic metrics logging + health snapshot API
 *
 * Public API (unchanged for existing callers)
 * ────────────────────────────────────────────
 *   initializeWebSocket(httpServer)     → SocketIOServer
 *   getSocketIO()                       → SocketIOServer
 *   broadcastToUser(userId, event, data)
 *   broadcastToCampaign(campaignId, event, data)
 *   broadcastToOrganization(organizationId, event, data)
 *   broadcastToBeneficiary(beneficiaryId, event, data)
 *   broadcastToAll(event, data)
 *   sendCampaignUpdate(campaignId)
 *   sendDonationUpdate(donationId)
 *   sendDistributionUpdate(distributionId)
 *   sendNotification(userId, notification)
 *   sendNotificationWithCount(userId, notification, unreadCount)
 *   sendUnreadCount(userId, unreadCount)
 *   sendCampaignSuspended(campaignId, ownerId, payload)
 *   sendCampaignReinstated(campaignId, ownerId, payload)
 *   sendAppealUpdate(ownerId, payload)
 *
 * New API (backpressure)
 * ──────────────────────
 *   getBackpressureSnapshot()           → BackpressureSnapshot | null
 *   shouldThrottleRoom(room)            → boolean
 *   getBackpressureSystem()             → { monitor, flow, eviction, observability } | null
 */

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
import {
  BackpressureMonitor,
  FlowController,
  ClientEvictionManager,
  BackpressureObservability,
  BackpressureSnapshot,
} from './backpressure/index';

let io: SocketIOServer;

// ── Backpressure sub-system singletons ─────────────────────────────────────────

let bpMonitor: BackpressureMonitor | null = null;
let bpFlow: FlowController | null = null;
let bpEviction: ClientEvictionManager | null = null;
let bpObs: BackpressureObservability | null = null;

// ── Auth types ─────────────────────────────────────────────────────────────────

export interface SocketAuthResult {
  userId: string;
  userRole: Role;
}

// ── Auth helper (unchanged) ────────────────────────────────────────────────────

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

// ── Initialise ─────────────────────────────────────────────────────────────────

export const initializeWebSocket = (httpServer: HTTPServer): SocketIOServer => {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.cors.origin,
      credentials: true,
    },
    path: '/socket.io/',
  });

  // ── Wire up backpressure sub-system ────────────────────────────────────────

  bpMonitor  = new BackpressureMonitor(io);

  // emitFn: the actual Socket.IO emit that FlowController will call after
  // throttle/coalesce decisions have been made.
  bpFlow = new FlowController(
    bpMonitor,
    (room, event, data) => {
      io.to(room).emit(event, data);
    },
  );

  bpEviction = new ClientEvictionManager(io, bpMonitor);
  bpEviction.start();

  bpObs = new BackpressureObservability(io, bpMonitor, bpFlow, bpEviction);
  bpObs.start();

  // ── Authentication middleware ──────────────────────────────────────────────

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        return next(new Error('Authentication token required'));
      }

      const { userId, userRole } = await authenticateSocketToken(token);

      socket.data.userId   = userId;
      socket.data.userRole = userRole;
      next();
    } catch (error) {
      next(new Error('Authentication failed'));
    }
  });

  // ── Connection handler ─────────────────────────────────────────────────────

  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);

    const userId = socket.data.userId as string;

    // Join user's personal room
    socket.join(`user:${userId}`);

    // ── Activity tracking for idle eviction ───────────────────────────────
    // Wrap socket.on to record every inbound event as activity.
    const originalOn = socket.on.bind(socket);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    socket.on = function (event: string, listener: (...args: any[]) => void) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalOn(event, (...args: any[]) => {
        bpEviction?.recordActivity(socket.id);
        listener(...args);
      });
    };

    // ── Campaign subscriptions ────────────────────────────────────────────
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

    // ── Organisation subscriptions ────────────────────────────────────────
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

    // ── Beneficiary subscriptions ─────────────────────────────────────────
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

    // ── Disconnect ─────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });

    // ── Welcome + initial unread count ────────────────────────────────────
    socket.emit('connected', {
      message: 'Successfully connected to AidLink real-time updates',
      userId,
    });

    prisma.notification
      .count({ where: { userId, status: 'UNREAD' } })
      .then((count: number) => {
        socket.emit('notification:unread_count', { unreadCount: count });
      })
      .catch((err: unknown) => {
        logger.error('Error fetching initial unread count:', err);
      });

    socket.on('notification:get_unread_count', function () {
      prisma.notification
        .count({ where: { userId, status: 'UNREAD' } })
        .then((count: number) => {
          socket.emit('notification:unread_count', { unreadCount: count });
        })
        .catch((err: unknown) => {
          logger.error('Error fetching unread count:', err);
        });
    });
  });

  logger.info('WebSocket server initialized');

  return io;
};

// ── Getters ────────────────────────────────────────────────────────────────────

export const getSocketIO = (): SocketIOServer => {
  if (!io) {
    throw new Error('WebSocket not initialized');
  }
  return io;
};

/**
 * Returns the backpressure sub-system components for use in tests or admin
 * endpoints.  Returns null before initializeWebSocket() has been called.
 */
export const getBackpressureSystem = (): {
  monitor:     BackpressureMonitor;
  flow:        FlowController;
  eviction:    ClientEvictionManager;
  observability: BackpressureObservability;
} | null => {
  if (!bpMonitor || !bpFlow || !bpEviction || !bpObs) return null;
  return {
    monitor:       bpMonitor,
    flow:          bpFlow,
    eviction:      bpEviction,
    observability: bpObs,
  };
};

/**
 * Returns a current backpressure snapshot (for health endpoints / dashboards).
 * Returns null before the system is initialised.
 */
export const getBackpressureSnapshot = (): BackpressureSnapshot | null => {
  return bpObs?.captureSnapshot() ?? null;
};

/**
 * Returns true if the named room is currently backpressured.
 * Event generators can call this cheaply before doing expensive DB queries.
 */
export const shouldThrottleRoom = (room: string): boolean => {
  return bpFlow?.shouldThrottle(room) ?? false;
};

// ── Internal broadcast primitive ───────────────────────────────────────────────

/**
 * Routes an event through the FlowController (backpressure / coalescing) when
 * the system is initialised, or falls back to a direct emit otherwise.
 *
 * CRITICAL events (moderation) always call io.to().emit() directly, bypassing
 * FlowController to guarantee delivery regardless of queue state.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function routedEmit(room: string, event: string, data: any): void {
  if (!io) return;

  // CRITICAL events skip FlowController entirely for maximum reliability.
  if (bpFlow?.isCriticalBypass(event)) {
    io.to(room).emit(event, data);
    return;
  }

  if (bpFlow) {
    bpFlow.emit(room, event, data);
  } else {
    io.to(room).emit(event, data);
  }
}

// ── Broadcast helpers (backward-compatible public API) ─────────────────────────

export const broadcastToUser = (userId: string, event: string, data: unknown): void => {
  routedEmit(`user:${userId}`, event, data);
};

export const broadcastToCampaign = (campaignId: string, event: string, data: unknown): void => {
  routedEmit(`campaign:${campaignId}`, event, data);
};

export const broadcastToOrganization = (organizationId: string, event: string, data: unknown): void => {
  routedEmit(`organization:${organizationId}`, event, data);
};

export const broadcastToBeneficiary = (beneficiaryId: string, event: string, data: unknown): void => {
  routedEmit(`beneficiary:${beneficiaryId}`, event, data);
};

export const broadcastToAll = (event: string, data: unknown): void => {
  if (io) {
    if (bpFlow?.isCriticalBypass(event)) {
      io.emit(event, data);
    } else if (bpFlow) {
      // There is no single "all" room — emit directly but still check global
      // backpressure for observability.
      if (!bpMonitor?.isGlobalBackpressured()) {
        io.emit(event, data);
      } else {
        logger.warn('broadcastToAll: global backpressure — event dropped', { event });
      }
    } else {
      io.emit(event, data);
    }
  }
};

// ── Real-time update functions (unchanged public surface) ──────────────────────

export const sendCampaignUpdate = async (campaignId: string): Promise<void> => {
  // Check backpressure before doing the DB fetch.
  const room = `campaign:${campaignId}`;
  if (shouldThrottleRoom(room)) {
    logger.debug('sendCampaignUpdate: room backpressured, skipping DB fetch', { campaignId });
    return;
  }

  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        _count: {
          select: {
            donations:     true,
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
        user:     true,
      },
    });

    if (donation) {
      broadcastToCampaign(donation.campaignId, 'donation:created', donation);

      if (donation.userId) {
        broadcastToUser(donation.userId, 'donation:created', donation);
      }

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
        campaign:    true,
        beneficiary: true,
      },
    });

    if (distribution) {
      broadcastToCampaign(distribution.campaignId, 'distribution:updated', distribution);
      broadcastToBeneficiary(distribution.beneficiaryId, 'distribution:updated', distribution);

      await sendCampaignUpdate(distribution.campaignId);
    }
  } catch (error) {
    logger.error('Error sending distribution update:', error);
  }
};

export const sendNotification = (userId: string, notification: unknown): void => {
  broadcastToUser(userId, 'notification:new', notification);
};

export const sendNotificationWithCount = (
  userId: string,
  notification: unknown,
  unreadCount: number,
): void => {
  broadcastToUser(userId, 'notification:new', notification);
  broadcastToUser(userId, 'notification:unread_count', { unreadCount });
};

export const sendUnreadCount = (userId: string, unreadCount: number): void => {
  broadcastToUser(userId, 'notification:unread_count', { unreadCount });
};

// ── Moderation events (CRITICAL — always bypass flow control) ──────────────────

export const sendCampaignSuspended = async (
  campaignId: string,
  ownerId:    string,
  payload:    unknown,
): Promise<void> => {
  const room = `campaign:${campaignId}`;

  // Invalidate authorization cache so reconnecting clients re-query the DB.
  await invalidateCampaignAuthorizationCache(campaignId);

  // Broadcast suspension to room (CRITICAL — bypasses FlowController).
  if (io) {
    io.in(room).emit('campaign:suspended', payload);
  }

  // Notify the campaign owner's personal room.
  broadcastToUser(ownerId, 'campaign:suspended', payload);

  // Snapshot room membership *before* eviction.
  const roomSockets = io
    ? (io.sockets.adapter.rooms.get(room) ?? new Set<string>())
    : new Set<string>();
  const evictedSocketIds = [...roomSockets];

  // Evict all sockets from the room.
  if (io) {
    io.in(room).socketsLeave(room);
  }

  // Send campaign:access_revoked to each evicted socket's user room.
  if (io) {
    for (const socketId of evictedSocketIds) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        const socketUserId = socket.data.userId as string;
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
  ownerId:    string,
  payload:    unknown,
): Promise<void> => {
  // CRITICAL — goes direct without FlowController.
  broadcastToCampaign(campaignId, 'campaign:reinstated', payload);
  broadcastToUser(ownerId, 'campaign:reinstated', payload);
  broadcastToUser(ownerId, 'campaign:access_restored', {
    campaignId,
    reason: 'reinstated',
  });

  logger.info(`Campaign ${campaignId} reinstated: notified owner ${ownerId}`);
};

export const sendAppealUpdate = (ownerId: string, payload: unknown): void => {
  broadcastToUser(ownerId, 'appeal:updated', payload);
};
