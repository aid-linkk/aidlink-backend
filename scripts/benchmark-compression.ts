#!/usr/bin/env ts-node
/**
 * Compression benchmark script
 *
 * Measures gzip / brotli / no-compression response time and size for a set
 * of real API endpoints, then prints a side-by-side comparison table.
 *
 * Usage:
 *   ts-node scripts/benchmark-compression.ts [--host http://localhost:3000] [--token <jwt>] [--slow]
 *
 * --slow   simulates a 56 kbps connection by computing theoretical transfer
 *          times at that bandwidth for each response size
 *
 * The script does NOT require an active server if BENCHMARK_MOCK=true is set —
 * in that case it generates synthetic JSON payloads of increasing sizes and
 * benchmarks only the compression ratio and overhead (no HTTP round-trip).
 */

import http from 'http';
import https from 'https';
import zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

// ── CLI args ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const host = args[args.indexOf('--host') + 1] ?? 'http://localhost:3000';
const token = args[args.indexOf('--token') + 1] ?? '';
const slow = args.includes('--slow');
const mock = process.env.BENCHMARK_MOCK === 'true';

// 56 kbps in bytes/ms
const SLOW_CONNECTION_BYTES_PER_MS = (56 * 1024) / 8 / 1000;

// ── Endpoints to benchmark ─────────────────────────────────────────────

const ENDPOINTS = [
    { label: 'GET /health', path: '/health', auth: false },
    { label: 'GET /health/compression', path: '/health/compression', auth: false },
    { label: 'GET campaigns list', path: '/api/v1/campaigns?limit=50', auth: true },
    { label: 'GET beneficiaries list', path: '/api/v1/beneficiaries?limit=50', auth: true },
    { label: 'GET distributions list', path: '/api/v1/distributions?limit=50', auth: true },
    { label: 'GET notifications', path: '/api/v1/notifications?limit=50', auth: true },
    { label: 'GET admin dashboard', path: '/api/v1/admin/dashboard', auth: true },
    { label: 'GET analytics', path: '/api/v1/analytics/campaigns', auth: true },
];

// Synthetic payload sizes (bytes) for mock mode
const MOCK_SIZES = [256, 512, 1024, 4096, 16384, 65536, 262144];

// ── HTTP helper ────────────────────────────────────────────────────────

interface FetchResult {
    statusCode: number;
    encoding: string;
    bodyLength: number;
    durationMs: number;
    body: Buffer;
}

function fetchUrl(url: string, acceptEncoding: string, authToken: string): Promise<FetchResult> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? https : http;

        const start = Date.now();
        const req = lib.request(
            {
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers: {
                    'Accept-Encoding': acceptEncoding,
                    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    const body = Buffer.concat(chunks);
                    resolve({
                        statusCode: res.statusCode ?? 0,
                        encoding: (res.headers['content-encoding'] ?? 'identity') as string,
                        bodyLength: body.length,
                        durationMs: Date.now() - start,
                        body,
                    });
                });
            }
        );
        req.on('error', reject);
        req.setTimeout(10_000, () => { req.destroy(new Error('timeout')); });
        req.end();
    });
}

// ── Formatting helpers ─────────────────────────────────────────────────

function fmt(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtMs(ms: number): string { return `${ms.toFixed(1)}ms`; }

function slowTime(bytes: number): string {
    if (!slow) return '-';
    return `${(bytes / SLOW_CONNECTION_BYTES_PER_MS).toFixed(0)}ms`;
}

function ratio(original: number, compressed: number): string {
    if (original === 0) return 'n/a';
    return `${((1 - compressed / original) * 100).toFixed(1)}% saved`;
}

function pad(s: string | number, width: number): string {
    return String(s).padEnd(width);
}

// ── Benchmark: live HTTP mode ──────────────────────────────────────────

async function benchmarkLive(): Promise<void> {
    console.log(`\nBenchmarking compression against ${host}\n`);

    const colW = [38, 10, 10, 10, 14, 14, 14];
    const header = [
        'Endpoint', 'Status', 'None', 'Gzip', 'Gzip ratio', 'Slow(none)', 'Slow(gzip)',
    ];
    console.log(header.map((h, i) => pad(h, colW[i])).join(' | '));
    console.log('-'.repeat(colW.reduce((a, b) => a + b + 3, 0)));

    for (const ep of ENDPOINTS) {
        if (ep.auth && !token) {
            console.log(`${pad(ep.label, colW[0])} | (skipped — no --token)`);
            continue;
        }

        try {
            const url = `${host}${ep.path}`;
            const [plain, gzipped] = await Promise.all([
                fetchUrl(url, 'identity', ep.auth ? token : ''),
                fetchUrl(url, 'gzip, br', ep.auth ? token : ''),
            ]);

            const row = [
                ep.label,
                plain.statusCode,
                fmt(plain.bodyLength),
                fmt(gzipped.bodyLength),
                ratio(plain.bodyLength, gzipped.bodyLength),
                slowTime(plain.bodyLength),
                slowTime(gzipped.bodyLength),
            ];
            console.log(row.map((c, i) => pad(c, colW[i])).join(' | '));
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`${pad(ep.label, colW[0])} | ERROR: ${msg}`);
        }
    }
}

// ── Benchmark: mock / offline mode ────────────────────────────────────

async function benchmarkMock(): Promise<void> {
    console.log('\nCompression benchmark (mock mode — no HTTP round-trip)\n');

    const colW = [12, 10, 10, 12, 10, 12, 14];
    const header = ['Size', 'Gzip', 'Brotli', 'Gzip%', 'Br%', 'Gzip ms', 'Brotli ms'];
    console.log(header.map((h, i) => pad(h, colW[i])).join(' | '));
    console.log('-'.repeat(colW.reduce((a, b) => a + b + 3, 0)));

    for (const size of MOCK_SIZES) {
        // Generate realistic JSON: nested object with repeated keys (good compressibility)
        const obj = {
            data: Array.from({ length: Math.ceil(size / 80) }, (_, i) => ({
                id: `cuid${i}`, title: 'Campaign title example', status: 'ACTIVE',
                amount: (Math.random() * 10000).toFixed(8), createdAt: new Date().toISOString(),
            }))
        };
        const payload = Buffer.from(JSON.stringify(obj));

        const t0g = Date.now();
        const gz = await gzip(payload, { level: 6 });
        const gzMs = Date.now() - t0g;

        const t0b = Date.now();
        const br = await brotli(payload, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
        const brMs = Date.now() - t0b;

        // Skip if below threshold — mirrors real middleware behaviour
        const belowThreshold = payload.length < 1024;
        const skip = belowThreshold ? ' (skip)' : '';

        const row = [
            fmt(payload.length) + skip,
            belowThreshold ? '-' : fmt(gz.length),
            belowThreshold ? '-' : fmt(br.length),
            belowThreshold ? '-' : ratio(payload.length, gz.length),
            belowThreshold ? '-' : ratio(payload.length, br.length),
            belowThreshold ? '-' : fmtMs(gzMs),
            belowThreshold ? '-' : fmtMs(brMs),
        ];
        console.log(row.map((c, i) => pad(c, colW[i])).join(' | '));
    }

    console.log('\n1 KB threshold: responses below this size are not compressed.');
}

// ── Main ───────────────────────────────────────────────────────────────

(async () => {
    try {
        if (mock) {
            await benchmarkMock();
        } else {
            await benchmarkLive();
        }
        console.log('\nDone.\n');
    } catch (err) {
        console.error('Benchmark failed:', err);
        process.exit(1);
    }
})();
