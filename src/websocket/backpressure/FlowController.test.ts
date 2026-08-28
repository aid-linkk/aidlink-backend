/**
 * Integration tests for FlowController
 *
 * Tests cover:
 *   1. CRITICAL events bypass backpressure and emit immediately
 *   2. Normal events emit immediately when no backpressure
 *   3. Events are queued (not emitted) when the room is backpressured
 *   4. Events are drained and emitted once backpressure lifts
 *   5. Event coalescing: multiple same-type events → single emit with latest payload
 *   6. Coalesced event is queued (not emitted) when backpressure is active
 *   7. shouldThrottle() reflects current backpressure state
 *   8. LOW events are dropped after sustained backpressure (drainRoom sees pressure)
 *   9. getStats() counters increment correctly
 *  10. destroy() clears all timers (no open handles)
 */

import { FlowController, EmitFn } from './FlowController';
import { BackpressureMonitor }    from './BackpressureMonitor';
import { EventPriority }          from './PriorityEventQueue';
import { Server as SocketIOServer } from 'socket.io';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockIO(): SocketIOServer {
  return {
    sockets: {
      sockets: new Map(),
      adapter: { rooms: new Map() },
    },
  } as unknown as SocketIOServer;
}

interface EmitCall {
  room:  string;
  event: string;
  data:  unknown;
}

function makeEmitSpy(): { fn: EmitFn; calls: EmitCall[] } {
  const calls: EmitCall[] = [];
  const fn: EmitFn = (room, event, data) => calls.push({ room, event, data });
  return { fn, calls };
}

function makeMonitor(
  io: SocketIOServer,
  mockBuffers: Map<string, number> = new Map(),
  thresholds = { clientBytes: 1000, roomBytes: 2000, globalBytes: 50000 },
): BackpressureMonitor {
  const m = new BackpressureMonitor(io, thresholds);
  m.injectMockBuffers(mockBuffers);
  return m;
}

