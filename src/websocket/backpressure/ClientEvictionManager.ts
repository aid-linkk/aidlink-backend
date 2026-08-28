/**
 * ClientEvictionManager
 *
 * Enforces three client-level policies:
 *
 *  1. Slow-client eviction
 *     A client whose send buffer exceeds the threshold for a sustained period
 *     (sustainMs, default 30 s) is forcibly disconnected.  "Slow" is detected
 *     by the BackpressureMonitor.
 *
 *  2. Idle-client eviction
 *     A client that has neither sent nor received any event in idleTimeoutMs
 *     (default 5 min) is disconnected.  Idle tracking is updated by calling
 *     `recordActivity(socketId)`.
 *
 *  3. Per-client event rate limiting
 *     Each client gets a token bucket (capacity = eventsPerSecond, default 50).
 *     `checkRateLimit(socketId)` returns false when the bucket is empty;
 *     callers should drop the event for that client.
 *
 * The manager runs a periodic sweep (default 5 s) that:
 *   • Identifies backpressured clients that have been slow for ≥ sustainMs.
 *   • Identifies idle clients past idleTimeoutMs.
 *   • Disconnects and logs each eviction.
 *
 * After eviction the socket is fully disconnected (socket.disconnect(true));
 * the client will see a normal 'disconnect' event and can reconnect immediately.
 *
 * All timers are cleared on `destroy()`.
 */

import { Server as SocketIOServer } from 'socket.io';
import { BackpressureMonitor } from './BackpressureMonitor';
import logger from '../../config/logger';

// ── Configuration defaults ─────────────────────────────────────────────────────

const DEFAULT_SWEEP_INTERVAL_MS = parseInt(
  process.env.WS_EVICT_SWEEP_INTERVAL_MS ?? '5000',
  10,
);

const DEFAULT_SLOW_SUSTAIN_MS = parseInt(
  process.env.WS_EVICT_SLOW_SUSTAIN_MS ?? '30000',
  10,
);

const DEFAULT_IDLE_TIMEOUT_MS = parseInt(
  process.env.WS_EVICT_IDLE_TIMEOUT_MS ?? '300000', // 5 min
  10,
);

const DEFAULT_EVENTS_PER_SECOND = parseInt(
  process.env.WS_EVICT_EVENTS_PER_SECOND ?? '50',
  10,
);

// ── Types ─────────────────────────────────────────────────────────────────────

export type EvictionReason = 'slow_client' | 'idle_client' | 'rate_limit_abuse';

export interface EvictionRecord {
  socketId: string;
  userId?: string;
  reason: EvictionReason;
  evictedAt: number;
  bufferBytes?: number;
}

export interface ClientEvictionOptions {
  sweepIntervalMs?:  number;
  slowSustainMs?:    number;
  idleTimeoutMs?:    number;
  eventsPerSecond?:  number;
}

// ── Internal per-socket state ──────────────────────────────────────────────────

interface SocketState {
  /** Timestamp (ms) when this socket first appeared backpressured. */
  slowSince: number | null;
  /** Timestamp (ms) of the most recent activity (send or receive). */
  lastActivityAt: number;
  /** Token bucket for per-client rate limiting. */
  tokenBucket: TokenBucket;
}

// ── Minimal token-bucket ───────────────────────────────────────────────────────
// We re-implement a lightweight synchronous variant here (rather than importing
// TokenBucketRateLimiter from utils/rateLimiter) because:
//   • The existing implementation awaits a sleep when no token is available,
//     which is inappropriate for the hot path of determining whether to drop an
//     inbound event.
//   • We need a synchronous `tryConsume()` → boolean interface.

