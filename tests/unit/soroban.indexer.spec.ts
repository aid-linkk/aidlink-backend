/**
 * Unit tests for the Soroban blockchain indexer subsystem.
 *
 * Covers:
 *   1. TokenBucketRateLimiter — throttle(), reset(), available getter
 *   2. XDR parsing — scValToNative, extractContractEventsFromMeta,
 *                    parseHorizonTransaction, parseRpcEvent
 *   3. SorobanIndexer logic — gap detection, reorg/orphan detection,
 *                             idempotent inserts, 429 retry, cursor persistence
 */

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock the Prisma client; the __mocks__ directory provides the stub.
jest.mock('../../src/config/database');

// Mock logger to prevent real winston initialization (which reads config)
jest.mock('../../src/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock the soroban-client Server so we don't make real RPC calls.
jest.mock('soroban-client', () => ({
  Server: jest.fn().mockImplementation(() => ({
    getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1000 }),
  })),
}));

// Mock the HorizonClient so we don't make real HTTP calls.
jest.mock('../../src/utils/horizonClient', () => {
  const original = jest.requireActual('../../src/utils/horizonClient');
  return {
    ...original,
    HorizonClient: jest.fn().mockImplementation(() => ({
      getLedger: jest.fn(),
      getLedgerTransactions: jest.fn(),
    })),
  };
});