function makeFlowController(
  monitor: BackpressureMonitor,
  emitFn: EmitFn,
  options?: { drainIntervalMs?: number; coalesceWindowMs?: number },
): FlowController {
  return new FlowController(monitor, emitFn, {
    drainIntervalMs:  options?.drainIntervalMs  ?? 50,
    coalesceWindowMs: options?.coalesceWindowMs ?? 50,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('FlowController integration', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(()  => jest.useRealTimers());

  // ── 1. CRITICAL bypass ─────────────────────────────────────────────────────

  it('CRITICAL events emit immediately regardless of backpressure', () => {
    const io      = makeMockIO();
    const buffers = new Map([['s1', 999999]]); // massive pressure
    const monitor = makeMonitor(io, buffers);
    const spy     = makeEmitSpy();
    const fc      = makeFlowController(monitor, spy.fn);

    // Mark room as heavily backpressured by injecting large buffer for a socket in it
    (io.sockets.adapter as unknown as { rooms: Map<string, Set<string>> }).rooms
      .set('campaign:1', new Set(['s1']));

    fc.emit('campaign:1', 'campaign:suspended', { reason: 'fraud' });
    fc.destroy();

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].event).toBe('campaign:suspended');
    expect(spy.calls[0].room).toBe('campaign:1');
  });

  it('isCriticalBypass returns true for all moderation events', () => {
    const io  = makeMockIO();
    const fc  = makeFlowController(makeMonitor(io), makeEmitSpy().fn);

    expect(fc.isCriticalBypass('campaign:suspended')).toBe(true);
    expect(fc.isCriticalBypass('campaign:reinstated')).toBe(true);
    expect(fc.isCriticalBypass('campaign:access_revoked')).toBe(true);
    expect(fc.isCriticalBypass('campaign:access_restored')).toBe(true);
    expect(fc.isCriticalBypass('appeal:updated')).toBe(true);
    expect(fc.isCriticalBypass('campaign:updated')).toBe(false);
    expect(fc.isCriticalBypass('donation:created')).toBe(false);

    fc.destroy();
  });

  // ── 2. Immediate emit when no backpressure ────────────────────────────────

  it('emits non-critical events immediately when no backpressure', () => {
    const io  = makeMockIO();
    const spy = makeEmitSpy();
    const fc  = makeFlowController(makeMonitor(io, new Map()), spy.fn);

    fc.emit('campaign:1', 'donation:created', { amount: 100 });
    fc.destroy();

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].event).toBe('donation:created');
  });

  // ── 3. Events queued under backpressure ───────────────────────────────────

  it('queues events (not emits) when room is backpressured', () => {
    const io      = makeMockIO();
    const buffers = new Map([['s1', 99999]]);
    (io.sockets.adapter as unknown as { rooms: Map<string, Set<string>> }).rooms
      .set('campaign:1', new Set(['s1']));

    const monitor = makeMonitor(io, buffers);
    const spy     = makeEmitSpy();
    const fc      = makeFlowController(monitor, spy.fn);

    fc.emit('campaign:1', 'donation:created', { amount: 100 });

    // Nothing emitted yet (timer hasn't fired)
    expect(spy.calls).toHaveLength(0);
    expect(fc.getStats().totalQueued).toBe(1);

    fc.destroy();
  });

  // ── 4. Drain after backpressure lifts ─────────────────────────────────────

  it('drains queued events once backpressure lifts', () => {
    const io      = makeMockIO();
    const buffers = new Map([['s1', 99999]]);
    (io.sockets.adapter as unknown as { rooms: Map<string, Set<string>> }).rooms
      .set('campaign:1', new Set(['s1']));

    const monitor = makeMonitor(io, buffers);
    const spy     = makeEmitSpy();
    const fc      = makeFlowController(monitor, spy.fn);

    fc.emit('campaign:1', 'donation:created', { amount: 100 });
    expect(spy.calls).toHaveLength(0);

    // Simulate backpressure lifting
    buffers.set('s1', 0);

    // Advance timer past drain interval
    jest.advanceTimersByTime(100);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].event).toBe('donation:created');

    fc.destroy();
  });

  // ── 5. Event coalescing ──────────────────────────────────────────────────

  it('coalesces multiple campaign:updated events into a single emit', () => {
    const io  = makeMockIO();
    const spy = makeEmitSpy();
    const fc  = makeFlowController(makeMonitor(io), spy.fn, { coalesceWindowMs: 100 });

    fc.emit('campaign:1', 'campaign:updated', { version: 1 });
    fc.emit('campaign:1', 'campaign:updated', { version: 2 });
    fc.emit('campaign:1', 'campaign:updated', { version: 3 });

    // Nothing emitted yet — coalesce timer still pending
    expect(spy.calls).toHaveLength(0);

    // Advance past coalesce window
    jest.advanceTimersByTime(150);

    // Only ONE emit, with the LATEST payload (version 3)
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].data).toEqual({ version: 3 });

    fc.destroy();
  });

  it('does not coalesce events for different rooms', () => {
    const io  = makeMockIO();
    const spy = makeEmitSpy();
    const fc  = makeFlowController(makeMonitor(io), spy.fn, { coalesceWindowMs: 100 });

    fc.emit('campaign:1', 'campaign:updated', { v: 1 });
    fc.emit('campaign:2', 'campaign:updated', { v: 2 });

    jest.advanceTimersByTime(150);

    expect(spy.calls).toHaveLength(2);
    const rooms = spy.calls.map((c) => c.room).sort();
    expect(rooms).toEqual(['campaign:1', 'campaign:2']);

    fc.destroy();
  });

  it('coalesces notification:unread_count events', () => {
    const io  = makeMockIO();
    const spy = makeEmitSpy();
    const fc  = makeFlowController(makeMonitor(io), spy.fn, { coalesceWindowMs: 100 });

    fc.emit('user:u1', 'notification:unread_count', { unreadCount: 1 });
    fc.emit('user:u1', 'notification:unread_count', { unreadCount: 2 });
    fc.emit('user:u1', 'notification:unread_count', { unreadCount: 3 });

    jest.advanceTimersByTime(150);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].data).toEqual({ unreadCount: 3 });

    fc.destroy();
  });

  // ── 6. Coalescing with backpressure: enqueue instead of scheduling emit ──

  it('queues coalesced event when room is backpressured at coalesce fire time', () => {
    const io      = makeMockIO();
    const buffers = new Map([['s1', 0]]);
    (io.sockets.adapter as unknown as { rooms: Map<string, Set<string>> }).rooms
      .set('campaign:1', new Set(['s1']));
    const monitor = makeMonitor(io, buffers);
    const spy     = makeEmitSpy();
    const fc      = makeFlowController(monitor, spy.fn, { coalesceWindowMs: 100 });

    fc.emit('campaign:1', 'campaign:updated', { v: 1 });

    // Apply backpressure before coalesce timer fires
    buffers.set('s1', 99999);

    jest.advanceTimersByTime(150);

    // Event should be queued, not emitted
    expect(spy.calls).toHaveLength(0);
    expect(fc.getStats().totalQueued).toBe(1);

    fc.destroy();
  });

  // ── 7. shouldThrottle() ──────────────────────────────────────────────────

  it('shouldThrottle returns false when no backpressure', () => {
    const io  = makeMockIO();
    const fc  = makeFlowController(makeMonitor(io, new Map()), makeEmitSpy().fn);

    expect(fc.shouldThrottle('campaign:1')).toBe(false);
    fc.destroy();
  });

  it('shouldThrottle returns true when room is backpressured', () => {
    const io      = makeMockIO();
    const buffers = new Map([['s1', 99999]]);
    (io.sockets.adapter as unknown as { rooms: Map<string, Set<string>> }).rooms
      .set('campaign:1', new Set(['s1']));
    const monitor = makeMonitor(io, buffers);
    const fc      = makeFlowController(monitor, makeEmitSpy().fn);

    expect(fc.shouldThrottle('campaign:1')).toBe(true);
    fc.destroy();
  });

  // ── 8. LOW event drop under sustained pressure ───────────────────────────

  it('drops LOW events on drain when room is still backpressured', () => {
    const io      = makeMockIO();
    const buffers = new Map([['s1', 99999]]);
    (io.sockets.adapter as unknown as { rooms: Map<string, Set<string>> }).rooms
      .set('campaign:1', new Set(['s1']));
    const monitor = makeMonitor(io, buffers);
    const spy     = makeEmitSpy();
    const fc      = makeFlowController(monitor, spy.fn);

    fc.emit('campaign:1', 'notification:unread_count', { unreadCount: 5 });
    expect(fc.getStats().totalQueued).toBe(1);

    // Fire drain while still pressured — LOW event should be dropped
    jest.advanceTimersByTime(100);

    expect(spy.calls).toHaveLength(0);
    expect(fc.getStats().totalDropped).toBe(1);

    fc.destroy();
  });

  // ── 9. Stats ─────────────────────────────────────────────────────────────

  it('increments totalEmitted on direct emit', () => {
    const io  = makeMockIO();
    const spy = makeEmitSpy();
    const fc  = makeFlowController(makeMonitor(io, new Map()), spy.fn);

    fc.emit('campaign:1', 'donation:created', {});
    fc.emit('campaign:2', 'donation:created', {});

    expect(fc.getStats().totalEmitted).toBe(2);
    fc.destroy();
  });

  it('getStats returns immutable copy', () => {
    const io = makeMockIO();
    const fc = makeFlowController(makeMonitor(io, new Map()), makeEmitSpy().fn);

    fc.emit('campaign:1', 'donation:created', {});
    const s1 = fc.getStats();
    fc.emit('campaign:1', 'donation:created', {});
    const s2 = fc.getStats();

    // s1 should not have changed
    expect(s1.totalEmitted).toBe(1);
    expect(s2.totalEmitted).toBe(2);
    fc.destroy();
  });

  // ── 10. destroy() clears timers ─────────────────────────────────────────

  it('destroy() prevents drain callbacks from firing', () => {
    const io      = makeMockIO();
    const buffers = new Map([['s1', 99999]]);
    (io.sockets.adapter as unknown as { rooms: Map<string, Set<string>> }).rooms
      .set('campaign:1', new Set(['s1']));
    const spy = makeEmitSpy();
    const fc  = makeFlowController(makeMonitor(io, buffers), spy.fn);

    fc.emit('campaign:1', 'donation:created', {});
    fc.destroy();

    // Release pressure, advance time — drain timer was cleared so nothing fires
    buffers.set('s1', 0);
    jest.advanceTimersByTime(500);

    expect(spy.calls).toHaveLength(0);
  });
});
