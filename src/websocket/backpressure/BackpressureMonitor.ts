/**
 * BackpressureMonitor
 *
 * Monitors Socket.IO send-buffer sizes at three levels:
 *   • per-client  (individual socket sendBuffer)
 *   • per-room    (sum of all sockets in a given room)
 *   • global      (sum across every connected socket)
 *
 * Socket.IO uses `socket.client.conn.sendBuffer` (an array of Buffer / string
 * frames) as its outbound queue.  We measure the total byte-length of that
 * array as a proxy for memory pressure.
 *
 * The monitor exposes three signals:
 *   isClientBackpressured(socketId)  →  boolean
 *   isRoomBackpressured(room)        →  boolean
 *   isGlobalBackpressured()          →  boolean
 *
 * All thresholds are configurable via environment variables and can be
 * overridden at construction time for unit tests.
 *
 * Performance constraint: a single call to any of the public methods must
 * complete in < 1 ms for typical room sizes (< 10 k sockets).  The
 * implementation is O(n) in the number of sockets in the room / server and
 * uses only synchronous in-process data structures.
 */

import { Server as SocketIOServer } from 'socket.io';
import { config } from '../../config';

// ── Threshold defaults (bytes) ────────────────────────────────────────────────

const DEFAULT_CLIENT_THRESHOLD_BYTES = parseInt(
  process.env.WS_BP_CLIENT_THRESHOLD_BYTES ?? '1048576', // 1 MB
  10,
);

const DEFAULT_ROOM_THRESHOLD_BYTES = parseInt(
  process.env.WS_BP_ROOM_THRESHOLD_BYTES ?? '10485760', // 10 MB
  10,
);

const DEFAULT_GLOBAL_THRESHOLD_BYTES = parseInt(
  process.env.WS_BP_GLOBAL_THRESHOLD_BYTES ?? '104857600', // 100 MB
  10,
);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BackpressureThresholds {
  /** Bytes in a single client's send buffer before it is considered slow. */
  clientBytes: number;
  /** Sum of all send buffers in a room before the room is throttled. */
  roomBytes: number;
  /** Total sum across all connected sockets before global throttling. */
  globalBytes: number;
}

export interface ClientBufferStats {
  socketId: string;
  bufferBytes: number;
  backpressured: boolean;
}

export interface RoomBufferStats {
  room: string;
  totalBytes: number;
  socketCount: number;
  backpressured: boolean;
}

export interface GlobalBufferStats {
  totalBytes: number;
  socketCount: number;
  backpressured: boolean;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class BackpressureMonitor {
  private readonly io: SocketIOServer;
  private readonly thresholds: BackpressureThresholds;

  /**
   * Optional injection hook for unit tests: when set, getClientBufferBytes()
   * returns the injected value instead of reading the real socket buffer.
   *
   * Map<socketId, bufferBytes>
   */
  private _mockBuffers?: Map<string, number>;

  constructor(io: SocketIOServer, thresholds?: Partial<BackpressureThresholds>) {
    this.io = io;
    this.thresholds = {
      clientBytes: thresholds?.clientBytes ?? DEFAULT_CLIENT_THRESHOLD_BYTES,
      roomBytes: thresholds?.roomBytes ?? DEFAULT_ROOM_THRESHOLD_BYTES,
      globalBytes: thresholds?.globalBytes ?? DEFAULT_GLOBAL_THRESHOLD_BYTES,
    };
  }

  // ── Public query API ────────────────────────────────────────────────────────

  /**
   * Returns true if the named socket's send buffer exceeds the client
   * threshold.  Returns false for unknown socket IDs.
   */
  isClientBackpressured(socketId: string): boolean {
    return this.getClientBufferBytes(socketId) >= this.thresholds.clientBytes;
  }

  /**
   * Returns true if the total send buffer for all sockets in `room` exceeds
   * the room threshold.
   */
  isRoomBackpressured(room: string): boolean {
    return this.getRoomBufferStats(room).backpressured;
  }

  /**
   * Returns true if the total send buffer across all connected sockets
   * exceeds the global threshold.
   */
  isGlobalBackpressured(): boolean {
    return this.getGlobalBufferStats().backpressured;
  }

  // ── Stats helpers ───────────────────────────────────────────────────────────

  /** Per-client stats for a specific socket. */
  getClientStats(socketId: string): ClientBufferStats {
    const bufferBytes = this.getClientBufferBytes(socketId);
    return {
      socketId,
      bufferBytes,
      backpressured: bufferBytes >= this.thresholds.clientBytes,
    };
  }

  /** Aggregated stats for a specific room. */
  getRoomBufferStats(room: string): RoomBufferStats {
    const socketIds = this.io.sockets.adapter.rooms.get(room) ?? new Set<string>();
    let totalBytes = 0;

    for (const socketId of socketIds) {
      totalBytes += this.getClientBufferBytes(socketId);
    }

    return {
      room,
      totalBytes,
      socketCount: socketIds.size,
      backpressured: totalBytes >= this.thresholds.roomBytes,
    };
  }

  /** Aggregated stats across all connected sockets. */
  getGlobalBufferStats(): GlobalBufferStats {
    const sockets = this.io.sockets.sockets;
    let totalBytes = 0;

    for (const [socketId] of sockets) {
      totalBytes += this.getClientBufferBytes(socketId);
    }

    return {
      totalBytes,
      socketCount: sockets.size,
      backpressured: totalBytes >= this.thresholds.globalBytes,
    };
  }

  /**
   * Returns the current thresholds (useful for logging / observability).
   */
  getThresholds(): Readonly<BackpressureThresholds> {
    return { ...this.thresholds };
  }

  // ── Test helpers ─────────────────────────────────────────────────────────────

  /**
   * Inject mock buffer sizes for unit tests.  When set, real socket buffers
   * are not read.
   *
   * @param buffers  Map from socketId → buffer bytes.  Pass `undefined` to
   *                 clear injection and revert to real socket buffers.
   */
  injectMockBuffers(buffers: Map<string, number> | undefined): void {
    this._mockBuffers = buffers;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Returns the byte length of a socket's outbound send buffer.
   *
   * Socket.IO stores pending frames in `socket.client.conn.sendBuffer` — an
   * `Array<Buffer | string>`.  We iterate the array and sum byte lengths.
   * This is O(frames) but frames are typically few; the array length grows
   * only when the client is genuinely slow.
   *
   * For unknown / already-disconnected sockets we return 0 safely.
   */
  getClientBufferBytes(socketId: string): number {
    // Test injection takes priority.
    if (this._mockBuffers) {
      return this._mockBuffers.get(socketId) ?? 0;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) return 0;

    // socket.client.conn is the underlying engine.io socket.
    // sendBuffer is an array of pending frames (Buffer | string).
    // We access it via a cast because it is not in the public TS types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = (socket as any).client?.conn;
    if (!conn) return 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendBuffer: Array<any> = conn.sendBuffer ?? [];
    let bytes = 0;

    for (const frame of sendBuffer) {
      if (Buffer.isBuffer(frame)) {
        bytes += frame.byteLength;
      } else if (typeof frame === 'string') {
        bytes += Buffer.byteLength(frame, 'utf8');
      } else if (frame && typeof frame === 'object') {
        // engine.io wraps frames in objects with a `data` property
        const data = frame.data;
        if (Buffer.isBuffer(data)) {
          bytes += data.byteLength;
        } else if (typeof data === 'string') {
          bytes += Buffer.byteLength(data, 'utf8');
        }
      }
    }

    return bytes;
  }
}
