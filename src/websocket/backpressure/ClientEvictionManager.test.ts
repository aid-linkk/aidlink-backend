/**
 * Integration tests for ClientEvictionManager
 *
 * Tests cover:
 *   1. Slow-client eviction: socket disconnected after buffer exceeds threshold for sustainMs
 *   2. No eviction if buffer clears before sustainMs elapses
 *   3. Idle-client eviction: socket disconnected after idleTimeoutMs with no activity
 *   4. recordActivity() resets the idle timer
 *   5. Rate limiting: checkRateLimit() returns false after eventsPerSecond events
 *   6. Rate limiting refills over time
 *   7. onConnect / onDisconnect lifecycle
 *   8. sweep() cleans up stale state for self-disconnected sockets
 *   9. recentEvictions() returns history (most recent first)
 *  10. destroy() stops the sweep timer
 */

import { ClientEvictionManager, EvictionReason } from './ClientEvictionManager';
import { BackpressureMonitor }                    from './BackpressureMonitor';
import { Server as SocketIOServer }               from 'socket.io';

// ── Mock helpers ──────────────────────────────────────────────────────────────

interface MockSocket {
  id: string;
  data: { userId?: string };
  disconnected: boolean;
  disconnect: jest.Mock;
  // Event handlers registered by ClientEvictionManager
  _handlers: Map<string, (() => void)[]>;
  on: jest.Mock;
}

function makeMockSocket(id: string, userId?: string): MockSocket {
  const handlers = new Map<string, (() => void)[]>();

  const onFn = jest.fn((event: string, cb: () => void) => {
    const list = handlers.get(event) ?? [];
    list.push(cb);
    handlers.set(event, list);
  });

  return {
    id,
    data: { userId },
    disconnected: false,
    disconnect: jest.fn(function (this: MockSocket) {
      this.disconnected = true;
      // Fire 'disconnect' listeners so ClientEvictionManager cleans up state
      (handlers.get('disconnect') ?? []).forEach((h) => h());
    }),
    _handlers: handlers,
    on: onFn,
  };
}

interface MockIO {
  io: SocketIOServer;
  sockets: Map<string, MockSocket>;
  rooms: Map<string, Set<string>>;
  connectionHandlers: Array<(socket: MockSocket) => void>;
  simulateConnect: (socket: MockSocket) => void;
}

function makeMockIO(): MockIO {
  const sockets = new Map<string, MockSocket>();
  const rooms   = new Map<string, Set<string>>();
  const connectionHandlers: Array<(socket: MockSocket) => void> = [];

  const io = {
    sockets: {
      sockets,
      adapter: { rooms },
    },
    on: (event: string, handler: (socket: MockSocket) => void) => {
      if (event === 'connection') connectionHandlers.push(handler);
    },
  } as unknown as SocketIOServer;

  const simulateConnect = (socket: MockSocket): void => {
    sockets.set(socket.id, socket as unknown as MockSocket);
    connectionHandlers.forEach((h) => h(socket));
  };

  return { io, sockets, rooms, connectionHandlers, simulateConnect };
}

