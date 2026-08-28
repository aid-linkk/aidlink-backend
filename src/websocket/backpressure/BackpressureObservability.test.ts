/**
 * Unit tests for BackpressureObservability
 *
 * Tests cover:
 *   1. captureSnapshot() — correct structure, global stats, room stats, flow stats
 *   2. captureSnapshot() — skips per-socket rooms (personal rooms)
 *   3. captureSnapshot() — counts recent evictions correctly
 *   4. Rolling snapshot window — getSnapshots() length and ordering
 *   5. Rolling snapshot window — oldest entry evicted when window is full
 *   6. Periodic report — snapshot is stored on each report() call
 *   7. Periodic report — logs at INFO level when not backpressured
 *   8. Periodic report — logs at WARN level when globally backpressured
 *   9. Periodic report — logs individual backpressured rooms at WARN
 *  10. start() is idempotent (calling twice doesn't double-register timer)
 *  11. destroy() stops the periodic report timer
 */

import { BackpressureObservability, BackpressureSnapshot } from './BackpressureObservability';
import { BackpressureMonitor } from './BackpressureMonitor';
import { FlowController, EmitFn } from './FlowController';
import { ClientEvictionManager } from './ClientEvictionManager';
import { Server as SocketIOServer } from 'socket.io';
import logger from '../../config/logger';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

interface MockSocketEntry {
  id: string;
  data: { userId?: string };
  disconnect: jest.Mock;
}

function makeMockSocket(id: string, userId?: string): MockSocketEntry {
  return { id, data: { userId }, disconnect: jest.fn() };
}

/**
 * Build a minimal SocketIOServer stub with controllable rooms + sockets.
 * `personalSockets` — socket IDs whose IDs match a personal room
 *   (Socket.IO default: each socket lives in a room with its own ID).
 */
function makeMockIO(
  sockets: MockSocketEntry[],
  rooms: Map<string, string[]> = new Map(),
  personalSockets: string[] = [],
): SocketIOServer {
  const socketMap = new Map<string, MockSocketEntry>();
  for (const s of sockets) socketMap.set(s.id, s);

  // Rooms map: named rooms + personal rooms (socket-id rooms)
  const roomMap = new Map<string, Set<string>>();
  for (const [name, ids] of rooms) roomMap.set(name, new Set(ids));
  for (const pid of personalSockets) roomMap.set(pid, new Set([pid]));

  return {
    sockets: {
      sockets: socketMap,
      adapter: { rooms: roomMap },
    },
  } as unknown as SocketIOServer;
}

function makeMonitor(
  io: SocketIOServer,
  buffers: Map<string, number> = new Map(),
  thresholds = { clientBytes: 1000, roomBytes: 5000, globalBytes: 20000 },
): BackpressureMonitor {
  const m = new BackpressureMonitor(io, thresholds);
  m.injectMockBuffers(buffers);
  return m;
}

const noopEmitFn: EmitFn = () => {};

function makeFlowController(monitor: BackpressureMonitor): FlowController {
  return new FlowController(monitor, noopEmitFn, {
    drainIntervalMs:  999999,
    coalesceWindowMs: 999999,
  });
}

