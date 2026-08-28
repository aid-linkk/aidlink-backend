/**
 * PriorityEventQueue
 *
 * A four-level priority queue for WebSocket events.
 *
 *   CRITICAL (0) — Moderation events: campaign:suspended, campaign:reinstated,
 *                  campaign:access_revoked, campaign:access_restored, appeal:updated
 *   HIGH     (1) — Donation / distribution confirmations, beneficiary updates
 *   MEDIUM   (2) — Campaign updates, organisation updates, notification:new
 *   LOW      (3) — Trending updates, analytics refreshes, unread counts
 *
 * Design choices
 * ──────────────
 * • CRITICAL events bypass the backpressure check entirely — they are always
 *   emitted regardless of queue / buffer pressure.
 * • Under backpressure the queue drops LOW events first, then MEDIUM, then
 *   HIGH.  CRITICAL events are never dropped.
 * • Each entry carries a TTL (default: 5 s); entries that have been sitting
 *   in the queue past their TTL are silently discarded on the next dequeue
 *   pass to avoid delivering stale state after a pressure episode.
 * • The queue is per-target (room or userId), so it can be instantiated once
 *   per FlowController-managed broadcast destination.
 *
 * Queue structure
 * ───────────────
 * We use four FIFO arrays (one per priority level) rather than a binary heap
 * because the number of levels is small and dequeue needs to walk all CRITICAL
 * entries first, then HIGH, etc.  Array.shift() is O(n) in the array length,
 * but we keep arrays short by enforcing a per-level capacity cap (evicting the
 * oldest item on overflow — not the lowest-priority, to avoid indefinite delay
 * at any single level).
 */

// ── Constants / defaults ──────────────────────────────────────────────────────

export const DEFAULT_TTL_MS = parseInt(
  process.env.WS_QUEUE_TTL_MS ?? '5000',
  10,
);

export const DEFAULT_LEVEL_CAPACITY = parseInt(
  process.env.WS_QUEUE_LEVEL_CAPACITY ?? '500',
  10,
);

// ── Types ─────────────────────────────────────────────────────────────────────

export enum EventPriority {
  CRITICAL = 0,
  HIGH     = 1,
  MEDIUM   = 2,
  LOW      = 3,
}

export interface QueuedEvent {
  /** Socket.IO event name, e.g. 'campaign:updated' */
  event: string;
  /** Arbitrary event payload */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  /** Priority level */
  priority: EventPriority;
  /** Unix timestamp (ms) at which this entry was enqueued */
  enqueuedAt: number;
  /** Unix timestamp (ms) after which this entry should be discarded */
  expiresAt: number;
}

export interface QueueStats {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
}

// ── Event → Priority mapping ───────────────────────────────────────────────────

/**
 * Static mapping from event name to priority.
 * Callers that know the priority at emit time can pass it explicitly; this
 * map is used by `classifyEvent()` as a fallback.
 */
const EVENT_PRIORITY_MAP: Record<string, EventPriority> = {
  // CRITICAL — moderation
  'campaign:suspended':       EventPriority.CRITICAL,
  'campaign:reinstated':      EventPriority.CRITICAL,
  'campaign:access_revoked':  EventPriority.CRITICAL,
  'campaign:access_restored': EventPriority.CRITICAL,
  'appeal:updated':           EventPriority.CRITICAL,

  // HIGH — transaction events
  'donation:created':         EventPriority.HIGH,
  'donation:confirmed':       EventPriority.HIGH,
  'distribution:updated':     EventPriority.HIGH,
  'distribution:confirmed':   EventPriority.HIGH,
  'beneficiary:updated':      EventPriority.HIGH,

  // MEDIUM — informational updates
  'campaign:updated':         EventPriority.MEDIUM,
  'organization:updated':     EventPriority.MEDIUM,
  'notification:new':         EventPriority.MEDIUM,

  // LOW — analytics / counters
  'notification:unread_count': EventPriority.LOW,
  'campaign:trending':         EventPriority.LOW,
  'analytics:refresh':         EventPriority.LOW,
};

/**
 * Classify an event name to a priority level.  Falls back to MEDIUM for
 * unrecognised events so they are not silently dropped under LOW backpressure.
 */
