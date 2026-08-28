/**
 * Unit tests for BackpressureMonitor
 *
 * Tests cover:
 *   • Client-level threshold detection
 *   • Room-level threshold detection
 *   • Global threshold detection
 *   • Mock injection API
 *   • Multi-socket room aggregation
 *   • Edge cases (empty rooms, unknown sockets)
 */

import { BackpressureMonitor } from './BackpressureMonitor';
import { Server as SocketIOServer } from 'socket.io';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockIO(socketMap: Map<string, unknown> = new Map()): SocketIOServer {
  const rooms = new Map<string, Set<string>>();

  // Build room membership from socket map
  for (const [socketId] of socketMap) {
    // Each socket is in its own "room" (Socket.IO default) — we'll add named
    // rooms explicitly via the helper below.
  }

  const io = {
    sockets: {
      sockets: socketMap,
      adapter: {
        rooms,
      },
    },
  } as unknown as SocketIOServer;

  return io;
}

function addToRoom(
  io: SocketIOServer,
  room: string,
  ...socketIds: string[]
): void {
  const rooms = (io as unknown as { sockets: { adapter: { rooms: Map<string, Set<string>> } } })
    .sockets.adapter.rooms;

  if (!rooms.has(room)) {
    rooms.set(room, new Set<string>());
  }
  for (const id of socketIds) {
    rooms.get(room)!.add(id);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('BackpressureMonitor', () => {
  const DEFAULT_THRESHOLDS = {
    clientBytes: 1000,
    roomBytes:   5000,
    globalBytes: 20000,
  };

  // ── Client-level threshold detection ────────────────────────────────────────

  describe('isClientBackpressured()', () => {
    it('returns false when client buffer is below threshold', () => {
      const io = makeMockIO(new Map([['s1', {}]]));
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map([['s1', 900]]));

      expect(monitor.isClientBackpressured('s1')).toBe(false);
    });

    it('returns true when client buffer equals threshold', () => {
      const io = makeMockIO(new Map([['s1', {}]]));
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map([['s1', 1000]]));

      expect(monitor.isClientBackpressured('s1')).toBe(true);
    });

    it('returns true when client buffer exceeds threshold', () => {
      const io = makeMockIO(new Map([['s1', {}]]));
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map([['s1', 2048]]));

      expect(monitor.isClientBackpressured('s1')).toBe(true);
    });

    it('returns false for unknown socket id', () => {
      const io = makeMockIO();
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map());

      expect(monitor.isClientBackpressured('unknown-id')).toBe(false);
    });

    it('returns false when mock buffers are cleared', () => {
      const io = makeMockIO(new Map([['s1', {}]]));
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map([['s1', 5000]]));
      expect(monitor.isClientBackpressured('s1')).toBe(true);

      monitor.injectMockBuffers(undefined);
      // After clearing, real socket buffer is read — the mock socket has no conn
      // so getClientBufferBytes returns 0.
      expect(monitor.isClientBackpressured('s1')).toBe(false);
    });
  });

  // ── Room-level threshold detection ──────────────────────────────────────────

  describe('isRoomBackpressured()', () => {
    it('returns false when room total buffer is below threshold', () => {
      const io = makeMockIO(new Map([['s1', {}], ['s2', {}]]));
      addToRoom(io, 'campaign:1', 's1', 's2');
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map([['s1', 1000], ['s2', 500]]));

      // total = 1500 < 5000 threshold
      expect(monitor.isRoomBackpressured('campaign:1')).toBe(false);
    });

    it('returns true when room total buffer meets threshold', () => {
      const io = makeMockIO(new Map([['s1', {}], ['s2', {}], ['s3', {}]]));
      addToRoom(io, 'campaign:1', 's1', 's2', 's3');
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map([['s1', 2000], ['s2', 2000], ['s3', 1000]]));

      // total = 5000 >= threshold
      expect(monitor.isRoomBackpressured('campaign:1')).toBe(true);
    });

    it('returns true when room total buffer exceeds threshold', () => {
      const io = makeMockIO(new Map([['s1', {}]]));
      addToRoom(io, 'campaign:1', 's1');
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map([['s1', 8000]]));

      expect(monitor.isRoomBackpressured('campaign:1')).toBe(true);
    });

    it('returns false for an empty room', () => {
      const io = makeMockIO();
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map());

      expect(monitor.isRoomBackpressured('campaign:nonexistent')).toBe(false);
    });

    it('aggregates buffers correctly across many sockets', () => {
      const sockets = new Map<string, unknown>();
      const buffers = new Map<string, number>();
      const room    = 'campaign:big';

      // 10 sockets each with 400 bytes = 4000 total (< 5000 threshold)
      for (let i = 0; i < 10; i++) {
        const id = `socket-${i}`;
        sockets.set(id, {});
        buffers.set(id, 400);
      }

      const io = makeMockIO(sockets);
      addToRoom(io, room, ...sockets.keys());
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(buffers);

      expect(monitor.isRoomBackpressured(room)).toBe(false);

      // Now one socket goes over — total becomes 4600 (still under)
      buffers.set('socket-0', 1000);
      expect(monitor.isRoomBackpressured(room)).toBe(false);

      // Push total over 5000
      buffers.set('socket-1', 1000);
      // total = 1000 + 1000 + 8 * 400 = 5200 > 5000
      expect(monitor.isRoomBackpressured(room)).toBe(true);
    });
  });

  // ── Global threshold detection ───────────────────────────────────────────────

  describe('isGlobalBackpressured()', () => {
    it('returns false when global total is below threshold', () => {
      const io = makeMockIO(new Map([['s1', {}], ['s2', {}]]));
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map([['s1', 5000], ['s2', 5000]]));

      // total = 10000 < 20000 global threshold
      expect(monitor.isGlobalBackpressured()).toBe(false);
    });

    it('returns true when global total meets threshold', () => {
      const io = makeMockIO(new Map([['s1', {}], ['s2', {}]]));
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map([['s1', 10000], ['s2', 10000]]));

      // total = 20000 >= 20000 global threshold
      expect(monitor.isGlobalBackpressured()).toBe(true);
    });

    it('returns false when no sockets are connected', () => {
      const io = makeMockIO();
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map());

      expect(monitor.isGlobalBackpressured()).toBe(false);
    });
  });

  // ── Stats helpers ────────────────────────────────────────────────────────────

  describe('getClientStats()', () => {
    it('returns correct stats for a backpressured client', () => {
      const io = makeMockIO(new Map([['s1', {}]]));
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map([['s1', 1500]]));

      const stats = monitor.getClientStats('s1');
      expect(stats.socketId).toBe('s1');
      expect(stats.bufferBytes).toBe(1500);
      expect(stats.backpressured).toBe(true);
    });

    it('returns zero bytes for unknown socket', () => {
      const io = makeMockIO();
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map());

      const stats = monitor.getClientStats('unknown');
      expect(stats.bufferBytes).toBe(0);
      expect(stats.backpressured).toBe(false);
    });
  });

  describe('getRoomBufferStats()', () => {
    it('returns correct socket count and total bytes', () => {
      const io = makeMockIO(new Map([['s1', {}], ['s2', {}], ['s3', {}]]));
      addToRoom(io, 'org:1', 's1', 's2', 's3');
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map([['s1', 100], ['s2', 200], ['s3', 300]]));

      const stats = monitor.getRoomBufferStats('org:1');
      expect(stats.socketCount).toBe(3);
      expect(stats.totalBytes).toBe(600);
      expect(stats.backpressured).toBe(false);
    });
  });

  describe('getGlobalBufferStats()', () => {
    it('sums all socket buffers and reports socket count', () => {
      const io = makeMockIO(new Map([['s1', {}], ['s2', {}]]));
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      monitor.injectMockBuffers(new Map([['s1', 3000], ['s2', 7000]]));

      const stats = monitor.getGlobalBufferStats();
      expect(stats.socketCount).toBe(2);
      expect(stats.totalBytes).toBe(10000);
      expect(stats.backpressured).toBe(false);
    });
  });

  // ── Threshold exposure ────────────────────────────────────────────────────────

  describe('getThresholds()', () => {
    it('returns a copy of the configured thresholds', () => {
      const io = makeMockIO();
      const monitor = new BackpressureMonitor(io, DEFAULT_THRESHOLDS);
      const t = monitor.getThresholds();
      expect(t).toEqual(DEFAULT_THRESHOLDS);
      // Ensure it is a copy (mutations don't affect the monitor)
      (t as { clientBytes: number }).clientBytes = 0;
      expect(monitor.getThresholds().clientBytes).toBe(1000);
    });
  });
});