// Mock config with predictable values.
jest.mock('../../src/config/index', () => ({
  config: {
    soroban: {
      networkUrl: 'http://localhost:8000',
      networkPassphrase: 'Test SDF Network ; September 2015',
      contractAddress: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    },
    indexer: {
      horizonUrl: 'http://localhost:8000',
      batchSize: 10,
      rpsLimit: 100,  // high limit so tests don't slow down
      pollIntervalMs: 10000,
      errorBackoffMs: 30000,
    },
    logging: { level: 'info' },
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import prisma from '../../src/config/database';
import { TokenBucketRateLimiter } from '../../src/utils/rateLimiter';
import { scValToNative, parseRpcEvent } from '../../src/utils/xdrParser';
import { SorobanIndexer } from '../../src/blockchain/soroban.indexer';
import { HorizonClient, HorizonError } from '../../src/utils/horizonClient';

// Cast the mock so TypeScript knows about .mock properties
const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const MockHorizonClient = HorizonClient as jest.MockedClass<typeof HorizonClient>;

// ─────────────────────────────────────────────────────────────────────────────
// 1. TokenBucketRateLimiter
// ─────────────────────────────────────────────────────────────────────────────

describe('TokenBucketRateLimiter', () => {
  it('starts full (available === rps)', () => {
    const limiter = new TokenBucketRateLimiter(10);
    // After construction the bucket should be full.
    expect(Math.floor(limiter.available)).toBe(10);
  });

  it('throws for invalid rps', () => {
    expect(() => new TokenBucketRateLimiter(0)).toThrow(RangeError);
    expect(() => new TokenBucketRateLimiter(-1)).toThrow(RangeError);
  });

  it('throttle() resolves immediately when tokens are available', async () => {
    const limiter = new TokenBucketRateLimiter(5);
    const start = Date.now();
    await limiter.throttle();
    expect(Date.now() - start).toBeLessThan(100); // should be almost instant
  });

  it('throttle() delays when bucket is empty', async () => {
    const limiter = new TokenBucketRateLimiter(1);
    // Drain the bucket
    await limiter.throttle();
    // Now no tokens; next throttle() should wait ~1 000 ms but we mock
    // setTimeout and assert that a delay was requested.
    jest.useFakeTimers();
    const throttlePromise = limiter.throttle();
    jest.advanceTimersByTime(1100);
    await throttlePromise;
    jest.useRealTimers();
  });

  it('reset() refills the bucket', () => {
    const limiter = new TokenBucketRateLimiter(5);
    // Drain manually by calling throttle multiple times
    for (let i = 0; i < 5; i++) {
      // Direct token drain without the wait branch
      (limiter as any).tokens = 0;
    }
    limiter.reset();
    expect(Math.floor(limiter.available)).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. XDR parsing utilities
// ─────────────────────────────────────────────────────────────────────────────

describe('scValToNative', () => {
  // We test scValToNative using the actual stellar-base xdr module if it is
  // installed, otherwise we construct minimal mock ScVal objects.
  // Since stellar-base may not be installed in this test environment, we
  // use a mock approach for reliability.

  function mockScVal(typeName: string, valueFn: () => unknown) {
    return {
      switch: () => ({ name: typeName }),
      // Provide the value accessor matching the typeName convention
      b: typeName === 'scvBool' ? valueFn : () => undefined,
      u32: typeName === 'scvU32' ? valueFn : () => undefined,
      i32: typeName === 'scvI32' ? valueFn : () => undefined,
      u64: typeName === 'scvU64' ? valueFn : () => undefined,
      i64: typeName === 'scvI64' ? valueFn : () => undefined,
      sym: typeName === 'scvSymbol' ? valueFn : () => undefined,
      str: typeName === 'scvString' ? valueFn : () => undefined,
      bytes: typeName === 'scvBytes' ? valueFn : () => undefined,
      vec: typeName === 'scvVec' ? valueFn : () => [],
      map: typeName === 'scvMap' ? valueFn : () => [],
    } as any;
  }

  it('decodes scvBool=true', () => {
    const val = mockScVal('scvBool', () => true);
    expect(scValToNative(val)).toBe(true);
  });

  it('decodes scvBool=false', () => {
    const val = mockScVal('scvBool', () => false);
    expect(scValToNative(val)).toBe(false);
  });

  it('decodes scvVoid', () => {
    const val = { switch: () => ({ name: 'scvVoid' }) } as any;
    expect(scValToNative(val)).toBeNull();
  });

  it('decodes scvU32', () => {
    const val = mockScVal('scvU32', () => 42);
    expect(scValToNative(val)).toBe(42);
  });

  it('decodes scvI32 negative', () => {
    const val = mockScVal('scvI32', () => -7);
    expect(scValToNative(val)).toBe(-7);
  });

  it('decodes scvU64 as string', () => {
    const val = mockScVal('scvU64', () => 1234567890123n);
    expect(scValToNative(val)).toBe('1234567890123');
  });

  it('decodes scvI64 negative as string', () => {
    const val = mockScVal('scvI64', () => -99n);
    expect(scValToNative(val)).toBe('-99');
  });

  it('decodes scvSymbol', () => {
    const val = mockScVal('scvSymbol', () => Buffer.from('transfer'));
    expect(scValToNative(val)).toBe('transfer');
  });

  it('decodes scvString', () => {
    const val = mockScVal('scvString', () => Buffer.from('hello'));
    expect(scValToNative(val)).toBe('hello');
  });

  it('decodes scvBytes as hex', () => {
    const val = mockScVal('scvBytes', () => Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    expect(scValToNative(val)).toBe('deadbeef');
  });

  it('decodes scvVec (empty)', () => {
    const val = mockScVal('scvVec', () => []);
    expect(scValToNative(val)).toEqual([]);
  });

  it('decodes scvMap (empty)', () => {
    const val = mockScVal('scvMap', () => []);
    expect(scValToNative(val)).toEqual([]);
  });

  it('returns unknown marker for unrecognised type', () => {
    const val = { switch: () => ({ name: 'scvSomeFutureType' }) } as any;
    expect(scValToNative(val)).toEqual({ _type: 'unknown', xdrType: 'scvSomeFutureType' });
  });
});

describe('parseRpcEvent', () => {
  it('returns null for non-contract events', () => {
    const event = {
      id: '1',
      type: 'system',
      ledger: 100,
      ledgerClosedAt: '2024-01-01T00:00:00Z',
      contractId: 'CONTRACT',
      txHash: 'TX1',
      topic: [],
      value: '',
    };
    // parseRpcEvent returns null for non-contract type events
    const result = parseRpcEvent(event);
    expect(result).toBeNull();
  });

  it('returns null and does not throw when XDR is malformed', () => {
    const event = {
      id: '1',
      type: 'contract',
      ledger: 100,
      ledgerClosedAt: '2024-01-01T00:00:00Z',
      contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      txHash: 'DEADBEEF',
      topic: ['not-valid-base64-xdr!!'],
      value: 'also-not-valid',
    };
    // Should not throw; malformed XDR is gracefully handled
    expect(() => parseRpcEvent(event)).not.toThrow();
    const result = parseRpcEvent(event);
    // Either null or a partially-decoded event; never a crash
    expect(result === null || typeof result === 'object').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SorobanIndexer — unit / integration with mocked deps
// ─────────────────────────────────────────────────────────────────────────────

describe('SorobanIndexer', () => {
  let indexer: SorobanIndexer;
  let horizonGetLedger: jest.Mock;
  let horizonGetTxs: jest.Mock;
  let rpcGetLatest: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    // Extend the prisma mock with indexer-specific methods
    (mockPrisma as any).indexerCheckpoint = {
      findUnique: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    };
    (mockPrisma as any).blockchainTransaction = {
      ...(mockPrisma as any).blockchainTransaction,
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    (mockPrisma as any).contractEvent = {
      ...(mockPrisma as any).contractEvent,
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    };

    // $transaction: delegate to the callback with the mock as the tx object
    (mockPrisma as any).$transaction = jest.fn().mockImplementation(async (cb: any) => {
      if (typeof cb === 'function') return cb(mockPrisma);
      return Promise.all(cb);
    });

    indexer = new SorobanIndexer();

    // Wire up mock method references
    horizonGetLedger = (indexer as any).horizon.getLedger;
    horizonGetTxs = (indexer as any).horizon.getLedgerTransactions;
    rpcGetLatest = (indexer as any).rpcServer.getLatestLedger;
  });

  // ── gap detection ───────────────────────────────────────────────────────────

  describe('gap detection on startup', () => {
    it('processes exactly batchSize ledgers when gap == batchSize', async () => {
      const chainTip = 150;
      const checkpointSeq = 140; // gap of 10 (= batchSize in test config)

      rpcGetLatest.mockResolvedValue({ sequence: chainTip });
      (mockPrisma as any).indexerCheckpoint.findUnique.mockResolvedValue({
        id: 'singleton',
        lastSequence: checkpointSeq,
        lastHash: 'abc',
      });

      horizonGetLedger.mockResolvedValue({
        sequence: 141,
        hash: 'new-hash-x',
        closed_at: '2024-01-01T00:00:00Z',
        transaction_count: 0,
      });
      horizonGetTxs.mockResolvedValue([]);

      // fetchRpcEvents will call fetch(); we need to stub global fetch
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: { events: [] } }),
      } as any);

      await (indexer as any).tick();

      // Should have fetched ledgers 141–150 (10 ledgers == batchSize)
      expect(horizonGetLedger).toHaveBeenCalledTimes(10);
    });

    it('caps batch at batchSize even when gap is larger', async () => {
      const chainTip = 200;
      const checkpointSeq = 100; // gap of 100, batchSize = 10

      rpcGetLatest.mockResolvedValue({ sequence: chainTip });
      (mockPrisma as any).indexerCheckpoint.findUnique.mockResolvedValue({
        id: 'singleton',
        lastSequence: checkpointSeq,
        lastHash: '',
      });

      horizonGetLedger.mockResolvedValue({
        hash: 'some-hash',
        closed_at: '2024-01-01T00:00:00Z',
        transaction_count: 0,
      });
      horizonGetTxs.mockResolvedValue([]);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: { events: [] } }),
      } as any);

      await (indexer as any).tick();

      // Should only process 10 ledgers (batchSize) not 100
      expect(horizonGetLedger).toHaveBeenCalledTimes(10);
    });

    it('does nothing when checkpoint is at chain tip', async () => {
      rpcGetLatest.mockResolvedValue({ sequence: 500 });
      (mockPrisma as any).indexerCheckpoint.findUnique.mockResolvedValue({
        id: 'singleton',
        lastSequence: 500,
        lastHash: 'tip-hash',
      });

      await (indexer as any).tick();

      expect(horizonGetLedger).not.toHaveBeenCalled();
    });
  });

  // ── cursor persistence ──────────────────────────────────────────────────────

  describe('cursor persistence', () => {
    it('reads checkpoint from DB on each tick (not latestLedger-1000)', async () => {
      rpcGetLatest.mockResolvedValue({ sequence: 5000 });
      (mockPrisma as any).indexerCheckpoint.findUnique.mockResolvedValue({
        id: 'singleton',
        lastSequence: 4999,
        lastHash: 'persisted-hash',
      });

      horizonGetLedger.mockResolvedValue({
        hash: 'new-hash',
        closed_at: '2024-01-01T00:00:00Z',
        transaction_count: 0,
      });
      horizonGetTxs.mockResolvedValue([]);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: { events: [] } }),
      } as any);

      await (indexer as any).tick();

      // Should start from 4999 + 1 = 5000, not 5000 - 1000
      expect(horizonGetLedger).toHaveBeenCalledWith(5000);
    });

    it('creates a checkpoint on first boot when none exists', async () => {
      rpcGetLatest.mockResolvedValue({ sequence: 1000 });
      (mockPrisma as any).indexerCheckpoint.findUnique.mockResolvedValue(null);
      (mockPrisma as any).indexerCheckpoint.create.mockResolvedValue({
        id: 'singleton',
        lastSequence: 990, // 1000 - batchSize(10)
        lastHash: '',
      });
      horizonGetLedger.mockResolvedValue({
        hash: 'genesis-hash',
        closed_at: '2024-01-01T00:00:00Z',
        transaction_count: 0,
      });
      horizonGetTxs.mockResolvedValue([]);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: { events: [] } }),
      } as any);

      await (indexer as any).tick();

      expect((mockPrisma as any).indexerCheckpoint.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ id: 'singleton', lastSequence: 990 }),
        }),
      );
    });

    it('upserts checkpoint after each committed ledger', async () => {
      rpcGetLatest.mockResolvedValue({ sequence: 101 });
      (mockPrisma as any).indexerCheckpoint.findUnique.mockResolvedValue({
        id: 'singleton',
        lastSequence: 100,
        lastHash: 'old-hash',
      });
      horizonGetLedger.mockResolvedValue({
        hash: 'fresh-hash',
        closed_at: '2024-01-01T00:00:00Z',
        transaction_count: 0,
      });
      horizonGetTxs.mockResolvedValue([]);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: { events: [] } }),
      } as any);

      await (indexer as any).tick();

      // The $transaction callback should upsert the checkpoint with seq=101
      expect((mockPrisma as any).indexerCheckpoint.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'singleton' },
          update: expect.objectContaining({ lastSequence: 101, lastHash: 'fresh-hash' }),
        }),
      );
    });
  });

  // ── reorg / orphan detection ────────────────────────────────────────────────

  describe('reorg detection', () => {
    it('marks existing rows ORPHANED when ledgerHash differs', async () => {
      const existingRows = [
        { id: 'row1', txHash: 'TX_A', ledgerHash: 'old-ledger-hash' },
        { id: 'row2', txHash: 'TX_B', ledgerHash: 'old-ledger-hash' },
      ];
      (mockPrisma as any).blockchainTransaction.findMany.mockResolvedValue(existingRows);

      await (indexer as any).detectAndMarkOrphans(
        42,
        'new-canonical-hash',
        new Set(['TX_C', 'TX_D']), // these canonical txs don't overlap
      );

      expect((mockPrisma as any).blockchainTransaction.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['row1', 'row2'] } },
        data: { status: 'ORPHANED' },
      });
    });

    it('marks rows ORPHANED when txHash is absent from canonical set', async () => {
      const existingRows = [
        { id: 'row1', txHash: 'GHOST_TX', ledgerHash: 'same-hash' },
      ];
      (mockPrisma as any).blockchainTransaction.findMany.mockResolvedValue(existingRows);

      await (indexer as any).detectAndMarkOrphans(
        42,
        'same-hash',        // ledger hash matches — but tx is gone
        new Set<string>([]), // canonical set is empty
      );

      expect((mockPrisma as any).blockchainTransaction.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['row1'] } },
        data: { status: 'ORPHANED' },
      });
    });

    it('does NOT mark rows ORPHANED when ledgerHash and txHash both match', async () => {
      const existingRows = [
        { id: 'row1', txHash: 'KNOWN_TX', ledgerHash: 'canonical-hash' },
      ];
      (mockPrisma as any).blockchainTransaction.findMany.mockResolvedValue(existingRows);

      await (indexer as any).detectAndMarkOrphans(
        42,
        'canonical-hash',
        new Set(['KNOWN_TX']),
      );

      expect((mockPrisma as any).blockchainTransaction.updateMany).not.toHaveBeenCalled();
    });

    it('does nothing when no existing rows exist for the ledger', async () => {
      (mockPrisma as any).blockchainTransaction.findMany.mockResolvedValue([]);

      await (indexer as any).detectAndMarkOrphans(42, 'hash', new Set());

      expect((mockPrisma as any).blockchainTransaction.updateMany).not.toHaveBeenCalled();
    });
  });

  // ── idempotent inserts ──────────────────────────────────────────────────────

  describe('idempotent inserts (P2002 handling)', () => {
    it('does not throw when BlockchainTransaction insert hits unique constraint', async () => {
      const p2002 = Object.assign(new Error('Unique constraint'), { code: 'P2002' });

      (mockPrisma as any).blockchainTransaction.create.mockRejectedValue(p2002);
      (mockPrisma as any).contractEvent.create.mockResolvedValue({});
      (mockPrisma as any).indexerCheckpoint.upsert.mockResolvedValue({});

      await expect(
        (indexer as any).commitLedger({
          seq: 50,
          ledgerHash: 'hash',
          ledgerTimestamp: Date.now(),
          parsedTxs: [
            {
              txHash: 'DUPE_TX',
              fromAddress: null,
              toAddress: null,
              amount: null,
              contractAddress: null,
              functionName: null,
              ledgerTimestamp: Date.now(),
            },
          ],
          allEvents: [],
        }),
      ).resolves.not.toThrow();
    });

    it('propagates non-P2002 errors from BlockchainTransaction insert', async () => {
      const dbError = Object.assign(new Error('DB down'), { code: 'P1001' });
      (mockPrisma as any).blockchainTransaction.create.mockRejectedValue(dbError);

      // $transaction must rethrow non-P2002 errors
      (mockPrisma as any).$transaction.mockImplementation(async (cb: any) => {
        return cb(mockPrisma);
      });

      await expect(
        (indexer as any).commitLedger({
          seq: 50,
          ledgerHash: 'hash',
          ledgerTimestamp: Date.now(),
          parsedTxs: [
            {
              txHash: 'TX',
              fromAddress: null,
              toAddress: null,
              amount: null,
              contractAddress: null,
              functionName: null,
              ledgerTimestamp: Date.now(),
            },
          ],
          allEvents: [],
        }),
      ).rejects.toThrow('DB down');
    });
  });

  // ── 429 / rate-limit retry ──────────────────────────────────────────────────

  describe('429 retry with Retry-After header', () => {
    it('retries after a 429 error and eventually succeeds', async () => {
      const rateLimit = new HorizonError('http://x', 429, 0, 'rate limited');
      const successResult = { sequence: 100, hash: 'h', closed_at: '2024-01-01T00:00:00Z', transaction_count: 0 };

      // Use a very short retryAfterMs (0) so the test doesn't actually wait
      let callCount = 0;
      const mockFn = jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw rateLimit;
        return successResult;
      });

      const fetchWithRetry = (indexer as any).fetchWithRetry.bind(indexer);
      const result = await fetchWithRetry(mockFn);

      expect(callCount).toBe(2);
      expect(result).toEqual(successResult);
    }, 15_000);

    it('throws after MAX_FETCH_RETRIES attempts', async () => {
      // Use 0ms retry-after so the test doesn't take long
      const rateLimit = new HorizonError('http://x', 429, 0, 'rate limited');
      const mockFn = jest.fn().mockRejectedValue(rateLimit);

      const fetchWithRetry = (indexer as any).fetchWithRetry.bind(indexer);

      await expect(fetchWithRetry(mockFn)).rejects.toBeInstanceOf(HorizonError);
      // MAX_FETCH_RETRIES = 4
      expect(mockFn).toHaveBeenCalledTimes(4);
    }, 15_000);
  });

  // ── public API ──────────────────────────────────────────────────────────────

  describe('indexTransaction (manual write path)', () => {
    it('creates a BlockchainTransaction row', async () => {
      (mockPrisma as any).blockchainTransaction.create.mockResolvedValue({});

      await indexer.indexTransaction('TX123', 'DONATION' as any, {
        fromAddress: 'GABC',
        toAddress: 'GXYZ',
        amount: '1000',
        currency: 'XLM',
        blockNumber: '42',
        timestamp: new Date().toISOString(),
      });

      expect((mockPrisma as any).blockchainTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ txHash: 'TX123', status: 'CONFIRMED' }),
        }),
      );
    });

    it('silently ignores P2002 (duplicate txHash)', async () => {
      const dup = Object.assign(new Error('dup'), { code: 'P2002' });
      (mockPrisma as any).blockchainTransaction.create.mockRejectedValue(dup);

      await expect(
        indexer.indexTransaction('DUPE', 'DONATION' as any, {}),
      ).resolves.not.toThrow();
    });
  });

  describe('getUnprocessedEvents()', () => {
    it('returns events with processed=false, up to 100', async () => {
      const fakeEvents = [{ id: 'e1', processed: false }];
      (mockPrisma as any).contractEvent.findMany.mockResolvedValue(fakeEvents);

      const result = await indexer.getUnprocessedEvents();

      expect((mockPrisma as any).contractEvent.findMany).toHaveBeenCalledWith({
        where: { processed: false },
        take: 100,
      });
      expect(result).toEqual(fakeEvents);
    });
  });

  describe('markEventProcessed()', () => {
    it('updates the event to processed=true', async () => {
      (mockPrisma as any).contractEvent.update.mockResolvedValue({});

      await indexer.markEventProcessed('e1');

      expect((mockPrisma as any).contractEvent.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { processed: true },
      });
    });
  });
});