function makeEvictionManager(
  io: SocketIOServer,
  monitor: BackpressureMonitor,
): ClientEvictionManager {
  return new ClientEvictionManager(io, monitor, {
    sweepIntervalMs: 999999,
    idleTimeoutMs:   999999,
    eventsPerSecond: 100,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('BackpressureObservability', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => jest.useRealTimers());

  // ── 1. captureSnapshot() — basic structure ─────────────────────────────────

  describe('captureSnapshot()', () => {
    it('returns a snapshot with the expected top-level fields', () => {
      const io      = makeMockIO([]);
      const monitor = makeMonitor(io);
      const flow    = makeFlowController(monitor);
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction, {
        reportIntervalMs: 99999,
        snapshotWindow:   5,
      });

      const snap = obs.captureSnapshot();

      expect(snap).toHaveProperty('timestamp');
      expect(snap).toHaveProperty('global');
      expect(snap).toHaveProperty('rooms');
      expect(snap).toHaveProperty('flowController');
      expect(snap).toHaveProperty('recentEvictions');
      expect(typeof snap.timestamp).toBe('number');
      expect(Array.isArray(snap.rooms)).toBe(true);

      flow.destroy();
    });

    it('includes correct global stats when sockets have buffers', () => {
      const s1 = makeMockSocket('s1');
      const s2 = makeMockSocket('s2');
      const io = makeMockIO([s1, s2], new Map(), ['s1', 's2']);
      const buffers = new Map([['s1', 3000], ['s2', 4000]]);
      const monitor = makeMonitor(io, buffers, { clientBytes: 1000, roomBytes: 5000, globalBytes: 5000 });
      const flow    = makeFlowController(monitor);
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction);

      const snap = obs.captureSnapshot();

      expect(snap.global.socketCount).toBe(2);
      expect(snap.global.totalBufferBytes).toBe(7000);
      // 7000 >= 5000 threshold → backpressured
      expect(snap.global.backpressured).toBe(true);

      flow.destroy();
    });

    it('reports global.backpressured = false when buffers are low', () => {
      const s1 = makeMockSocket('s1');
      const io = makeMockIO([s1], new Map(), ['s1']);
      const monitor = makeMonitor(io, new Map([['s1', 100]]));
      const flow    = makeFlowController(monitor);
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction);

      const snap = obs.captureSnapshot();

      expect(snap.global.backpressured).toBe(false);

      flow.destroy();
    });

    it('excludes per-socket personal rooms from the rooms array', () => {
      const s1 = makeMockSocket('s1');
      const io = makeMockIO(
        [s1],
        new Map([['campaign:42', ['s1']]]),
        ['s1'], // s1's personal room — should be excluded
      );
      const monitor  = makeMonitor(io);
      const flow     = makeFlowController(monitor);
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction);

      const snap = obs.captureSnapshot();

      const roomNames = snap.rooms.map((r) => r.room);
      expect(roomNames).toContain('campaign:42');
      expect(roomNames).not.toContain('s1'); // personal socket room excluded

      flow.destroy();
    });

    it('includes per-room totalBytes, socketCount, and backpressured', () => {
      const s1 = makeMockSocket('s1');
      const s2 = makeMockSocket('s2');
      const io = makeMockIO(
        [s1, s2],
        new Map([['campaign:99', ['s1', 's2']]]),
      );
      const buffers = new Map([['s1', 2500], ['s2', 3000]]);
      // room threshold = 5000 → 5500 > 5000 → backpressured
      const monitor  = makeMonitor(io, buffers, { clientBytes: 1000, roomBytes: 5000, globalBytes: 100000 });
      const flow     = makeFlowController(monitor);
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction);

      const snap = obs.captureSnapshot();
      const roomSnap = snap.rooms.find((r) => r.room === 'campaign:99');

      expect(roomSnap).toBeDefined();
      expect(roomSnap!.totalBytes).toBe(5500);
      expect(roomSnap!.socketCount).toBe(2);
      expect(roomSnap!.backpressured).toBe(true);

      flow.destroy();
    });

    it('reflects FlowController stats accurately', () => {
      const io      = makeMockIO([]);
      const monitor = makeMonitor(io);
      const emitted: unknown[] = [];
      const emitFn: EmitFn = (_, __, d) => emitted.push(d);
      const flow    = new FlowController(monitor, emitFn, { drainIntervalMs: 99999, coalesceWindowMs: 99999 });
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction);

      // Trigger some emits
      flow.emit('campaign:1', 'donation:created', {});
      flow.emit('campaign:2', 'donation:created', {});

      const snap = obs.captureSnapshot();

      expect(snap.flowController.totalEmitted).toBe(2);
      expect(snap.flowController.totalQueued).toBe(0);

      flow.destroy();
    });

    it('reports recentEvictions count from eviction manager', () => {
      const s1 = makeMockSocket('s1');
      const io = makeMockIO([s1]);
      (io.sockets.sockets as Map<string, unknown>).set('s1', s1 as unknown as MockSocketEntry);
      const monitor  = makeMonitor(io);
      const flow     = makeFlowController(monitor);
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction);

      eviction.evictSocket('s1', 'slow_client');

      const snap = obs.captureSnapshot();
      // recentEvictions counts last 10 entries from eviction history
      expect(snap.recentEvictions).toBe(1);

      flow.destroy();
    });

    it('timestamp is close to Date.now()', () => {
      const io      = makeMockIO([]);
      const monitor = makeMonitor(io);
      const flow    = makeFlowController(monitor);
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction);

      const before = Date.now();
      const snap   = obs.captureSnapshot();
      const after  = Date.now();

      expect(snap.timestamp).toBeGreaterThanOrEqual(before);
      expect(snap.timestamp).toBeLessThanOrEqual(after);

      flow.destroy();
    });
  });

  // ── 4. Rolling snapshot window ─────────────────────────────────────────────

  describe('getSnapshots() rolling window', () => {
    it('returns an empty array before any report has fired', () => {
      const io      = makeMockIO([]);
      const monitor = makeMonitor(io);
      const flow    = makeFlowController(monitor);
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction, {
        reportIntervalMs: 1000,
        snapshotWindow:   5,
      });

      expect(obs.getSnapshots()).toEqual([]);
      flow.destroy();
    });

    it('accumulates snapshots up to the window size', () => {
      const io      = makeMockIO([]);
      const monitor = makeMonitor(io);
      const flow    = makeFlowController(monitor);
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction, {
        reportIntervalMs: 100,
        snapshotWindow:   3,
      });
      obs.start();

      // Fire 3 reports
      jest.advanceTimersByTime(350);

      const snaps = obs.getSnapshots();
      expect(snaps.length).toBe(3);

      obs.destroy();
      flow.destroy();
    });

    it('evicts the oldest snapshot when window is exceeded', () => {
      const io      = makeMockIO([]);
      const monitor = makeMonitor(io);
      const flow    = makeFlowController(monitor);
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction, {
        reportIntervalMs: 100,
        snapshotWindow:   3,
      });
      obs.start();

      // Fire 5 reports — window = 3, so 2 oldest should be evicted
      jest.advanceTimersByTime(550);

      const snaps = obs.getSnapshots();
      expect(snaps.length).toBe(3);

      obs.destroy();
      flow.destroy();
    });

    it('getSnapshots() returns snapshots most-recent first', () => {
      const io      = makeMockIO([]);
      const monitor = makeMonitor(io);
      const flow    = makeFlowController(monitor);
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction, {
        reportIntervalMs: 100,
        snapshotWindow:   5,
      });
      obs.start();

      jest.advanceTimersByTime(350);

      const snaps = obs.getSnapshots();
      // Verify descending timestamp order
      for (let i = 1; i < snaps.length; i++) {
        expect(snaps[i - 1].timestamp).toBeGreaterThanOrEqual(snaps[i].timestamp);
      }

      obs.destroy();
      flow.destroy();
    });

    it('getSnapshots(n) honours explicit count parameter', () => {
      const io      = makeMockIO([]);
      const monitor = makeMonitor(io);
      const flow    = makeFlowController(monitor);
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction, {
        reportIntervalMs: 100,
        snapshotWindow:   10,
      });
      obs.start();

      jest.advanceTimersByTime(550); // 5 reports

      expect(obs.getSnapshots(2).length).toBe(2);
      expect(obs.getSnapshots(5).length).toBe(5);

      obs.destroy();
      flow.destroy();
    });
  });

  // ── 7 & 8. Logging level ──────────────────────────────────────────────────

  describe('periodic report logging', () => {
    it('logs at INFO level when global is NOT backpressured', () => {
      const io      = makeMockIO([]);
      const monitor = makeMonitor(io, new Map(), { clientBytes: 1000, roomBytes: 5000, globalBytes: 100000 });
      const flow    = makeFlowController(monitor);
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction, {
        reportIntervalMs: 100,
        snapshotWindow:   5,
      });
      obs.start();

      jest.advanceTimersByTime(150);

      expect(logger.info).toHaveBeenCalledWith(
        'ws:backpressure:snapshot',
        expect.objectContaining({ global: expect.any(Object) }),
      );
      expect(logger.warn).not.toHaveBeenCalledWith('ws:backpressure:snapshot', expect.anything());

      obs.destroy();
      flow.destroy();
    });

    it('logs at WARN level when global IS backpressured', () => {
      const s1 = makeMockSocket('s1');
      const io = makeMockIO([s1], new Map(), ['s1']);
      // globalBytes = 100 → 5000 bytes from s1 exceeds threshold
      const monitor  = makeMonitor(io, new Map([['s1', 5000]]), { clientBytes: 1000, roomBytes: 50000, globalBytes: 100 });
      const flow     = makeFlowController(monitor);
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction, {
        reportIntervalMs: 100,
        snapshotWindow:   5,
      });
      obs.start();

      jest.advanceTimersByTime(150);

      expect(logger.warn).toHaveBeenCalledWith(
        'ws:backpressure:snapshot',
        expect.objectContaining({ global: expect.objectContaining({ backpressured: true }) }),
      );

      obs.destroy();
      flow.destroy();
    });

    it('logs backpressured rooms individually at WARN', () => {
      const s1 = makeMockSocket('s1');
      const io = makeMockIO(
        [s1],
        new Map([['campaign:1', ['s1']]]),
      );
      // room threshold = 500 → s1 has 2000 bytes → backpressured room
      const monitor  = makeMonitor(io, new Map([['s1', 2000]]), { clientBytes: 1000, roomBytes: 500, globalBytes: 1000000 });
      const flow     = makeFlowController(monitor);
      const eviction = makeEvictionManager(io, monitor);
      const obs = new BackpressureObservability(io, monitor, flow, eviction, {
        reportIntervalMs: 100,
        snapshotWindow:   5,
      });
      obs.start();

      jest.advanceTimersByTime(150);

      expect(logger.warn).toHaveBeenCalledWith(
        'ws:backpressure:room',
        expect.objectContaining({ room: 'campaign:1' }),
      );

      obs.destroy();
      flow.destroy();
    });
  });

  // ── 10. start() idempotency ────────────────────────────────────────────────

  it('start() is idempotent — calling twice does not double-fire the interval', () => {
    const io      = makeMockIO([]);
    const monitor = makeMonitor(io);
    const flow    = makeFlowController(monitor);
    const eviction = makeEvictionManager(io, monitor);
    const obs = new BackpressureObservability(io, monitor, flow, eviction, {
      reportIntervalMs: 100,
      snapshotWindow:   10,
    });

    obs.start();
    obs.start(); // second call — should be no-op

    jest.advanceTimersByTime(350);

    // Only 3 reports should have fired (not 6 from double-registration)
    expect(obs.getSnapshots().length).toBe(3);

    obs.destroy();
    flow.destroy();
  });

  // ── 11. destroy() ─────────────────────────────────────────────────────────

  it('destroy() stops the periodic report timer', () => {
    const io      = makeMockIO([]);
    const monitor = makeMonitor(io);
    const flow    = makeFlowController(monitor);
    const eviction = makeEvictionManager(io, monitor);
    const obs = new BackpressureObservability(io, monitor, flow, eviction, {
      reportIntervalMs: 100,
      snapshotWindow:   10,
    });

    obs.start();
    jest.advanceTimersByTime(150); // 1 report fires
    obs.destroy();

    jest.advanceTimersByTime(500); // timer is stopped — no new snapshots

    expect(obs.getSnapshots().length).toBe(1);
    flow.destroy();
  });
});
