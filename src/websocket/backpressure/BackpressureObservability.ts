/**
 * BackpressureObservability
 *
 * Collects and periodically logs metrics for the backpressure system:
 *
 *   • Per-room queue sizes and backpressure state
 *   • Global buffer stats
 *   • FlowController emit/queue/drop/coalesce counters
 *   • Eviction history summary
 *
 * Logging is structured JSON (Winston), at INFO level for periodic snapshots
 * and WARN when any threshold is exceeded.
 *
 * The class also accumulates a rolling window of snapshots that can be
 * retrieved programmatically (e.g., for a health endpoint or admin dashboard).
 */

import { Server as SocketIOServer } from 'socket.io';
import { BackpressureMonitor } from './BackpressureMonitor';
import { FlowController }       from './FlowController';
import { ClientEvictionManager } from './ClientEvictionManager';
import logger from '../../config/logger';

// ── Configuration defaults ─────────────────────────────────────────────────────

const DEFAULT_REPORT_INTERVAL_MS = parseInt(
  process.env.WS_OBS_REPORT_INTERVAL_MS ?? '15000', // 15 s
  10,
);

const DEFAULT_SNAPSHOT_WINDOW = parseInt(
  process.env.WS_OBS_SNAPSHOT_WINDOW ?? '20',
  10,
);

// ── Types ──────────────────────────────────────────────────────────────────────

export interface BackpressureSnapshot {
  timestamp: number;
  global: {
    totalBufferBytes: number;
    socketCount:      number;
    backpressured:    boolean;
  };
  rooms: Array<{
    room:          string;
    totalBytes:    number;
    socketCount:   number;
    backpressured: boolean;
  }>;
  flowController: {
    totalEmitted:   number;
    totalQueued:    number;
    totalDropped:   number;
    totalCoalesced: number;
    activeRooms:    number;
  };
  recentEvictions: number;
}

export interface BackpressureObservabilityOptions {
  reportIntervalMs?: number;
  snapshotWindow?:   number;
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class BackpressureObservability {
  private readonly io:      SocketIOServer;
  private readonly monitor: BackpressureMonitor;
  private readonly flow:    FlowController;
  private readonly eviction: ClientEvictionManager;

  private readonly reportIntervalMs: number;
  private readonly snapshotWindow:   number;

  private readonly snapshots: BackpressureSnapshot[] = [];
  private reportTimer: NodeJS.Timeout | null = null;

  constructor(
    io: SocketIOServer,
    monitor: BackpressureMonitor,
    flow: FlowController,
    eviction: ClientEvictionManager,
    options?: BackpressureObservabilityOptions,
  ) {
    this.io              = io;
    this.monitor         = monitor;
    this.flow            = flow;
    this.eviction        = eviction;
    this.reportIntervalMs = options?.reportIntervalMs ?? DEFAULT_REPORT_INTERVAL_MS;
    this.snapshotWindow   = options?.snapshotWindow   ?? DEFAULT_SNAPSHOT_WINDOW;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  start(): void {
    if (this.reportTimer) return;
    this.reportTimer = setInterval(() => this.report(), this.reportIntervalMs);
  }

  destroy(): void {
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
  }

  // ── On-demand snapshot ───────────────────────────────────────────────────────

  /**
   * Capture and return a current snapshot without logging.
   * Useful for health endpoints or test assertions.
   */
  captureSnapshot(): BackpressureSnapshot {
    const globalStats = this.monitor.getGlobalBufferStats();
    const flowStats   = this.flow.getStats();

    // Collect stats for every active room
    const roomSet = this.io.sockets.adapter.rooms;
    const rooms: BackpressureSnapshot['rooms'] = [];

    for (const [roomName] of roomSet) {
      // Skip personal user rooms and socket-local rooms (same id as socket)
      if (this.io.sockets.sockets.has(roomName)) continue;

      const roomStats = this.monitor.getRoomBufferStats(roomName);
      rooms.push({
        room:          roomName,
        totalBytes:    roomStats.totalBytes,
        socketCount:   roomStats.socketCount,
        backpressured: roomStats.backpressured,
      });
    }

    const snapshot: BackpressureSnapshot = {
      timestamp: Date.now(),
      global: {
        totalBufferBytes: globalStats.totalBytes,
        socketCount:      globalStats.socketCount,
        backpressured:    globalStats.backpressured,
      },
      rooms,
      flowController: {
        totalEmitted:   flowStats.totalEmitted,
        totalQueued:    flowStats.totalQueued,
        totalDropped:   flowStats.totalDropped,
        totalCoalesced: flowStats.totalCoalesced,
        activeRooms:    flowStats.activeRooms,
      },
      recentEvictions: this.eviction.recentEvictions(10).length,
    };

    return snapshot;
  }

  /**
   * Returns the last N snapshots (most-recent first).
   */
  getSnapshots(n?: number): BackpressureSnapshot[] {
    const window = n ?? this.snapshotWindow;
    return this.snapshots.slice(-window).reverse();
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private report(): void {
    const snapshot = this.captureSnapshot();

    // Store in rolling window
    this.snapshots.push(snapshot);
    if (this.snapshots.length > this.snapshotWindow) {
      this.snapshots.shift();
    }

    const level = snapshot.global.backpressured ? 'warn' : 'info';

    logger[level]('ws:backpressure:snapshot', {
      global:            snapshot.global,
      backpressuredRooms: snapshot.rooms.filter((r) => r.backpressured).length,
      totalRooms:        snapshot.rooms.length,
      flowController:    snapshot.flowController,
      recentEvictions:   snapshot.recentEvictions,
    });

    // Log individual rooms that are backpressured
    for (const room of snapshot.rooms) {
      if (room.backpressured) {
        logger.warn('ws:backpressure:room', {
          room:        room.room,
          totalBytes:  room.totalBytes,
          socketCount: room.socketCount,
        });
      }
    }
  }
}
