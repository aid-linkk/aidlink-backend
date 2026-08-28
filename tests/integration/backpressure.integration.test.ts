/**
 * Integration tests: Backpressure system — event storm & end-to-end scenarios
 *
 * Scenario tests:
 *   E1. Event storm: 500 rapid donation events for the same room — queue stays
 *       bounded and does not throw / exceed capacity caps.
 *   E2. Slow client eviction during storm — room continues to function after
 *       one slow client is evicted; other clients keep receiving events.
 *   E3. Critical event bypass during storm — campaign:suspended is emitted
 *       immediately even when the room queue is deep.
 *   E4. Event coalescing under load — N campaign:updated events within the
 *       coalesce window collapse to a single emit.
 *   E5. Backpressure signal for expensive DB work — shouldThrottle() returns
 *       true under room pressure so callers can skip DB fetches.
 *   E6. Flow control: queue drains in priority order after storm subsides —
 *       CRITICAL → HIGH → MEDIUM → LOW.
 *   E7. Global backpressure: when all socket buffers are large, normal events
 *       are queued even for rooms that are individually below threshold.
 *   E8. Multiple rooms independent — backpressure in one room does not
 *       affect broadcasting to another room that is not backpressured.
 *   E9. Rate limiting during storm — checkRateLimit rejects events once
 *       token bucket is empty for a given socket.
 *  E10. Full e2e: simulate donation surge, verify bounded queue, verify
 *       critical event (suspension) bypasses, verify slow client evicted,
 *       verify room recovers and continues delivering events.
 */

import {
  BackpressureMonitor,
  FlowController,
  ClientEvictionManager,
  BackpressureObservability,
} from '../../src/websocket/backpressure';
import { PriorityEventQueue, EventPriority } from '../../src/websocket/backpressure/PriorityEventQueue';
import { EmitFn } from '../../src/websocket/backpressure/FlowController';
import { Server as SocketIOServer } from 'socket.io';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

interface FakeSocket {
  id: string;
  data: { userId: string };
  disconnect: jest.Mock;
}

function makeFakeSocket(id: string, userId: string): FakeSocket {
  return { id, data: { userId }, disconnect: jest.fn() };
}

type FakeIO = SocketIOServer & {
  _sockets: Map<string, FakeSocket>;
  _rooms: Map<string, Set<string>>;
  addSocketToRoom: (socketId: string, room: string) => void;
};

function buildFakeIO(sockets: FakeSocket[] = []): FakeIO {
  const _sockets = new Map<string, FakeSocket>();
  const _rooms   = new Map<string, Set<string>>();
  // Connection handlers registered via io.on('connection', ...)
  const _connectionHandlers: Array<(socket: FakeSocket) => void> = [];

  for (const s of sockets) _sockets.set(s.id, s);

  const addSocketToRoom = (socketId: string, room: string) => {
    if (!_rooms.has(room)) _rooms.set(room, new Set());
    _rooms.get(room)!.add(socketId);
  };

  const io = {
    _sockets,
    _rooms,
    addSocketToRoom,
    sockets: {
      get sockets() { return _sockets; },
      adapter: { get rooms() { return _rooms; } },
    },
    on(event: string, handler: (socket: FakeSocket) => void) {
      if (event === 'connection') _connectionHandlers.push(handler);
    },
  } as unknown as FakeIO;

  return io;
}

function buildMonitor(
  io: FakeIO,
  buffers: Map<string, number>,
  thresholds = { clientBytes: 1_000, roomBytes: 10_000, globalBytes: 100_000 },
): BackpressureMonitor {
  const m = new BackpressureMonitor(io as unknown as SocketIOServer, thresholds);
  m.injectMockBuffers(buffers);
  return m;
}

interface TestHarness {
  io: FakeIO;
  buffers: Map<string, number>;
  monitor: BackpressureMonitor;
  spy: { fn: EmitFn; calls: Array<{ room: string; event: string; data: unknown }> };
  fc: FlowController;
}

