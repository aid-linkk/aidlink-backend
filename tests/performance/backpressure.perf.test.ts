/**
 * Performance and regression tests for the backpressure system
 *
 * Tests cover:
 *   Performance:
 *     P1. BackpressureMonitor.getClientBufferBytes()  < 1 ms per call
 *     P2. BackpressureMonitor.getRoomBufferStats()    < 1 ms per call (1 000-socket room)
 *     P3. BackpressureMonitor.getGlobalBufferStats()  < 5 ms per call (10 000 sockets)
 *     P4. ClientEvictionManager evictSocket()         < 10 ms
 *     P5. FlowController.emit() overhead              < 1 ms per call
 *     P6. 10 000 concurrent clients: queue memory stays bounded under event storm
 *
 *   Regression:
 *     R1. Existing broadcast function exports are present and callable
 *     R2. New backpressure API exports are present
 *     R3. getBackpressureSnapshot returns null before initialization
 *     R4. shouldThrottleRoom returns false before initialization (fail-open)
 *     R5. All events classify to the correct priority
 *     R6. Reconnection: evicted socket state is cleared for fresh reconnect
 */

// ── Mocks (must come before any require of socket.server) ─────────────────────

jest.mock('../../src/config/database', () => ({
  __esModule: true,
  default: {
    campaign:     { findUnique: jest.fn() },
    notification: { count: jest.fn() },
    donation:     { findUnique: jest.fn() },
    distribution: { findUnique: jest.fn() },
    user:         { findUnique: jest.fn() },
  },
}));

