/**
 * FlowController
 *
 * Sits between the application's broadcast calls and Socket.IO's io.to().emit()
 * to apply backpressure, throttling, and event coalescing.
 *
 * Responsibilities
 * ────────────────
 * 1. Backpressure signal — exposes `shouldThrottle(room)` which event generators
 *    can check before emitting, and `isCriticalBypass(event)` for CRITICAL events
 *    that must always go through.
 *
 * 2. Adaptive throttling — when a room is backpressured, non-CRITICAL events
 *    for that room are buffered in a per-room PriorityEventQueue.  A periodic
 *    drain (configurable interval, default 100 ms) flushes queued events in
 *    priority order once pressure drops.
 *
 * 3. Event coalescing — multiple `campaign:updated` events for the same campaign
 *    within the coalesce window (default 100 ms) are collapsed into a single
 *    emit with the most-recently-enqueued payload.  The coalesce key is
 *    `${room}::${event}`.
 *
 * 4. Forwarding — for unthrottled events (or after draining) the controller
 *    calls the provided `emitFn` to actually send the event.
 *
 * Thread-safety: Node.js is single-threaded, so all mutations are safe without
 * locks.
 */

import { BackpressureMonitor } from './BackpressureMonitor';
import {
  PriorityEventQueue,
  EventPriority,
  classifyEvent,
  QueuedEvent,
} from './PriorityEventQueue';
import logger from '../../config/logger';

// ── Configuration defaults ────────────────────────────────────────────────────

const DEFAULT_DRAIN_INTERVAL_MS = parseInt(
  process.env.WS_FC_DRAIN_INTERVAL_MS ?? '100',
  10,
);

const DEFAULT_COALESCE_WINDOW_MS = parseInt(
  process.env.WS_FC_COALESCE_WINDOW_MS ?? '100',
  10,
);

const DEFAULT_DRAIN_BATCH_SIZE = parseInt(
  process.env.WS_FC_DRAIN_BATCH_SIZE ?? '50',
  10,
);

// ── Types ─────────────────────────────────────────────────────────────────────

/** Function signature used to actually emit an event to a room. */
export type EmitFn = (room: string, event: string, data: unknown) => void;

/** Coalesce entry: last-known payload + deferred timer handle */
interface CoalesceEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  timer: NodeJS.Timeout;
}

export interface FlowControllerOptions {
  drainIntervalMs?:  number;
  coalesceWindowMs?: number;
  drainBatchSize?:   number;
}

export interface FlowControllerStats {
  totalEmitted:    number;
  totalQueued:     number;
  totalDropped:    number;
  totalCoalesced:  number;
  activeRooms:     number;
}

// ── CRITICAL event set ────────────────────────────────────────────────────────

const CRITICAL_EVENTS = new Set<string>([
  'campaign:suspended',
  'campaign:reinstated',
  'campaign:access_revoked',
  'campaign:access_restored',
  'appeal:updated',
]);

// ── Events eligible for coalescing ───────────────────────────────────────────

const COALESCING_EVENTS = new Set<string>([
  'campaign:updated',
  'organization:updated',
  'notification:unread_count',
]);

// ── Implementation ─────────────────────────────────────────────────────────────

export class FlowController {
  private readonly monitor: BackpressureMonitor;
  private readonly emitFn: EmitFn;

  private readonly drainIntervalMs:  number;
  private readonly coalesceWindowMs: number;
  private readonly drainBatchSize:   number;

  /** Per-room priority queues (created on first use, deleted when empty). */
  private readonly queues = new Map<string, PriorityEventQueue>();

  /** Per-room drain timers. */
  private readonly drainTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Coalesce map: `${room}::${event}` → { data, timer }
   * When a second coalescing event arrives before the timer fires, the
   * payload is updated and the timer is NOT reset (first-emit-wins window).
   */
  private readonly coalesceMap = new Map<string, CoalesceEntry>();

  /** Observability counters */
  private stats: FlowControllerStats = {
    totalEmitted:   0,
    totalQueued:    0,
    totalDropped:   0,
    totalCoalesced: 0,
    activeRooms:    0,
  };