function makeMonitor(
  io: SocketIOServer,
  buffers: Map<string, number> = new Map(),
  thresholds = { clientBytes: 1000, roomBytes: 50000, globalBytes: 500000 },
): BackpressureMonitor {
  const m = new BackpressureMonitor(io, thresholds);
  m.injectMockBuffers(buffers);
  return m;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ClientEvictionManager integration', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(()  => jest.useRealTimers());

  // ── 1. Slow-client eviction ──────────────────────────────────────────────

  describe('slow-client eviction', () => {
    it('disconnects a socket that stays backpressured for sustainMs', () => {
      const mock    = makeMockIO();
      const buffers = new Map<string, number>();
      const monitor = makeMonitor(mock.io, buffers);
      const mgr     = new ClientEvictionManager(mock.io, monitor, {
        sweepIntervalMs: 100,
        slowSustainMs:   250,
        idleTimeoutMs:   999999,
        eventsPerSecond: 100,
      });
      mgr.start();

      const socket = makeMockSocket('s1', 'user1');
      mock.simulateConnect(socket);

      // Socket s1 is now backpressured
      buffers.set('s1', 99999);

      // Sweep 1 (t=100): slowSince stamped at ~100ms, sustainMs not reached
      jest.advanceTimersByTime(100);
      expect(socket.disconnect).not.toHaveBeenCalled();

      // Sweep 2 (t=200): elapsed ~100ms from slowSince < 250ms sustainMs
      jest.advanceTimersByTime(100);
      expect(socket.disconnect).not.toHaveBeenCalled();

      // Sweep 3 (t=300): elapsed ~200ms from slowSince < 250ms sustainMs
      jest.advanceTimersByTime(100);
      expect(socket.disconnect).not.toHaveBeenCalled();

      // Sweep 4 (t=400): elapsed ~300ms from slowSince >= 250ms sustainMs → evict
      jest.advanceTimersByTime(100);
      expect(socket.disconnect).toHaveBeenCalledWith(true);

      mgr.destroy();
    });

    it('resets slow timer when buffer clears before sustainMs', () => {
      const mock    = makeMockIO();
      const buffers = new Map<string, number>();
      const monitor = makeMonitor(mock.io, buffers);
      const mgr     = new ClientEvictionManager(mock.io, monitor, {
        sweepIntervalMs: 100,
        slowSustainMs:   300,
        idleTimeoutMs:   999999,
        eventsPerSecond: 100,
      });
      mgr.start();

      const socket = makeMockSocket('s1', 'user1');
      mock.simulateConnect(socket);

      // Backpressure starts
      buffers.set('s1', 99999);
      jest.advanceTimersByTime(100); // sweep 1 — slowSince set
      jest.advanceTimersByTime(100); // sweep 2 — 200ms < 300ms sustainMs

      // Buffer clears
      buffers.set('s1', 0);
      jest.advanceTimersByTime(100); // sweep 3 — slowSince reset

      // Pressure comes back — new 300ms window starts
      buffers.set('s1', 99999);
      jest.advanceTimersByTime(100); // sweep 4 — new slowSince
      jest.advanceTimersByTime(100); // sweep 5 — 100ms < 300ms

      expect(socket.disconnect).not.toHaveBeenCalled();

      mgr.destroy();
    });
  });

  // ── 3. Idle-client eviction ───────────────────────────────────────────────

  describe('idle-client eviction', () => {
    it('disconnects a socket that has been idle for idleTimeoutMs', () => {
      const mock    = makeMockIO();
      const monitor = makeMonitor(mock.io);
      const mgr     = new ClientEvictionManager(mock.io, monitor, {
        sweepIntervalMs: 100,
        slowSustainMs:   999999,
        idleTimeoutMs:   300,
        eventsPerSecond: 100,
      });
      mgr.start();

      const socket = makeMockSocket('s1', 'user1');
      mock.simulateConnect(socket);

      // Advance past idle timeout
      jest.advanceTimersByTime(400);

      expect(socket.disconnect).toHaveBeenCalledWith(true);

      mgr.destroy();
    });

    it('does not evict socket whose idle timer is reset by recordActivity()', () => {
      const mock    = makeMockIO();
      const monitor = makeMonitor(mock.io);
      const mgr     = new ClientEvictionManager(mock.io, monitor, {
        sweepIntervalMs: 100,
        slowSustainMs:   999999,
        idleTimeoutMs:   300,
        eventsPerSecond: 100,
      });
      mgr.start();

      const socket = makeMockSocket('s1', 'user1');
      mock.simulateConnect(socket);

      // Keep resetting idle at 200ms intervals (before 300ms timeout)
      jest.advanceTimersByTime(200);
      mgr.recordActivity('s1');
      jest.advanceTimersByTime(200);
      mgr.recordActivity('s1');
      jest.advanceTimersByTime(200);
      mgr.recordActivity('s1');
      jest.advanceTimersByTime(100);

      expect(socket.disconnect).not.toHaveBeenCalled();

      mgr.destroy();
    });
  });

  // ── 5. Per-client rate limiting ───────────────────────────────────────────

  describe('per-client rate limiting', () => {
    it('returns true for the first N events within eventsPerSecond', () => {
      const mock    = makeMockIO();
      const monitor = makeMonitor(mock.io);
      const mgr     = new ClientEvictionManager(mock.io, monitor, {
        sweepIntervalMs: 999999,
        idleTimeoutMs:   999999,
        eventsPerSecond: 5,
      });
      mgr.start();

      // First 5 events should be allowed
      for (let i = 0; i < 5; i++) {
        expect(mgr.checkRateLimit('s1')).toBe(true);
      }

      mgr.destroy();
    });

    it('returns false once the bucket is empty', () => {
      const mock    = makeMockIO();
      const monitor = makeMonitor(mock.io);
      const mgr     = new ClientEvictionManager(mock.io, monitor, {
        sweepIntervalMs: 999999,
        idleTimeoutMs:   999999,
        eventsPerSecond: 3,
      });
      mgr.start();

      mgr.checkRateLimit('s1');
      mgr.checkRateLimit('s1');
      mgr.checkRateLimit('s1');

      expect(mgr.checkRateLimit('s1')).toBe(false);

      mgr.destroy();
    });

    it('refills the bucket over time', () => {
      const mock    = makeMockIO();
      const monitor = makeMonitor(mock.io);
      const mgr     = new ClientEvictionManager(mock.io, monitor, {
        sweepIntervalMs: 999999,
        idleTimeoutMs:   999999,
        eventsPerSecond: 2, // 1 token per 500ms
      });
      mgr.start();

      // Drain the bucket
      mgr.checkRateLimit('s1');
      mgr.checkRateLimit('s1');
      expect(mgr.checkRateLimit('s1')).toBe(false);

      // Wait 600ms — should have received ~1 new token
      jest.advanceTimersByTime(600);

      expect(mgr.checkRateLimit('s1')).toBe(true);

      mgr.destroy();
    });

    it('initialises state for unknown sockets and allows first event', () => {
      const mock    = makeMockIO();
      const monitor = makeMonitor(mock.io);
      const mgr     = new ClientEvictionManager(mock.io, monitor, {
        sweepIntervalMs: 999999,
        idleTimeoutMs:   999999,
        eventsPerSecond: 10,
      });
      mgr.start();

      // 'new-socket' has no state yet
      expect(mgr.checkRateLimit('new-socket')).toBe(true);

      mgr.destroy();
    });
  });

  // ── 7. Lifecycle: onConnect / onDisconnect ────────────────────────────────

  describe('lifecycle hooks', () => {
    it('onConnect creates state and onDisconnect removes it', () => {
      const mock    = makeMockIO();
      const monitor = makeMonitor(mock.io);
      const mgr     = new ClientEvictionManager(mock.io, monitor, {
        sweepIntervalMs: 999999,
        idleTimeoutMs:   999999,
        eventsPerSecond: 10,
      });
      mgr.start();

      const socket = makeMockSocket('s1', 'user1');
      mock.simulateConnect(socket);

      // After connect, state exists — rate limiting should work
      expect(mgr.checkRateLimit('s1')).toBe(true);

      mgr.onDisconnect('s1');
      // After disconnect, state is cleared
      // A new call to checkRateLimit will re-create state (bucket starts full)
      expect(mgr.checkRateLimit('s1')).toBe(true);

      mgr.destroy();
    });
  });

  // ── 8. Sweep cleans up stale state ──────────────────────────────────────

  it('sweep removes state for sockets that self-disconnected', () => {
    const mock    = makeMockIO();
    const monitor = makeMonitor(mock.io);
    const mgr     = new ClientEvictionManager(mock.io, monitor, {
      sweepIntervalMs: 100,
      slowSustainMs:   999999,
      idleTimeoutMs:   999999,
      eventsPerSecond: 10,
    });
    mgr.start();

    const socket = makeMockSocket('s1', 'user1');
    mock.simulateConnect(socket);

    // Self-disconnect (client closes connection)
    mock.sockets.delete('s1');

    // Sweep should remove the orphaned state entry
    jest.advanceTimersByTime(200);

    // No crash, and rate limiting re-creates fresh state on next access
    expect(mgr.checkRateLimit('s1')).toBe(true);

    mgr.destroy();
  });

  // ── 9. recentEvictions() ─────────────────────────────────────────────────

  it('records evictions and returns most-recent first', () => {
    const mock    = makeMockIO();
    const monitor = makeMonitor(mock.io);
    const mgr     = new ClientEvictionManager(mock.io, monitor, {
      sweepIntervalMs: 999999,
      idleTimeoutMs:   999999,
      eventsPerSecond: 10,
    });
    mgr.start();

    const s1 = makeMockSocket('s1', 'u1');
    const s2 = makeMockSocket('s2', 'u2');
    mock.sockets.set('s1', s1 as unknown as MockSocket);
    mock.sockets.set('s2', s2 as unknown as MockSocket);

    mgr.evictSocket('s1', 'slow_client');
    jest.advanceTimersByTime(10);
    mgr.evictSocket('s2', 'idle_client');

    const history = mgr.recentEvictions(10);
    expect(history).toHaveLength(2);
    // Most-recent first
    expect(history[0].socketId).toBe('s2');
    expect(history[0].reason).toBe('idle_client');
    expect(history[1].socketId).toBe('s1');
    expect(history[1].reason).toBe('slow_client');

    mgr.destroy();
  });

  // ── 10. destroy() ────────────────────────────────────────────────────────

  it('destroy() stops the sweep timer (no more evictions)', () => {
    const mock    = makeMockIO();
    const buffers = new Map<string, number>();
    const monitor = makeMonitor(mock.io, buffers);
    const mgr     = new ClientEvictionManager(mock.io, monitor, {
      sweepIntervalMs: 100,
      slowSustainMs:   200,
      idleTimeoutMs:   999999,
      eventsPerSecond: 10,
    });
    mgr.start();

    const socket = makeMockSocket('s1', 'user1');
    mock.simulateConnect(socket);
    buffers.set('s1', 99999);

    // One sweep — slowSince set
    jest.advanceTimersByTime(100);
    expect(socket.disconnect).not.toHaveBeenCalled();

    // Destroy stops the timer
    mgr.destroy();

    // Advance well past sustainMs — no more sweeps
    jest.advanceTimersByTime(500);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});