class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillIntervalMs: number;
  private lastRefillAt: number;

  constructor(eventsPerSecond: number) {
    this.capacity          = eventsPerSecond;
    this.tokens            = eventsPerSecond;
    this.refillIntervalMs  = 1_000 / eventsPerSecond;
    this.lastRefillAt      = Date.now();
  }

  /**
   * Attempts to consume one token.
   * Returns true if the event is allowed, false if the bucket is empty.
   */
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Number of tokens currently available (fractional). */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now        = Date.now();
    const elapsed    = now - this.lastRefillAt;
    if (elapsed > 0) {
      this.tokens      = Math.min(this.capacity, this.tokens + elapsed / this.refillIntervalMs);
      this.lastRefillAt = now;
    }
  }
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class ClientEvictionManager {
  private readonly io: SocketIOServer;
  private readonly monitor: BackpressureMonitor;

  private readonly sweepIntervalMs: number;
  private readonly slowSustainMs:   number;
  private readonly idleTimeoutMs:   number;
  private readonly eventsPerSecond: number;

  /** State keyed by socketId — entries created on connect, removed on evict. */
  private readonly states = new Map<string, SocketState>();

  /** History of recent evictions (capped at 1 000 entries). */
  private readonly evictionHistory: EvictionRecord[] = [];

  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    io: SocketIOServer,
    monitor: BackpressureMonitor,
    options?: ClientEvictionOptions,
  ) {
    this.io              = io;
    this.monitor         = monitor;
    this.sweepIntervalMs = options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.slowSustainMs   = options?.slowSustainMs   ?? DEFAULT_SLOW_SUSTAIN_MS;
    this.idleTimeoutMs   = options?.idleTimeoutMs   ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.eventsPerSecond = options?.eventsPerSecond ?? DEFAULT_EVENTS_PER_SECOND;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Start the periodic sweep.  Call after Socket.IO server is up.
   */
  start(): void {
    if (this.sweepTimer) return; // already running
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);

    // Track disconnects to clean up state
    this.io.on('connection', (socket) => {
      this.onConnect(socket.id);

      socket.on('disconnect', () => {
        this.onDisconnect(socket.id);
      });
    });
  }

  /**
   * Stop the sweep timer and clear all state.
   */
  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.states.clear();
  }

  // ── Activity tracking ───────────────────────────────────────────────────────

  /**
   * Record that a socket sent or received data.  Must be called by the
   * Socket.IO connection handler (or middleware) for idle detection to work.
   */
  recordActivity(socketId: string): void {
    const state = this.states.get(socketId);
    if (state) {
      state.lastActivityAt = Date.now();
    }
  }

  // ── Rate limiting ────────────────────────────────────────────────────────────

  /**
   * Check whether a socket is allowed to receive another event.
   *
   * Returns true  → event is allowed.
   * Returns false → event should be dropped (rate limit exceeded).
   */
  checkRateLimit(socketId: string): boolean {
    let state = this.states.get(socketId);

    if (!state) {
      // Unknown socket — initialise and allow
      state = this.createState();
      this.states.set(socketId, state);
    }

    return state.tokenBucket.tryConsume();
  }

  // ── Manual eviction (used by BackpressureObservability / admin) ─────────────

  /**
   * Forcibly disconnect a socket with the given reason.
   * Safe to call if the socket is already disconnected.
   */
  evictSocket(socketId: string, reason: EvictionReason): void {
    const socket = this.io.sockets.sockets.get(socketId);

    const userId = socket?.data?.userId as string | undefined;
    const bufferBytes = this.monitor.getClientBufferBytes(socketId);

    const record: EvictionRecord = {
      socketId,
      userId,
      reason,
      evictedAt: Date.now(),
      bufferBytes,
    };

    logger.warn('ClientEvictionManager: evicting socket', record);

    if (socket) {
      socket.disconnect(true);
    }

    this.states.delete(socketId);
    this.recordEviction(record);
  }

  /**
   * Returns the last N eviction records (most-recent first, capped at 100).
   */
  recentEvictions(n = 100): EvictionRecord[] {
    return this.evictionHistory.slice(-n).reverse();
  }

  // ── Connect / disconnect hooks ───────────────────────────────────────────────

  /** Called when a new socket connects. */
  onConnect(socketId: string): void {
    this.states.set(socketId, this.createState());
  }

  /** Called when a socket disconnects (client-initiated or server-initiated). */
  onDisconnect(socketId: string): void {
    this.states.delete(socketId);
  }

  // ── Sweep ────────────────────────────────────────────────────────────────────

  /**
   * Periodic sweep: checks every tracked socket for slow or idle conditions.
   */
  private sweep(): void {
    const now = Date.now();
    const socketIds = [...this.states.keys()];

    for (const socketId of socketIds) {
      const state = this.states.get(socketId);
      if (!state) continue;

      // Ensure the socket is still connected (might have self-disconnected)
      if (!this.io.sockets.sockets.has(socketId)) {
        this.states.delete(socketId);
        continue;
      }

      // ── Slow-client check ─────────────────────────────────────────────────
      const isBackpressured = this.monitor.isClientBackpressured(socketId);

      if (isBackpressured) {
        if (state.slowSince === null) {
          state.slowSince = now;
        } else if (now - state.slowSince >= this.slowSustainMs) {
          this.evictSocket(socketId, 'slow_client');
          continue;
        }
      } else {
        // Buffer has cleared — reset slow timer
        state.slowSince = null;
      }

      // ── Idle-client check ─────────────────────────────────────────────────
      if (now - state.lastActivityAt >= this.idleTimeoutMs) {
        this.evictSocket(socketId, 'idle_client');
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private createState(): SocketState {
    return {
      slowSince:      null,
      lastActivityAt: Date.now(),
      tokenBucket:    new TokenBucket(this.eventsPerSecond),
    };
  }

  private recordEviction(record: EvictionRecord): void {
    this.evictionHistory.push(record);
    if (this.evictionHistory.length > 1000) {
      this.evictionHistory.shift();
    }
  }
}