jest.mock('../../src/config/logger', () => ({
  __esModule: true,
  default: {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../src/config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

jest.mock('../../src/utils/jwt', () => ({
  JWTUtils: { verifyToken: jest.fn(), getUserId: jest.fn() },
}));

jest.mock('../../src/websocket/authorization', () => ({
  authorizeCampaignJoin:          jest.fn(),
  authorizeOrganizationJoin:      jest.fn(),
  authorizeBeneficiaryJoin:       jest.fn(),
  invalidateCampaignAuthorizationCache: jest.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { BackpressureMonitor }            from '../../src/websocket/backpressure/BackpressureMonitor';
import { FlowController, EmitFn }         from '../../src/websocket/backpressure/FlowController';
import { ClientEvictionManager }          from '../../src/websocket/backpressure/ClientEvictionManager';
import { PriorityEventQueue, EventPriority } from '../../src/websocket/backpressure/PriorityEventQueue';
import { Server as SocketIOServer }       from 'socket.io';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockIO(
  socketCount = 0,
  roomMap?: Map<string, string[]>,
): SocketIOServer {
  const sockets = new Map<string, unknown>();
  const rooms   = new Map<string, Set<string>>();

  for (let i = 0; i < socketCount; i++) {
    const id = `socket-${i}`;
    sockets.set(id, { id, data: { userId: `user-${i}` } });
  }

  if (roomMap) {
    for (const [room, ids] of roomMap) {
      rooms.set(room, new Set(ids));
    }
  }

  return { sockets: { sockets, adapter: { rooms } } } as unknown as SocketIOServer;
}

function makeMonitorWithMocks(
  io: SocketIOServer,
  defaultBufferBytes = 0,
  thresholds?: { clientBytes: number; roomBytes: number; globalBytes: number },
): BackpressureMonitor {
  const socketMap = (io as unknown as { sockets: { sockets: Map<string, unknown> } })
    .sockets.sockets;
  const buffers = new Map<string, number>();
  for (const [id] of socketMap) buffers.set(id, defaultBufferBytes);

  const monitor = new BackpressureMonitor(io, thresholds ?? {
    clientBytes:  1_000_000,
    roomBytes:   10_000_000,
    globalBytes: 100_000_000,
  });
  monitor.injectMockBuffers(buffers);
  return monitor;
}

// ── Performance tests ──────────────────────────────────────────────────────────

describe('Performance: BackpressureMonitor', () => {
  it('P1: getClientBufferBytes() completes < 1 ms per call (averaged over 1 000 calls)', () => {
    const io      = makeMockIO(1);
    const monitor = makeMonitorWithMocks(io, 512);

    const start = performance.now();
    for (let i = 0; i < 1000; i++) monitor.getClientBufferBytes('socket-0');
    const elapsed = (performance.now() - start) / 1000; // ms per call

    expect(elapsed).toBeLessThan(1);
  });

  it('P2: getRoomBufferStats() completes < 1 ms per call for a 1 000-socket room', () => {
    const socketIds = Array.from({ length: 1000 }, (_, i) => `socket-${i}`);
    const io = makeMockIO(1000, new Map([['campaign:big', socketIds]]));
    const monitor = makeMonitorWithMocks(io, 100);

    const start = performance.now();
    for (let i = 0; i < 100; i++) monitor.getRoomBufferStats('campaign:big');
    const elapsed = (performance.now() - start) / 100;

    expect(elapsed).toBeLessThan(1);
  });

  it('P3: getGlobalBufferStats() completes < 5 ms per call for 10 000 sockets', () => {
    // 10 000 sockets — O(n) scan. Jest/ts-jest overhead is included.
    // The spec requires < 1 ms for queue SIZE checks; global scan is a
    // heavier diagnostic operation. We verify it is < 5 ms (still sub-frame).
    const io      = makeMockIO(10_000);
    const monitor = makeMonitorWithMocks(io, 200);

    const start = performance.now();
    for (let i = 0; i < 10; i++) monitor.getGlobalBufferStats();
    const elapsed = (performance.now() - start) / 10;

    expect(elapsed).toBeLessThan(5);
  });
});

describe('Performance: ClientEvictionManager', () => {
  it('P4: evictSocket() completes < 10 ms', () => {
    const io             = makeMockIO(1);
    const disconnectMock = jest.fn();
    const socket         = { id: 'socket-0', data: { userId: 'u0' }, disconnect: disconnectMock };
    (io.sockets.sockets as Map<string, unknown>).set('socket-0', socket);

    const monitor = makeMonitorWithMocks(io, 0);
    const mgr     = new ClientEvictionManager(io, monitor, { sweepIntervalMs: 999999, idleTimeoutMs: 999999 });

    const start = performance.now();
    mgr.evictSocket('socket-0', 'slow_client');
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(10);
    expect(disconnectMock).toHaveBeenCalledWith(true);
  });
});

describe('Performance: FlowController emit overhead', () => {
  it('P5: emit() overhead < 1 ms per call for non-backpressured events', () => {
    const io     = makeMockIO();
    const monitor = makeMonitorWithMocks(io, 0);
    const calls: unknown[] = [];
    const emitFn: EmitFn   = (_, __, d) => calls.push(d);
    const fc = new FlowController(monitor, emitFn, { drainIntervalMs: 999999, coalesceWindowMs: 999999 });

    const start = performance.now();
    for (let i = 0; i < 1000; i++) fc.emit(`room:${i % 10}`, 'donation:created', { n: i });
    const elapsed = (performance.now() - start) / 1000;

    expect(elapsed).toBeLessThan(1);
    fc.destroy();
  });
});

describe('Performance: memory bounded under event storm', () => {
  it('P6: PriorityEventQueue capacity caps limit memory regardless of flood size', () => {
    const LEVEL_CAPACITY = 500;
    const q = new PriorityEventQueue({ levelCapacity: LEVEL_CAPACITY });

    // Flood with 10 000 non-CRITICAL events across HIGH, MEDIUM, LOW
    for (let i = 0; i < 10_000; i++) {
      const level = ((i % 3) + 1) as EventPriority; // 1=HIGH, 2=MEDIUM, 3=LOW
      q.enqueue('donation:created', { n: i }, level);
    }

    const stats = q.stats();
    expect(stats.high).toBeLessThanOrEqual(LEVEL_CAPACITY);
    expect(stats.medium).toBeLessThanOrEqual(LEVEL_CAPACITY);
    expect(stats.low).toBeLessThanOrEqual(LEVEL_CAPACITY);
    expect(stats.total).toBeLessThanOrEqual(LEVEL_CAPACITY * 3);
  });
});

// ── Regression tests ──────────────────────────────────────────────────────────

describe('Regression: broadcast function exports', () => {
  it('R1: all existing broadcast functions are exported from socket.server', () => {
    const mod = require('../../src/websocket/socket.server');

    expect(typeof mod.broadcastToUser).toBe('function');
    expect(typeof mod.broadcastToCampaign).toBe('function');
    expect(typeof mod.broadcastToOrganization).toBe('function');
    expect(typeof mod.broadcastToBeneficiary).toBe('function');
    expect(typeof mod.broadcastToAll).toBe('function');
    expect(typeof mod.sendCampaignUpdate).toBe('function');
    expect(typeof mod.sendDonationUpdate).toBe('function');
    expect(typeof mod.sendDistributionUpdate).toBe('function');
    expect(typeof mod.sendNotification).toBe('function');
    expect(typeof mod.sendNotificationWithCount).toBe('function');
    expect(typeof mod.sendUnreadCount).toBe('function');
    expect(typeof mod.sendCampaignSuspended).toBe('function');
    expect(typeof mod.sendCampaignReinstated).toBe('function');
    expect(typeof mod.sendAppealUpdate).toBe('function');
  });

  it('R1b: broadcast functions are no-ops when io is not initialised (no throw)', () => {
    const mod = require('../../src/websocket/socket.server');

    expect(() => mod.broadcastToUser('u1', 'test', {})).not.toThrow();
    expect(() => mod.broadcastToCampaign('c1', 'test', {})).not.toThrow();
    expect(() => mod.broadcastToOrganization('o1', 'test', {})).not.toThrow();
    expect(() => mod.broadcastToBeneficiary('b1', 'test', {})).not.toThrow();
    expect(() => mod.broadcastToAll('test', {})).not.toThrow();
    expect(() => mod.sendNotification('u1', {})).not.toThrow();
    expect(() => mod.sendUnreadCount('u1', 5)).not.toThrow();
    expect(() => mod.sendAppealUpdate('u1', {})).not.toThrow();
  });

  it('R2: new backpressure API functions are exported', () => {
    const mod = require('../../src/websocket/socket.server');

    expect(typeof mod.getBackpressureSnapshot).toBe('function');
    expect(typeof mod.shouldThrottleRoom).toBe('function');
    expect(typeof mod.getBackpressureSystem).toBe('function');
    expect(typeof mod.getSocketIO).toBe('function');
    expect(typeof mod.authenticateSocketToken).toBe('function');
  });

  it('R3: getBackpressureSnapshot() returns null before initialisation', () => {
    const mod = require('../../src/websocket/socket.server');
    expect(mod.getBackpressureSnapshot()).toBeNull();
  });

  it('R4: shouldThrottleRoom() returns false before initialisation (fail-open)', () => {
    const mod = require('../../src/websocket/socket.server');
    expect(mod.shouldThrottleRoom('campaign:1')).toBe(false);
  });
});

describe('Regression: event classification', () => {
  it('R5: every documented event maps to the correct priority', () => {
    const { classifyEvent, EventPriority: EP } =
      require('../../src/websocket/backpressure/PriorityEventQueue');

    // CRITICAL — moderation
    ['campaign:suspended', 'campaign:reinstated', 'campaign:access_revoked',
     'campaign:access_restored', 'appeal:updated'].forEach((e) =>
      expect(classifyEvent(e)).toBe(EP.CRITICAL));

    // HIGH — transactions
    ['donation:created', 'donation:confirmed', 'distribution:updated',
     'distribution:confirmed', 'beneficiary:updated'].forEach((e) =>
      expect(classifyEvent(e)).toBe(EP.HIGH));

    // MEDIUM — informational
    ['campaign:updated', 'organization:updated', 'notification:new'].forEach((e) =>
      expect(classifyEvent(e)).toBe(EP.MEDIUM));

    // LOW — analytics/counters
    ['notification:unread_count', 'campaign:trending', 'analytics:refresh'].forEach((e) =>
      expect(classifyEvent(e)).toBe(EP.LOW));
  });
});

describe('Regression: reconnection after eviction', () => {
  it('R6: evicted socket state is cleared — fresh bucket on reconnect', () => {
    const io      = makeMockIO(1);
    const monitor = makeMonitorWithMocks(io, 0);
    const mgr     = new ClientEvictionManager(io, monitor, {
      sweepIntervalMs: 999999,
      idleTimeoutMs:   999999,
      eventsPerSecond: 5,
    });

    const socket = { id: 'socket-0', data: { userId: 'u0' }, disconnect: jest.fn() };
    (io.sockets.sockets as Map<string, unknown>).set('socket-0', socket);

    // Drain the token bucket
    for (let i = 0; i < 5; i++) mgr.checkRateLimit('socket-0');
    expect(mgr.checkRateLimit('socket-0')).toBe(false); // empty

    // Evict clears state
    mgr.evictSocket('socket-0', 'slow_client');
    expect(socket.disconnect).toHaveBeenCalledWith(true);

    // Reconnect — onConnect re-creates state with a full bucket
    (io.sockets.sockets as Map<string, unknown>).set('socket-0', socket);
    mgr.onConnect('socket-0');

    expect(mgr.checkRateLimit('socket-0')).toBe(true);
  });
});