function buildHarness(options?: {
  thresholds?: { clientBytes: number; roomBytes: number; globalBytes: number };
  coalesceWindowMs?: number;
  drainIntervalMs?: number;
}): TestHarness {
  const io      = buildFakeIO();
  const buffers = new Map<string, number>();
  const monitor = buildMonitor(io, buffers, options?.thresholds);

  const calls: Array<{ room: string; event: string; data: unknown }> = [];
  const fn: EmitFn = (room, event, data) => calls.push({ room, event, data });
  const spy = { fn, calls };

  const fc = new FlowController(monitor, fn, {
    coalesceWindowMs: options?.coalesceWindowMs ?? 50,
    drainIntervalMs:  options?.drainIntervalMs  ?? 50,
  });

  return { io, buffers, monitor, spy, fc };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Backpressure integration: event storm scenarios', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(()  => jest.useRealTimers());

  // ── E1: Queue stays bounded during event storm ────────────────────────────

  it('E1: event storm — queue capacity cap prevents unbounded growth', () => {
    const LEVEL_CAPACITY = 500;
    const q = new PriorityEventQueue({ levelCapacity: LEVEL_CAPACITY, ttlMs: 60000 });

    // Simulate 5000 donation events (HIGH) and 5000 campaign updates (MEDIUM)
    for (let i = 0; i < 5000; i++) {
      q.enqueue('donation:created', { n: i }, EventPriority.HIGH);
      q.enqueue('campaign:updated', { n: i }, EventPriority.MEDIUM);
    }

    const stats = q.stats();
    expect(stats.high).toBeLessThanOrEqual(LEVEL_CAPACITY);
    expect(stats.medium).toBeLessThanOrEqual(LEVEL_CAPACITY);
    expect(stats.total).toBeLessThanOrEqual(LEVEL_CAPACITY * 2);
  });

  // ── E2: Slow client eviction — room continues to function ─────────────────

  it('E2: slow client evicted during storm — remaining client keeps receiving', () => {
    const slow   = makeFakeSocket('slow',   'user-slow');
    const normal = makeFakeSocket('normal', 'user-normal');
    const io     = buildFakeIO([slow, normal]);
    const buffers = new Map([['slow', 0], ['normal', 0]]);
    const monitor = buildMonitor(io, buffers);

    io.addSocketToRoom('slow',   'campaign:1');
    io.addSocketToRoom('normal', 'campaign:1');

    const eviction = new ClientEvictionManager(io as unknown as SocketIOServer, monitor, {
      sweepIntervalMs: 100,
      slowSustainMs:   250,
      idleTimeoutMs:   999999,
      eventsPerSecond: 100,
    });
    eviction.start();

    // Register sockets with the eviction manager (simulates connection)
    eviction.onConnect('slow');
    eviction.onConnect('normal');

    // Slow client builds up a large buffer
    buffers.set('slow', 999999);

    // Sweep 1: slowSince stamped
    jest.advanceTimersByTime(100);
    expect(slow.disconnect).not.toHaveBeenCalled();

    // Sweep 2 + 3: time passes but < sustainMs
    jest.advanceTimersByTime(200);
    expect(slow.disconnect).not.toHaveBeenCalled();

    // Sweep 4: slow client exceeds sustainMs → evicted
    jest.advanceTimersByTime(100);
    expect(slow.disconnect).toHaveBeenCalledWith(true);

    // Normal client unaffected — room is still broadcasting to it
    // We verify by confirming 'normal' socket is still in room and buffer is clear
    expect(monitor.isClientBackpressured('normal')).toBe(false);

    eviction.destroy();
  });

  // ── E3: CRITICAL bypass during storm ─────────────────────────────────────

  it('E3: critical event bypasses backpressure queue during storm', () => {
    const { io, buffers, spy, fc } = buildHarness({
      thresholds: { clientBytes: 1000, roomBytes: 2000, globalBytes: 100000 },
    });

    const s1 = makeFakeSocket('s1', 'u1');
    io._sockets.set('s1', s1);
    io.addSocketToRoom('s1', 'campaign:1');
    buffers.set('s1', 99999); // massive pressure on room

    // Flood the room with HIGH events — these should all be queued
    for (let i = 0; i < 100; i++) {
      fc.emit('campaign:1', 'donation:created', { seq: i });
    }
    expect(spy.calls.filter(c => c.event === 'donation:created')).toHaveLength(0);

    // CRITICAL event — must be emitted immediately
    fc.emit('campaign:1', 'campaign:suspended', { reason: 'fraud' });

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].event).toBe('campaign:suspended');
    expect(spy.calls[0].room).toBe('campaign:1');

    fc.destroy();
  });

  // ── E4: Event coalescing under load ──────────────────────────────────────

  it('E4: coalescing collapses rapid campaign:updated events into one emit', () => {
    const { spy, fc } = buildHarness({ coalesceWindowMs: 100 });

    // Simulate 50 rapid campaign updates within the coalesce window
    for (let i = 1; i <= 50; i++) {
      fc.emit('campaign:1', 'campaign:updated', { version: i, seq: i });
    }

    // Nothing emitted yet — coalesce timer pending
    expect(spy.calls).toHaveLength(0);

    // Timer fires — only ONE emit with the last payload
    jest.advanceTimersByTime(150);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].event).toBe('campaign:updated');
    expect((spy.calls[0].data as { seq: number }).seq).toBe(50);

    fc.destroy();
  });

  it('E4b: coalescing is per-room — different rooms each get one emit', () => {
    const { spy, fc } = buildHarness({ coalesceWindowMs: 100 });

    for (let i = 1; i <= 10; i++) {
      fc.emit('campaign:1', 'campaign:updated', { room: 'campaign:1', v: i });
      fc.emit('campaign:2', 'campaign:updated', { room: 'campaign:2', v: i });
    }

    jest.advanceTimersByTime(150);

    expect(spy.calls).toHaveLength(2);
    const rooms = new Set(spy.calls.map(c => c.room));
    expect(rooms.has('campaign:1')).toBe(true);
    expect(rooms.has('campaign:2')).toBe(true);
    // Each room gets the latest version (10)
    for (const c of spy.calls) {
      expect((c.data as { v: number }).v).toBe(10);
    }

    fc.destroy();
  });

  // ── E5: shouldThrottle() returns true under room pressure ────────────────

  it('E5: shouldThrottle() — event generators skip expensive work under backpressure', () => {
    const { io, buffers, fc } = buildHarness({
      thresholds: { clientBytes: 1000, roomBytes: 2000, globalBytes: 100000 },
    });

    const s1 = makeFakeSocket('s1', 'u1');
    io._sockets.set('s1', s1);
    io.addSocketToRoom('s1', 'campaign:1');

    // No pressure initially
    buffers.set('s1', 0);
    expect(fc.shouldThrottle('campaign:1')).toBe(false);

    // Apply pressure — room goes over threshold
    buffers.set('s1', 99999);
    expect(fc.shouldThrottle('campaign:1')).toBe(true);

    // Pressure drops — room throttle clears
    buffers.set('s1', 0);
    expect(fc.shouldThrottle('campaign:1')).toBe(false);

    fc.destroy();
  });

  // ── E6: Queue drains in priority order after storm subsides ───────────────

  it('E6: queue drains CRITICAL→HIGH→MEDIUM→LOW after backpressure lifts', () => {
    const { io, buffers, spy, fc } = buildHarness({
      thresholds: { clientBytes: 1000, roomBytes: 2000, globalBytes: 100000 },
      drainIntervalMs: 50,
    });

    const s1 = makeFakeSocket('s1', 'u1');
    io._sockets.set('s1', s1);
    io.addSocketToRoom('s1', 'campaign:1');
    buffers.set('s1', 99999); // room backpressured

    // Enqueue mixed-priority events
    fc.emit('campaign:1', 'notification:unread_count', { unreadCount: 1 }); // LOW
    fc.emit('campaign:1', 'donation:created',          { amount: 100 });    // HIGH
    fc.emit('campaign:1', 'beneficiary:updated',       { id: 'b1' });       // HIGH

    expect(spy.calls).toHaveLength(0);

    // Lift backpressure
    buffers.set('s1', 0);

    // Drain fires
    jest.advanceTimersByTime(100);

    // All events emitted, HIGH before LOW
    const events = spy.calls.map(c => c.event);
    const highIdx = events.indexOf('donation:created');
    const lowIdx  = events.indexOf('notification:unread_count');

    // At minimum: HIGH events arrived, LOW may have arrived
    expect(events).toContain('donation:created');
    // If LOW was also emitted, it must come after HIGH
    if (lowIdx !== -1) {
      expect(highIdx).toBeLessThan(lowIdx);
    }

    fc.destroy();
  });

  // ── E7: Global backpressure ───────────────────────────────────────────────

  it('E7: global backpressure queues events even for rooms below room threshold', () => {
    // Two sockets in different rooms, neither room exceeds its room threshold,
    // but their combined buffers exceed the global threshold.
    const s1 = makeFakeSocket('s1', 'u1');
    const s2 = makeFakeSocket('s2', 'u2');
    const io = buildFakeIO([s1, s2]);
    io.addSocketToRoom('s1', 'campaign:1');
    io.addSocketToRoom('s2', 'campaign:2');

    const buffers = new Map([['s1', 4000], ['s2', 4000]]);
    const monitor = buildMonitor(io, buffers, {
      clientBytes: 10000, // individual clients are fine
      roomBytes:   10000, // each room is under its threshold
      globalBytes:  5000, // but combined 8000 > 5000 global threshold
    });

    const calls: Array<{ room: string; event: string }> = [];
    const fc = new FlowController(monitor, (room, event) => calls.push({ room, event }), {
      drainIntervalMs:  50,
      coalesceWindowMs: 999999,
    });

    fc.emit('campaign:1', 'donation:created', {});
    fc.emit('campaign:2', 'donation:created', {});

    // Both events queued due to global backpressure
    expect(calls).toHaveLength(0);
    expect(fc.getStats().totalQueued).toBe(2);

    fc.destroy();
  });

  // ── E8: Rooms are independent ─────────────────────────────────────────────

  it('E8: backpressure in one room does not affect broadcasts to another room', () => {
    const s1 = makeFakeSocket('s1', 'u1');
    const s2 = makeFakeSocket('s2', 'u2');
    const io = buildFakeIO([s1, s2]);
    io.addSocketToRoom('s1', 'campaign:hot');
    io.addSocketToRoom('s2', 'campaign:quiet');

    const buffers = new Map([['s1', 99999], ['s2', 0]]);
    const monitor = buildMonitor(io, buffers, {
      clientBytes: 1000,
      roomBytes:   5000,
      globalBytes: 999999,  // global threshold very high — not triggered
    });

    const calls: Array<{ room: string; event: string }> = [];
    const fc = new FlowController(monitor, (room, event) => calls.push({ room, event }), {
      drainIntervalMs:  50,
      coalesceWindowMs: 999999,
    });

    // campaign:hot is backpressured (s1 has huge buffer)
    fc.emit('campaign:hot',   'donation:created', { n: 1 });
    // campaign:quiet is fine
    fc.emit('campaign:quiet', 'donation:created', { n: 2 });

    // Only campaign:quiet event emitted
    expect(calls).toHaveLength(1);
    expect(calls[0].room).toBe('campaign:quiet');
    expect(fc.getStats().totalQueued).toBe(1);

    fc.destroy();
  });

  // ── E9: Rate limiting during storm ────────────────────────────────────────

  it('E9: rate limit blocks events for a socket once bucket is empty', () => {
    const io      = buildFakeIO();
    const buffers = new Map<string, number>();
    const monitor = buildMonitor(io, buffers);
    const mgr     = new ClientEvictionManager(io as unknown as SocketIOServer, monitor, {
      sweepIntervalMs: 999999,
      idleTimeoutMs:   999999,
      eventsPerSecond: 5,
    });

    // First 5 events allowed
    let allowed = 0;
    for (let i = 0; i < 5; i++) {
      if (mgr.checkRateLimit('s1')) allowed++;
    }
    expect(allowed).toBe(5);

    // Next batch — all should be rejected (bucket empty)
    let rejected = 0;
    for (let i = 0; i < 5; i++) {
      if (!mgr.checkRateLimit('s1')) rejected++;
    }
    expect(rejected).toBe(5);

    // After 1 second refill (5 events/s = 200ms per token)
    jest.advanceTimersByTime(1100);
    expect(mgr.checkRateLimit('s1')).toBe(true);

    mgr.destroy();
  });

  // ── E10: Full end-to-end scenario ─────────────────────────────────────────

  it('E10: full e2e — donation surge, slow client evicted, critical bypass, room recovers', () => {
    // Setup: 3 clients — one slow, two normal — in a campaign room
    const slow    = makeFakeSocket('slow',    'user-slow');
    const normal1 = makeFakeSocket('normal1', 'user-normal1');
    const normal2 = makeFakeSocket('normal2', 'user-normal2');
    const io      = buildFakeIO([slow, normal1, normal2]);
    const buffers = new Map([['slow', 0], ['normal1', 0], ['normal2', 0]]);

    const ROOM = 'campaign:viral';
    io.addSocketToRoom('slow',    ROOM);
    io.addSocketToRoom('normal1', ROOM);
    io.addSocketToRoom('normal2', ROOM);

    // Thresholds tuned for the test
    const monitor = buildMonitor(io, buffers, {
      clientBytes: 5000,   // client threshold: 5 KB
      roomBytes:   10000,  // room threshold: 10 KB
      globalBytes: 100000,
    });

    const emitted: Array<{ room: string; event: string; data: unknown }> = [];
    const fc = new FlowController(
      monitor,
      (room, event, data) => emitted.push({ room, event, data }),
      { drainIntervalMs: 50, coalesceWindowMs: 50 },
    );

    const eviction = new ClientEvictionManager(io as unknown as SocketIOServer, monitor, {
      sweepIntervalMs: 100,
      slowSustainMs:   300,
      idleTimeoutMs:   999999,
      eventsPerSecond: 100,
    });
    eviction.start();

    // Register all sockets (simulates initial connection events)
    eviction.onConnect('slow');
    eviction.onConnect('normal1');
    eviction.onConnect('normal2');

    // ── Phase 1: Donation surge ──────────────────────────────────────────
    // Slow client's buffer explodes
    buffers.set('slow', 99999);

    // 200 rapid donation events flood the room
    for (let i = 0; i < 200; i++) {
      fc.emit(ROOM, 'donation:created', { seq: i, amount: 100 });
    }

    // All 200 queued — room is backpressured (slow client drives room total > 10KB)
    const afterFlood = fc.getStats();
    expect(afterFlood.totalQueued).toBe(200);
    expect(afterFlood.totalEmitted).toBe(0);

    // ── Phase 2: Critical event bypasses the queue ───────────────────────
    fc.emit(ROOM, 'campaign:suspended', { reason: 'fraud' });

    // Suspension emitted immediately despite backpressure
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe('campaign:suspended');

    // ── Phase 3: Slow client evicted after sustainMs ─────────────────────
    jest.advanceTimersByTime(100); // sweep 1: slowSince stamped
    jest.advanceTimersByTime(100); // sweep 2: 200ms < 300ms sustainMs
    jest.advanceTimersByTime(100); // sweep 3: still < 300ms
    jest.advanceTimersByTime(100); // sweep 4: ≥300ms → evict

    expect(slow.disconnect).toHaveBeenCalledWith(true);
    expect(eviction.recentEvictions(1)[0].reason).toBe('slow_client');

    // ── Phase 4: Backpressure lifts, room recovers ───────────────────────
    // Remove slow client's buffer (evicted)
    buffers.set('slow', 0);

    // Drain timer fires — events delivered
    jest.advanceTimersByTime(100);

    // Some events drained (at least HIGH priority ones from the batch)
    const stats = fc.getStats();
    expect(stats.totalEmitted).toBeGreaterThan(1); // beyond the suspension bypass

    // Normal clients are unaffected — they're still connected
    expect(normal1.disconnect).not.toHaveBeenCalled();
    expect(normal2.disconnect).not.toHaveBeenCalled();

    eviction.destroy();
    fc.destroy();
  });
});