export function classifyEvent(eventName: string): EventPriority {
  return EVENT_PRIORITY_MAP[eventName] ?? EventPriority.MEDIUM;
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class PriorityEventQueue {
  private readonly levels: [QueuedEvent[], QueuedEvent[], QueuedEvent[], QueuedEvent[]];
  private readonly levelCapacity: number;
  private readonly ttlMs: number;

  constructor(options?: { levelCapacity?: number; ttlMs?: number }) {
    this.levelCapacity = options?.levelCapacity ?? DEFAULT_LEVEL_CAPACITY;
    this.ttlMs         = options?.ttlMs         ?? DEFAULT_TTL_MS;
    this.levels        = [[], [], [], []];
  }

  // ── Enqueue ─────────────────────────────────────────────────────────────────

  /**
   * Adds an event to the queue.
   *
   * @param event    Socket.IO event name
   * @param data     Event payload
   * @param priority Optional priority override; auto-classified if omitted
   *
   * If the target level is at capacity, the oldest item at that level is
   * evicted to make room.  CRITICAL events are never capped (capacity is not
   * enforced for level 0).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  enqueue(event: string, data: any, priority?: EventPriority): QueuedEvent {
    const p      = priority ?? classifyEvent(event);
    const now    = Date.now();
    const entry: QueuedEvent = {
      event,
      data,
      priority: p,
      enqueuedAt: now,
      expiresAt:  now + this.ttlMs,
    };

    const queue = this.levels[p];

    // Enforce per-level capacity (skip for CRITICAL)
    if (p !== EventPriority.CRITICAL && queue.length >= this.levelCapacity) {
      queue.shift(); // evict the oldest entry
    }

    queue.push(entry);
    return entry;
  }

  // ── Dequeue ─────────────────────────────────────────────────────────────────

  /**
   * Dequeues the next event in priority order (CRITICAL → HIGH → MEDIUM → LOW).
   * Expired entries are silently skipped.
   *
   * Returns `null` when the queue is empty.
   */
  dequeue(): QueuedEvent | null {
    const now = Date.now();

    for (let p = EventPriority.CRITICAL; p <= EventPriority.LOW; p++) {
      const queue = this.levels[p];

      while (queue.length > 0) {
        const entry = queue.shift()!;
        if (entry.expiresAt > now) {
          return entry;
        }
        // else: expired — discard and continue looking
      }
    }

    return null;
  }

  /**
   * Dequeues up to `maxCount` events, returning them in priority order.
   * Useful for batch draining under back-off.
   */
  drainBatch(maxCount: number): QueuedEvent[] {
    const batch: QueuedEvent[] = [];
    while (batch.length < maxCount) {
      const entry = this.dequeue();
      if (!entry) break;
      batch.push(entry);
    }
    return batch;
  }

  // ── Backpressure-aware drop ──────────────────────────────────────────────────

  /**
   * Drops events from the lowest priority levels to relieve queue pressure.
   *
   * @param dropLow     Drop all LOW priority events
   * @param dropMedium  Drop all MEDIUM priority events (implies dropLow)
   * @param dropHigh    Drop all HIGH priority events (implies dropLow + dropMedium)
   *
   * CRITICAL events are never dropped.
   *
   * Returns the number of events removed.
   */
  dropUnderPressure(
    dropLow     = true,
    dropMedium  = false,
    dropHigh    = false,
  ): number {
    let dropped = 0;

    if (dropLow || dropMedium || dropHigh) {
      dropped += this.levels[EventPriority.LOW].length;
      this.levels[EventPriority.LOW] = [];
    }

    if (dropMedium || dropHigh) {
      dropped += this.levels[EventPriority.MEDIUM].length;
      this.levels[EventPriority.MEDIUM] = [];
    }

    if (dropHigh) {
      dropped += this.levels[EventPriority.HIGH].length;
      this.levels[EventPriority.HIGH] = [];
    }

    return dropped;
  }

  // ── Peek / stats ─────────────────────────────────────────────────────────────

  /**
   * Returns true if the queue has at least one non-expired entry.
   */
  isEmpty(): boolean {
    const now = Date.now();
    for (let p = EventPriority.CRITICAL; p <= EventPriority.LOW; p++) {
      for (const entry of this.levels[p]) {
        if (entry.expiresAt > now) return false;
      }
    }
    return true;
  }

  /**
   * Returns the number of entries at each priority level (including expired).
   */
  stats(): QueueStats {
    return {
      critical: this.levels[EventPriority.CRITICAL].length,
      high:     this.levels[EventPriority.HIGH].length,
      medium:   this.levels[EventPriority.MEDIUM].length,
      low:      this.levels[EventPriority.LOW].length,
      total:
        this.levels[EventPriority.CRITICAL].length +
        this.levels[EventPriority.HIGH].length +
        this.levels[EventPriority.MEDIUM].length +
        this.levels[EventPriority.LOW].length,
    };
  }

  /**
   * Clears all levels (useful for teardown in tests).
   */
  clear(): void {
    this.levels[EventPriority.CRITICAL] = [];
    this.levels[EventPriority.HIGH]     = [];
    this.levels[EventPriority.MEDIUM]   = [];
    this.levels[EventPriority.LOW]      = [];
  }
}
