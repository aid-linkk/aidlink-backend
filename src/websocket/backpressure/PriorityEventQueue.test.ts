/**
 * Unit tests for PriorityEventQueue
 *
 * Tests cover:
 *   • CRITICAL events bypass capacity cap
 *   • Priority-based dequeue ordering (CRITICAL first, then HIGH, MEDIUM, LOW)
 *   • TTL expiry: stale entries are skipped on dequeue
 *   • Per-level capacity: oldest entry evicted on overflow
 *   • Priority-based dropping under backpressure
 *   • drainBatch() returns events in priority order
 *   • isEmpty() correctly reflects live (non-expired) entries
 *   • clear() empties all levels
 *   • stats() returns accurate counts
 *   • classifyEvent() maps known and unknown event names
 */

import {
  PriorityEventQueue,
  EventPriority,
  classifyEvent,
  QueuedEvent,
} from './PriorityEventQueue';

// ── classifyEvent() ───────────────────────────────────────────────────────────

describe('classifyEvent()', () => {
  it('maps CRITICAL moderation events', () => {
    expect(classifyEvent('campaign:suspended')).toBe(EventPriority.CRITICAL);
    expect(classifyEvent('campaign:reinstated')).toBe(EventPriority.CRITICAL);
    expect(classifyEvent('campaign:access_revoked')).toBe(EventPriority.CRITICAL);
    expect(classifyEvent('campaign:access_restored')).toBe(EventPriority.CRITICAL);
    expect(classifyEvent('appeal:updated')).toBe(EventPriority.CRITICAL);
  });

  it('maps HIGH transaction events', () => {
    expect(classifyEvent('donation:created')).toBe(EventPriority.HIGH);
    expect(classifyEvent('donation:confirmed')).toBe(EventPriority.HIGH);
    expect(classifyEvent('distribution:updated')).toBe(EventPriority.HIGH);
    expect(classifyEvent('beneficiary:updated')).toBe(EventPriority.HIGH);
  });

  it('maps MEDIUM informational events', () => {
    expect(classifyEvent('campaign:updated')).toBe(EventPriority.MEDIUM);
    expect(classifyEvent('organization:updated')).toBe(EventPriority.MEDIUM);
    expect(classifyEvent('notification:new')).toBe(EventPriority.MEDIUM);
  });

  it('maps LOW analytics/counter events', () => {
    expect(classifyEvent('notification:unread_count')).toBe(EventPriority.LOW);
    expect(classifyEvent('campaign:trending')).toBe(EventPriority.LOW);
    expect(classifyEvent('analytics:refresh')).toBe(EventPriority.LOW);
  });

  it('falls back to MEDIUM for unrecognised events', () => {
    expect(classifyEvent('unknown:event')).toBe(EventPriority.MEDIUM);
    expect(classifyEvent('')).toBe(EventPriority.MEDIUM);
  });
});

// ── PriorityEventQueue ────────────────────────────────────────────────────────

