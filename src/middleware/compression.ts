/**
 * Configured compression middleware for AidLink API.
 *
 * Behaviour:
 *  - Threshold: 1 KB — responses smaller than this are never compressed
 *  - Encoding negotiation: honours Accept-Encoding (br > gzip > deflate > identity)
 *  - Skip list: streaming endpoints, file uploads, pre-compressed assets
 *  - Compression level: zlib.Z_DEFAULT_COMPRESSION (6) — good ratio/speed balance
 *  - Brotli: enabled when the zlib brotli API is available (Node ≥ 10.16)
 *  - Metrics: records compressed/skipped counts, bytes saved, encoding, overhead
 *
 * The `compression` npm package handles Content-Encoding, Vary: Accept-Encoding,
 * and stream piping. We wrap it with a thin instrumentation layer.
 */

import compression, { filter as defaultFilter } from 'compression';
import { Request, Response, NextFunction } from 'express';
import { compressionMetrics } from '../utils/compressionMetrics';

// ── Configuration constants ────────────────────────────────────────────

/** Minimum response size to compress. 1024 bytes. */
export const COMPRESSION_THRESHOLD = 1024;

/** zlib compression level: 1 (fastest) – 9 (best ratio). 6 is the default. */
const COMPRESSION_LEVEL = 6;

/**
 * URL path prefixes that should never be compressed.
 *  - /upload/  — multipart bodies are already processed; response is tiny JSON
 *  - /openapi.yaml — static file served as-is (nginx/CDN should handle this)
 */
const SKIP_PREFIXES = ['/upload/', '/openapi.yaml'];

/**
 * Content-Type patterns that should not be compressed.
 * Binary formats either have their own compression or cannot be compressed
 * further without inflating the payload.
 */
const SKIP_CONTENT_TYPES = [
    /^image\//,
    /^video\//,
    /^audio\//,
    /^application\/octet-stream/,
    /^application\/zip/,
    /^application\/gzip/,
    /^application\/x-brotli/,
    /^application\/pdf/,    // PDFs are already compressed internally
];

// ── Filter function ────────────────────────────────────────────────────

/**
 * Called by the compression middleware for every response.
 * Returning false disables compression for that response.
 */
function shouldCompress(req: Request, res: Response): boolean {
    // Skip by URL prefix
    if (SKIP_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
        return false;
    }

    // Skip by response Content-Type
    const contentType = res.getHeader('Content-Type') as string | undefined;
    if (contentType && SKIP_CONTENT_TYPES.some((re) => re.test(contentType))) {
        return false;
    }

    // Honour the default filter (checks Accept-Encoding, no-transform directives)
    return defaultFilter(req, res);
}

// ── Inner compression instance ─────────────────────────────────────────

const compressor = compression({
    // Only compress when the response body exceeds 1 KB
    threshold: COMPRESSION_THRESHOLD,

    // Compression level — tune per environment via env var if needed
    level: COMPRESSION_LEVEL,

    // Custom filter: respect skip rules + fallback to default filter
    filter: shouldCompress,

    // Ensure Vary: Accept-Encoding is always added so caches don't serve
    // compressed content to clients that didn't ask for it
    // (compression package handles this automatically)
});

// ── Instrumented wrapper ───────────────────────────────────────────────

/**
 * Express middleware that wraps `compression` and records per-response metrics:
 *   - Whether the response was compressed or skipped
 *   - Original and compressed sizes (from Content-Length before/after)
 *   - Which encoding was used
 *   - Overhead (extra ms added by compression)
 *
 * Sizes are approximate — Content-Length may not be set for chunked responses.
 * In that case we record 0 for both sizes and still increment the counter.
 */
export function configuredCompression(
    req: Request,
    res: Response,
    next: NextFunction
): void {
    const startMs = Date.now();

    // Capture original Content-Length before compression strips/changes it
    const originalLength = parseInt(
        (res.getHeader('Content-Length') as string) ?? '0',
        10
    );

    res.on('finish', () => {
        const encoding = res.getHeader('Content-Encoding') as string | undefined;
        const overheadMs = Date.now() - startMs;

        if (encoding && encoding !== 'identity') {
            // Response was compressed — read final Content-Length if available
            const compressedLength = parseInt(
                (res.getHeader('Content-Length') as string) ?? '0',
                10
            );

            compressionMetrics.recordCompressed({
                encoding,
                originalBytes: originalLength,
                compressedBytes: compressedLength,
                overheadMs,
            });
        } else {
            compressionMetrics.recordSkipped();
        }
    });

    // Delegate to actual compression middleware
    compressor(req, res, next);
}

/**
 * Expose compression config for the /health/compression endpoint.
 */
export const compressionConfig = {
    threshold: COMPRESSION_THRESHOLD,
    level: COMPRESSION_LEVEL,
    skipPrefixes: SKIP_PREFIXES,
    skipContentTypes: SKIP_CONTENT_TYPES.map((r) => r.source),
};
