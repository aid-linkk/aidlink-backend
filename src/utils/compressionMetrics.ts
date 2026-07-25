/**
 * In-process compression metrics collector.
 *
 * Tracks how many responses were compressed vs skipped, bytes saved,
 * and a ratio histogram so you can see the distribution of savings.
 * All counters are per-process and reset on restart (or on demand).
 * Designed for the /health/compression endpoint and request logger.
 */

export interface CompressionSnapshot {
    since: string;
    uptimeMs: number;
    total: number;
    compressed: number;
    skipped: number;
    compressionRate: number;           // fraction of total responses that were compressed
    bytesIn: number;                   // sum of original sizes (compressed responses only)
    bytesOut: number;                  // sum of compressed sizes
    bytesSaved: number;
    avgRatio: number;                  // avgRatio < 1 means compression helped
    encodingCounts: Record<string, number>; // gzip | br | deflate | identity
    /** Histogram buckets: ratio ≤ 0.3 | ≤ 0.5 | ≤ 0.7 | ≤ 0.9 | > 0.9 */
    ratioHistogram: Record<string, number>;
    /** Fastest/slowest overhead — difference in ms added by compression */
    overheadMs: { avg: number; p95: number; max: number };
}

const RATIO_BUCKETS = [0.3, 0.5, 0.7, 0.9] as const;

function emptyHistogram(): Record<string, number> {
    return {
        '<=0.30': 0,
        '<=0.50': 0,
        '<=0.70': 0,
        '<=0.90': 0,
        '>0.90': 0,
    };
}

const OVERHEAD_SAMPLE_SIZE = 500;

class CompressionMetrics {
    private startedAt = Date.now();
    private total = 0;
    private compressed = 0;
    private skipped = 0;
    private bytesIn = 0;
    private bytesOut = 0;
    private ratioSum = 0;
    private encodingCounts: Record<string, number> = {};
    private ratioHistogram = emptyHistogram();

    // Ring buffer for compression overhead measurements
    private overheadSamples = new Float32Array(OVERHEAD_SAMPLE_SIZE);
    private overheadCursor = 0;
    private overheadCount = 0;
    private overheadMax = 0;

    recordCompressed(opts: {
        encoding: string;
        originalBytes: number;
        compressedBytes: number;
        overheadMs: number;
    }): void {
        this.total++;
        this.compressed++;
        this.bytesIn += opts.originalBytes;
        this.bytesOut += opts.compressedBytes;

        const ratio = opts.originalBytes > 0 ? opts.compressedBytes / opts.originalBytes : 1;
        this.ratioSum += ratio;

        // Encoding tally
        const enc = opts.encoding || 'identity';
        this.encodingCounts[enc] = (this.encodingCounts[enc] ?? 0) + 1;

        // Ratio histogram
        if (ratio <= 0.30) this.ratioHistogram['<=0.30']++;
        else if (ratio <= 0.50) this.ratioHistogram['<=0.50']++;
        else if (ratio <= 0.70) this.ratioHistogram['<=0.70']++;
        else if (ratio <= 0.90) this.ratioHistogram['<=0.90']++;
        else this.ratioHistogram['>0.90']++;

        // Overhead ring buffer
        this.overheadSamples[this.overheadCursor] = opts.overheadMs;
        this.overheadCursor = (this.overheadCursor + 1) % OVERHEAD_SAMPLE_SIZE;
        if (this.overheadCount < OVERHEAD_SAMPLE_SIZE) this.overheadCount++;
        if (opts.overheadMs > this.overheadMax) this.overheadMax = opts.overheadMs;
    }

    recordSkipped(): void {
        this.total++;
        this.skipped++;
    }

    snapshot(): CompressionSnapshot {
        const now = Date.now();
        const sorted = Array.from(this.overheadSamples.slice(0, this.overheadCount)).sort((a, b) => a - b);
        const p95idx = Math.ceil(0.95 * sorted.length) - 1;

        return {
            since: new Date(this.startedAt).toISOString(),
            uptimeMs: now - this.startedAt,
            total: this.total,
            compressed: this.compressed,
            skipped: this.skipped,
            compressionRate: this.total === 0 ? 0 : round(this.compressed / this.total, 3),
            bytesIn: this.bytesIn,
            bytesOut: this.bytesOut,
            bytesSaved: this.bytesIn - this.bytesOut,
            avgRatio: this.compressed === 0 ? 1 : round(this.ratioSum / this.compressed, 3),
            encodingCounts: { ...this.encodingCounts },
            ratioHistogram: { ...this.ratioHistogram },
            overheadMs: {
                avg: sorted.length === 0 ? 0 : round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
                p95: sorted.length === 0 ? 0 : round(sorted[Math.max(0, p95idx)]),
                max: round(this.overheadMax),
            },
        };
    }

    reset(): void {
        this.startedAt = Date.now();
        this.total = 0;
        this.compressed = 0;
        this.skipped = 0;
        this.bytesIn = 0;
        this.bytesOut = 0;
        this.ratioSum = 0;
        this.encodingCounts = {};
        this.ratioHistogram = emptyHistogram();
        this.overheadSamples = new Float32Array(OVERHEAD_SAMPLE_SIZE);
        this.overheadCursor = 0;
        this.overheadCount = 0;
        this.overheadMax = 0;
    }
}

function round(n: number, decimals = 2): number {
    const f = 10 ** decimals;
    return Math.round(n * f) / f;
}

// Singleton — imported wherever metrics need to be read or recorded
export const compressionMetrics = new CompressionMetrics();