describe('PriorityEventQueue', () => {

  // ── Enqueue / Dequeue ordering ───────────────────────────────────────────────

  describe('priority ordering', () => {
    it('dequeues CRITICAL events before HIGH, MEDIUM, LOW', () => {
      const q = new PriorityEventQueue();
      q.enqueue('campaign:updated',   { a: 1 }, EventPriority.MEDIUM);
      q.enqueue('donation:created',   { b: 2 }, EventPriority.HIGH);
      q.enqueue('campaign:suspended', { c: 3 }, EventPriority.CRITICAL);
      q.enqueue('notification:unread_count', { d: 4 }, EventPriority.LOW);

      const first = q.dequeue();
      expect(first?.priority).toBe(EventPriority.CRITICAL);
      expect(first?.event).toBe('campaign:suspended');

      const second = q.dequeue();
      expect(second?.priority).toBe(EventPriority.HIGH);

      const third = q.dequeue();
      expect(third?.priority).toBe(EventPriority.MEDIUM);

      const fourth = q.dequeue();
      expect(fourth?.priority).toBe(EventPriority.LOW);

      expect(q.dequeue()).toBeNull();
    });

    it('maintains FIFO within the same priority level', () => {
      const q = new PriorityEventQueue();
      q.enqueue('campaign:updated', { order: 1 }, EventPriority.MEDIUM);
      q.enqueue('campaign:updated', { order: 2 }, EventPriority.MEDIUM);
      q.enqueue('campaign:updated', { order: 3 }, EventPriority.MEDIUM);

      expect(q.dequeue()?.data.order).toBe(1);
      expect(q.dequeue()?.data.order).toBe(2);
      expect(q.dequeue()?.data.order).toBe(3);
    });

    it('dequeues multiple CRITICAL events before anything else', () => {
      const q = new PriorityEventQueue();
      q.enqueue('donation:created',     {}, EventPriority.HIGH);
      q.enqueue('campaign:suspended',   { n: 1 }, EventPriority.CRITICAL);
      q.enqueue('campaign:reinstated',  { n: 2 }, EventPriority.CRITICAL);

      const first = q.dequeue();
      expect(first?.priority).toBe(EventPriority.CRITICAL);
      expect(first?.data.n).toBe(1);

      const second = q.dequeue();
      expect(second?.priority).toBe(EventPriority.CRITICAL);
      expect(second?.data.n).toBe(2);

      const third = q.dequeue();
      expect(third?.priority).toBe(EventPriority.HIGH);
    });
  });

  // ── CRITICAL bypass of capacity cap ─────────────────────────────────────────

  describe('CRITICAL events bypass capacity cap', () => {
    it('accepts unlimited CRITICAL entries regardless of levelCapacity', () => {
      const q = new PriorityEventQueue({ levelCapacity: 3 });

      for (let i = 0; i < 10; i++) {
        q.enqueue('campaign:suspended', { i }, EventPriority.CRITICAL);
      }

      const stats = q.stats();
      expect(stats.critical).toBe(10);
    });

    it('evicts the oldest entry from LOW when capacity is exceeded', () => {
      const q = new PriorityEventQueue({ levelCapacity: 3 });
      q.enqueue('notification:unread_count', { seq: 1 }, EventPriority.LOW);
      q.enqueue('notification:unread_count', { seq: 2 }, EventPriority.LOW);
      q.enqueue('notification:unread_count', { seq: 3 }, EventPriority.LOW);
      // 4th push — seq 1 (oldest) should be evicted
      q.enqueue('notification:unread_count', { seq: 4 }, EventPriority.LOW);

      const stats = q.stats();
      expect(stats.low).toBe(3);

      const items: number[] = [];
      let entry = q.dequeue();
      while (entry) {
        items.push(entry.data.seq as number);
        entry = q.dequeue();
      }

      expect(items).toEqual([2, 3, 4]);
    });
  });

  // ── TTL expiry ───────────────────────────────────────────────────────────────

  describe('TTL expiry', () => {
    it('returns null when all entries have expired', () => {
      // Create a queue with a very short TTL
      const q = new PriorityEventQueue({ ttlMs: 1 });
      q.enqueue('campaign:updated', {}, EventPriority.MEDIUM);

      // Wait > 1 ms so the entry expires
      // Use a tight busy-wait or jest fake timers
      const start = Date.now();
      while (Date.now() - start < 10) {
        // busy wait
      }

      expect(q.dequeue()).toBeNull();
    });

    it('skips expired entries and returns the next valid one', () => {
      jest.useFakeTimers();
      const q = new PriorityEventQueue({ ttlMs: 100 });

      q.enqueue('campaign:updated', { n: 1 }, EventPriority.MEDIUM);

      // Advance time past TTL
      jest.advanceTimersByTime(200);

      q.enqueue('campaign:updated', { n: 2 }, EventPriority.MEDIUM);

      const result = q.dequeue();
      // n=1 is expired, n=2 is fresh
      expect(result?.data.n).toBe(2);

      jest.useRealTimers();
    });

    it('fresh CRITICAL entry is returned despite older expired entries', () => {
      jest.useFakeTimers();
      const q = new PriorityEventQueue({ ttlMs: 50 });

      q.enqueue('campaign:suspended', { n: 1 }, EventPriority.CRITICAL);

      jest.advanceTimersByTime(100);

      q.enqueue('campaign:suspended', { n: 2 }, EventPriority.CRITICAL);
      const result = q.dequeue();
      expect(result?.data.n).toBe(2);

      jest.useRealTimers();
    });
  });

  // ── dropUnderPressure() ──────────────────────────────────────────────────────

  describe('dropUnderPressure()', () => {
    function populatedQueue(): PriorityEventQueue {
      const q = new PriorityEventQueue();
      q.enqueue('campaign:suspended', {}, EventPriority.CRITICAL);
      q.enqueue('donation:created',   {}, EventPriority.HIGH);
      q.enqueue('campaign:updated',   {}, EventPriority.MEDIUM);
      q.enqueue('notification:unread_count', {}, EventPriority.LOW);
      return q;
    }

    it('drops only LOW events by default', () => {
      const q = populatedQueue();
      const dropped = q.dropUnderPressure(true, false, false);
      expect(dropped).toBe(1);
      const s = q.stats();
      expect(s.critical).toBe(1);
      expect(s.high).toBe(1);
      expect(s.medium).toBe(1);
      expect(s.low).toBe(0);
    });

    it('drops LOW and MEDIUM events when dropMedium = true', () => {
      const q = populatedQueue();
      const dropped = q.dropUnderPressure(true, true, false);
      expect(dropped).toBe(2);
      const s = q.stats();
      expect(s.critical).toBe(1);
      expect(s.high).toBe(1);
      expect(s.medium).toBe(0);
      expect(s.low).toBe(0);
    });

    it('drops LOW, MEDIUM, and HIGH when dropHigh = true', () => {
      const q = populatedQueue();
      const dropped = q.dropUnderPressure(true, true, true);
      expect(dropped).toBe(3);
      const s = q.stats();
      expect(s.critical).toBe(1);
      expect(s.high).toBe(0);
      expect(s.medium).toBe(0);
      expect(s.low).toBe(0);
    });

    it('never drops CRITICAL events', () => {
      const q = new PriorityEventQueue();
      for (let i = 0; i < 5; i++) {
        q.enqueue('campaign:suspended', {}, EventPriority.CRITICAL);
      }
      q.dropUnderPressure(true, true, true);
      expect(q.stats().critical).toBe(5);
    });
  });

  // ── drainBatch() ─────────────────────────────────────────────────────────────

  describe('drainBatch()', () => {
    it('returns up to maxCount events in priority order', () => {
      const q = new PriorityEventQueue();
      q.enqueue('campaign:updated',   { n: 3 }, EventPriority.MEDIUM);
      q.enqueue('donation:created',   { n: 2 }, EventPriority.HIGH);
      q.enqueue('campaign:suspended', { n: 1 }, EventPriority.CRITICAL);
      q.enqueue('notification:unread_count', { n: 4 }, EventPriority.LOW);

      const batch = q.drainBatch(3);
      expect(batch).toHaveLength(3);
      expect(batch[0].data.n).toBe(1); // CRITICAL
      expect(batch[1].data.n).toBe(2); // HIGH
      expect(batch[2].data.n).toBe(3); // MEDIUM

      // LOW should remain
      expect(q.stats().low).toBe(1);
    });

    it('returns fewer than maxCount when queue has less', () => {
      const q = new PriorityEventQueue();
      q.enqueue('campaign:updated', {}, EventPriority.MEDIUM);

      const batch = q.drainBatch(10);
      expect(batch).toHaveLength(1);
    });

    it('returns empty array for an empty queue', () => {
      const q = new PriorityEventQueue();
      expect(q.drainBatch(5)).toEqual([]);
    });
  });

  // ── isEmpty() ────────────────────────────────────────────────────────────────

  describe('isEmpty()', () => {
    it('returns true for a new queue', () => {
      const q = new PriorityEventQueue();
      expect(q.isEmpty()).toBe(true);
    });

    it('returns false after an entry is enqueued', () => {
      const q = new PriorityEventQueue();
      q.enqueue('campaign:updated', {}, EventPriority.MEDIUM);
      expect(q.isEmpty()).toBe(false);
    });

    it('returns true after all entries are dequeued', () => {
      const q = new PriorityEventQueue();
      q.enqueue('campaign:updated', {}, EventPriority.MEDIUM);
      q.dequeue();
      expect(q.isEmpty()).toBe(true);
    });

    it('returns true when all entries have expired', () => {
      jest.useFakeTimers();
      const q = new PriorityEventQueue({ ttlMs: 50 });
      q.enqueue('campaign:updated', {}, EventPriority.MEDIUM);
      jest.advanceTimersByTime(100);
      expect(q.isEmpty()).toBe(true);
      jest.useRealTimers();
    });
  });

  // ── stats() ──────────────────────────────────────────────────────────────────

  describe('stats()', () => {
    it('reports zero counts for an empty queue', () => {
      const q = new PriorityEventQueue();
      expect(q.stats()).toEqual({ critical: 0, high: 0, medium: 0, low: 0, total: 0 });
    });

    it('reports correct counts after enqueueing', () => {
      const q = new PriorityEventQueue();
      q.enqueue('campaign:suspended', {}, EventPriority.CRITICAL);
      q.enqueue('campaign:suspended', {}, EventPriority.CRITICAL);
      q.enqueue('donation:created',   {}, EventPriority.HIGH);
      q.enqueue('campaign:updated',   {}, EventPriority.MEDIUM);

      const s = q.stats();
      expect(s.critical).toBe(2);
      expect(s.high).toBe(1);
      expect(s.medium).toBe(1);
      expect(s.low).toBe(0);
      expect(s.total).toBe(4);
    });
  });

  // ── clear() ──────────────────────────────────────────────────────────────────

  describe('clear()', () => {
    it('empties all levels', () => {
      const q = new PriorityEventQueue();
      q.enqueue('campaign:suspended', {}, EventPriority.CRITICAL);
      q.enqueue('donation:created',   {}, EventPriority.HIGH);
      q.enqueue('campaign:updated',   {}, EventPriority.MEDIUM);
      q.enqueue('notification:unread_count', {}, EventPriority.LOW);

      q.clear();

      expect(q.stats().total).toBe(0);
      expect(q.isEmpty()).toBe(true);
      expect(q.dequeue()).toBeNull();
    });
  });

  // ── auto-classify via enqueue ─────────────────────────────────────────────────

  describe('auto-classification on enqueue', () => {
    it('automatically classifies event to correct priority level', () => {
      const q = new PriorityEventQueue();
      q.enqueue('campaign:suspended', {});   // should be CRITICAL
      q.enqueue('donation:created',   {});   // should be HIGH
      q.enqueue('campaign:updated',   {});   // should be MEDIUM
      q.enqueue('notification:unread_count', {}); // should be LOW

      const first = q.dequeue();
      expect(first?.priority).toBe(EventPriority.CRITICAL);
      expect(first?.event).toBe('campaign:suspended');
    });
  });
});