  constructor(
    monitor: BackpressureMonitor,
    emitFn: EmitFn,
    options?: FlowControllerOptions,
  ) {
    this.monitor          = monitor;
    this.emitFn           = emitFn;
    this.drainIntervalMs  = options?.drainIntervalMs  ?? DEFAULT_DRAIN_INTERVAL_MS;
    this.coalesceWindowMs = options?.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    this.drainBatchSize   = options?.drainBatchSize   ?? DEFAULT_DRAIN_BATCH_SIZE;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * The main entry point replacing direct `io.to(room).emit(event, data)`.
   *
   * Decision tree:
   *   1. CRITICAL event → emit immediately, bypass all checks.
   *   2. Coalescing event + no backpressure on room → start/update coalesce
   *      window.
   *   3. Coalescing event + room backpressured → enqueue into priority queue.
   *   4. Normal event + room backpressured → enqueue into priority queue.
   *   5. Normal event + no backpressure → emit immediately.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(room: string, event: string, data: any): void {
    // ── 1. CRITICAL bypass ─────────────────────────────────────────────────
    if (CRITICAL_EVENTS.has(event)) {
      this.directEmit(room, event, data);
      return;
    }

    const priority = classifyEvent(event);

    // ── 2 & 3. Coalescing events ───────────────────────────────────────────
    if (COALESCING_EVENTS.has(event)) {
      const coalesceKey = `${room}::${event}`;
      const existing = this.coalesceMap.get(coalesceKey);

      if (existing) {
        // Update payload but don't reset the timer
        existing.data = data;
        this.stats.totalCoalesced++;
        return;
      }

      // Under backpressure, enqueue instead of coalescing to direct emit
      if (this.monitor.isRoomBackpressured(room)) {
        this.enqueueForRoom(room, event, data, priority);
        return;
      }

      // Start the coalesce window: schedule one emit after coalesceWindowMs
      const entry: CoalesceEntry = {
        data,
        timer: setTimeout(() => {
          this.coalesceMap.delete(coalesceKey);
          // Re-check pressure at drain time
          if (this.monitor.isRoomBackpressured(room)) {
            this.enqueueForRoom(room, event, entry.data, priority);
          } else {
            this.directEmit(room, event, entry.data);
          }
        }, this.coalesceWindowMs),
      };
      this.coalesceMap.set(coalesceKey, entry);
      return;
    }

    // ── 4 & 5. Normal events ───────────────────────────────────────────────
    if (this.monitor.isRoomBackpressured(room) || this.monitor.isGlobalBackpressured()) {
      this.enqueueForRoom(room, event, data, priority);
    } else {
      this.directEmit(room, event, data);
    }
  }

  /**
   * Returns true if the room is currently backpressured.
   * Event generators can call this before doing expensive data fetches.
   */
  shouldThrottle(room: string): boolean {
    return (
      this.monitor.isRoomBackpressured(room) ||
      this.monitor.isGlobalBackpressured()
    );
  }

  /**
   * Returns true if the event is CRITICAL and should always be emitted.
   */
  isCriticalBypass(event: string): boolean {
    return CRITICAL_EVENTS.has(event);
  }

  /**
   * Returns a snapshot of flow-control counters.
   */
  getStats(): Readonly<FlowControllerStats> {
    return { ...this.stats, activeRooms: this.queues.size };
  }

  /**
   * Tears down all timers (drain + coalesce).  Call on server shutdown to
   * prevent open handles in tests.
   */
  destroy(): void {
    for (const timer of this.drainTimers.values()) clearTimeout(timer);
    for (const entry of this.coalesceMap.values())  clearTimeout(entry.timer);
    this.drainTimers.clear();
    this.coalesceMap.clear();
    this.queues.clear();
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private directEmit(room: string, event: string, data: any): void {
    try {
      this.emitFn(room, event, data);
      this.stats.totalEmitted++;
    } catch (err) {
      logger.error('FlowController: emitFn threw', { room, event, error: err });
    }
  }

  private enqueueForRoom(
    room: string,
    event: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any,
    priority: EventPriority,
  ): void {
    let queue = this.queues.get(room);

    if (!queue) {
      queue = new PriorityEventQueue();
      this.queues.set(room, queue);
      this.scheduleDrain(room);
    }

    queue.enqueue(event, data, priority);
    this.stats.totalQueued++;

    logger.debug('FlowController: queued event under backpressure', {
      room,
      event,
      priority,
      queueStats: queue.stats(),
    });
  }

  private scheduleDrain(room: string): void {
    if (this.drainTimers.has(room)) return; // already scheduled

    const timer = setTimeout(() => {
      this.drainTimers.delete(room);
      this.drainRoom(room);
    }, this.drainIntervalMs);

    this.drainTimers.set(room, timer);
  }

  private drainRoom(room: string): void {
    const queue = this.queues.get(room);
    if (!queue) return;

    const stillPressured =
      this.monitor.isRoomBackpressured(room) ||
      this.monitor.isGlobalBackpressured();

    if (stillPressured) {
      // Drop LOW events; keep MEDIUM+ until next drain attempt.
      const dropped = queue.dropUnderPressure(true, false, false);
      if (dropped > 0) {
        this.stats.totalDropped += dropped;
        logger.warn('FlowController: dropped LOW events under sustained backpressure', {
          room,
          dropped,
        });
      }

      // Re-schedule drain to try again later.
      this.scheduleDrain(room);
      return;
    }

    // Pressure has lifted — drain up to batchSize events.
    const batch = queue.drainBatch(this.drainBatchSize);
    for (const entry of batch) {
      this.directEmit(room, entry.event, entry.data);
    }

    if (queue.isEmpty()) {
      this.queues.delete(room);
    } else {
      // More events remain — schedule another drain.
      this.scheduleDrain(room);
    }
  }
}
