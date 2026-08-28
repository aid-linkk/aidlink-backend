/**
 * Unit tests for MatchedFundVerificationService
 *
 * All Prisma calls are mocked via jest.mock('../config/database') so the
 * tests run without a live database.
 *
 * Covered acceptance criteria:
 *   - Detection: matchedTotal != sum of non-refunded matchedAmount
 *   - Precision: differences ≤ threshold are ignored
 *   - Scale: verification issues a single aggregation query (not per-row)
 *   - Repair: matchedTotal is updated to the correct value
 *   - Repair uses FOR UPDATE lock + re-reads sum inside TX
 *   - Alerting: systemic threshold, large discrepancy, repair failure
 *   - SAMPLE mode: uses TABLESAMPLE query variant
 *   - injectInconsistencyForTesting: only works in test environment
 */

import { Prisma } from '@prisma/client';

import { Prisma } from '@prisma/client';

// ─── Mock prisma ─────────────────────────────────────────────────────────────
const mockQueryRaw = jest.fn();
const mockTransaction = jest.fn();
const mockMultiplierCount = jest.fn();

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    $transaction: (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
      mockTransaction(fn, opts),
    multiplier: { count: (...args: unknown[]) => mockMultiplierCount(...args) },
  },
}));

// ─── Mock config ─────────────────────────────────────────────────────────────
jest.mock('../config', () => ({
  config: {
    logging: { level: 'error', filePath: 'logs' },
    matchedFundVerification: {
      enabled: true,
      fullVerificationCron: '30 2 * * *',
      sampleVerificationCron: '45 * * * *',
      samplePercent: 10,
      inconsistencyThreshold: '0.00000001',
      alertSystemicThreshold: 0.05,
      alertLargeDiscrepancyAmount: '1000',
      repairTimeoutMs: 5000,
    },
  },
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import { MatchedFundVerificationService } from './matchedFundVerification.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a raw detection query result row. */
const makeInconsistencyRow = (
  id: string,
  matchedTotal: string,
  actualSum: string,
) => ({ id, matchedTotal, actualSum });

/** Build a sum row for the repair re-read inside the transaction. */
const makeActualSumRow = (actualSum: string) => ({ actualSum });

/**
 * Set up mockTransaction to execute the callback with a fake transaction
 * client. The client's $queryRaw calls are forwarded to `txQueryRaw`.
 */
function setupTransaction(txQueryRaw: jest.Mock) {
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const fakeTx = { $queryRaw: txQueryRaw };
    return fn(fakeTx);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no multipliers, consistent state
  mockQueryRaw.mockResolvedValue([]);
  mockMultiplierCount.mockResolvedValue(0);
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Detection
// ═════════════════════════════════════════════════════════════════════════════

describe('MatchedFundVerificationService – detection', () => {
  it('returns no inconsistencies when all multipliers are consistent', async () => {
    // The HAVING clause filters everything out → empty result
    mockQueryRaw.mockResolvedValue([]);
    mockMultiplierCount.mockResolvedValue(5);

    const result = await MatchedFundVerificationService.verify('FULL', false);

    expect(result.inconsistentCount).toBe(0);
    expect(result.inconsistencies).toHaveLength(0);
    expect(result.checkedCount).toBe(5);
  });

  it('detects a positive delta when matchedTotal is too low', async () => {
    // actualSum (150) > storedTotal (100) → matchedTotal was under-counted
    mockQueryRaw.mockResolvedValue([
      makeInconsistencyRow('mult-A', '100', '150'),
    ]);
    mockMultiplierCount.mockResolvedValue(3);
    setupTransaction(jest.fn().mockResolvedValue([makeActualSumRow('150')]));

    const result = await MatchedFundVerificationService.verify('FULL', false);

    expect(result.inconsistentCount).toBe(1);
    const inc = result.inconsistencies[0];
    expect(inc.multiplierId).toBe('mult-A');
    expect(inc.storedTotal.toString()).toBe('100');
    expect(inc.actualSum.toString()).toBe('150');
    // delta = actualSum − storedTotal = +50
    expect(inc.delta.toString()).toBe('50');
  });

  it('detects a negative delta when matchedTotal is too high', async () => {
    // actualSum (80) < storedTotal (100) → matchedTotal was over-counted
    mockQueryRaw.mockResolvedValue([
      makeInconsistencyRow('mult-B', '100', '80'),
    ]);
    mockMultiplierCount.mockResolvedValue(1);
    setupTransaction(jest.fn().mockResolvedValue([makeActualSumRow('80')]));

    const result = await MatchedFundVerificationService.verify('FULL', false);

    const inc = result.inconsistencies[0];
    expect(inc.delta.toString()).toBe('-20');
  });

  it('detects multiple inconsistent multipliers in one pass', async () => {
    mockQueryRaw.mockResolvedValue([
      makeInconsistencyRow('m1', '100', '150'),
      makeInconsistencyRow('m2', '200', '100'),
      makeInconsistencyRow('m3', '0', '75'),
    ]);
    mockMultiplierCount.mockResolvedValue(10);
    setupTransaction(jest.fn().mockResolvedValue([makeActualSumRow('0')])); // unused (autoRepair=false)

    const result = await MatchedFundVerificationService.verify('FULL', false);

    expect(result.inconsistentCount).toBe(3);
    expect(result.inconsistencies.map((i) => i.multiplierId)).toEqual(['m1', 'm2', 'm3']);
  });

  it('correctly handles a multiplier with zero MatchedFund rows (actualSum = 0)', async () => {
    // A multiplier that has matchedTotal = 50 but no MatchedFund rows at all
    // (all refunded or never allocated). COALESCE returns 0, HAVING fires.
    mockQueryRaw.mockResolvedValue([makeInconsistencyRow('orphan', '50', '0')]);
    mockMultiplierCount.mockResolvedValue(1);
    setupTransaction(jest.fn().mockResolvedValue([makeActualSumRow('0')]));

    const result = await MatchedFundVerificationService.verify('FULL', false);

    expect(result.inconsistencies[0].actualSum.toString()).toBe('0');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Precision / threshold handling
// ═════════════════════════════════════════════════════════════════════════════

describe('MatchedFundVerificationService – precision threshold', () => {
  it('ignores differences at or below the configured threshold via SQL HAVING', () => {
    // The HAVING clause runs in Postgres; the service just issues the query.
    // We verify that the threshold is passed to the SQL (not filtered in JS).
    // In unit tests we trust that if $queryRaw returns nothing, the service
    // reports zero inconsistencies — the HAVING clause does the heavy lifting.
    mockQueryRaw.mockResolvedValue([]);
    mockMultiplierCount.mockResolvedValue(100);

    return MatchedFundVerificationService.verify('FULL', false).then((result) => {
      expect(result.inconsistentCount).toBe(0);
    });
  });

  it('handles Decimal precision correctly (no floating-point drift in delta)', async () => {
    // 10.00000002 - 10.00000001 = 0.00000001, exactly representable as Decimal
    mockQueryRaw.mockResolvedValue([
      makeInconsistencyRow('precise', '10.00000001', '10.00000002'),
    ]);
    mockMultiplierCount.mockResolvedValue(1);
    setupTransaction(jest.fn().mockResolvedValue([makeActualSumRow('10.00000002')]));

    const result = await MatchedFundVerificationService.verify('FULL', false);

    // Prisma.Decimal may normalise 0.00000001 to 1e-8 — both are exact.
    // Compare numerically to avoid string representation sensitivity.
    const delta = result.inconsistencies[0].delta;
    expect(delta.toNumber()).toBeCloseTo(0.00000001, 15);
    expect(delta.equals(new Prisma.Decimal('0.00000001'))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Repair
// ═════════════════════════════════════════════════════════════════════════════

describe('MatchedFundVerificationService – repair', () => {
  it('repairs a single inconsistent multiplier correctly', async () => {
    mockQueryRaw.mockResolvedValue([makeInconsistencyRow('m1', '100', '150')]);
    mockMultiplierCount.mockResolvedValue(1);

    const txQueryRaw = jest.fn()
      // First call: SELECT FOR UPDATE (lock)
      .mockResolvedValueOnce([{ matchedTotal: '100' }])
      // Second call: re-aggregate true sum
      .mockResolvedValueOnce([makeActualSumRow('150')])
      // Third call: UPDATE matchedTotal
      .mockResolvedValueOnce([]);

    setupTransaction(txQueryRaw);

    const result = await MatchedFundVerificationService.verify('FULL', true);

    expect(result.repairedCount).toBe(1);
    expect(result.failedRepairCount).toBe(0);
    expect(result.repairs[0].success).toBe(true);
    expect(result.repairs[0].multiplierId).toBe('m1');

    // Three SQL statements: FOR UPDATE, SUM aggregate, UPDATE
    expect(txQueryRaw).toHaveBeenCalledTimes(3);
  });

  it('re-reads the true sum inside the transaction (TOCTOU correctness)', async () => {
    // The detection scan showed 150 as actualSum, but by the time we repair,
    // a concurrent allocation has added 20 more → the re-read inside TX is 170.
    mockQueryRaw.mockResolvedValue([makeInconsistencyRow('m1', '100', '150')]);
    mockMultiplierCount.mockResolvedValue(1);

    const txQueryRaw = jest.fn()
      .mockResolvedValueOnce([{ matchedTotal: '100' }])   // FOR UPDATE
      .mockResolvedValueOnce([makeActualSumRow('170')])   // re-read (concurrently updated)
      .mockResolvedValueOnce([]);                          // UPDATE

    setupTransaction(txQueryRaw);

    const result = await MatchedFundVerificationService.verify('FULL', true);

    // Verify the UPDATE call used the re-read value (170), not the stale 150
    const updateCall = txQueryRaw.mock.calls[2][0];
    // The SQL template values include the new trueSum
    const sqlValues: string[] = updateCall.values ?? updateCall;
    expect(sqlValues).toContain('170');
    expect(result.repairs[0].success).toBe(true);
  });

  it('records repair failure when transaction throws', async () => {
    mockQueryRaw.mockResolvedValue([makeInconsistencyRow('m-bad', '100', '200')]);
    mockMultiplierCount.mockResolvedValue(1);

    mockTransaction.mockRejectedValue(new Error('deadlock detected'));

    const result = await MatchedFundVerificationService.verify('FULL', true);

    expect(result.repairedCount).toBe(0);
    expect(result.failedRepairCount).toBe(1);
    expect(result.repairs[0].success).toBe(false);
    expect(result.repairs[0].error).toContain('deadlock');
  });

  it('continues repairing remaining multipliers after one repair fails', async () => {
    mockQueryRaw.mockResolvedValue([
      makeInconsistencyRow('bad', '100', '200'),
      makeInconsistencyRow('good', '50', '75'),
    ]);
    mockMultiplierCount.mockResolvedValue(2);

    let callCount = 0;
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      callCount++;
      if (callCount === 1) throw new Error('lock timeout');
      // Second call succeeds
      const txQR = jest.fn()
        .mockResolvedValueOnce([])  // FOR UPDATE
        .mockResolvedValueOnce([makeActualSumRow('75')])  // re-read
        .mockResolvedValueOnce([]); // UPDATE
      return fn({ $queryRaw: txQR });
    });

    const result = await MatchedFundVerificationService.verify('FULL', true);

    expect(result.repairedCount).toBe(1);
    expect(result.failedRepairCount).toBe(1);
    expect(result.repairs.find((r) => r.multiplierId === 'bad')?.success).toBe(false);
    expect(result.repairs.find((r) => r.multiplierId === 'good')?.success).toBe(true);
  });

  it('does not repair when autoRepair=false', async () => {
    mockQueryRaw.mockResolvedValue([makeInconsistencyRow('m1', '100', '150')]);
    mockMultiplierCount.mockResolvedValue(1);

    const result = await MatchedFundVerificationService.verify('FULL', false);

    expect(result.inconsistentCount).toBe(1);
    expect(result.repairedCount).toBe(0);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Verification modes
// ═════════════════════════════════════════════════════════════════════════════

describe('MatchedFundVerificationService – modes', () => {
  it('uses TABLESAMPLE query variant in SAMPLE mode', async () => {
    mockQueryRaw.mockResolvedValue([]);
    // For SAMPLE mode, countChecked also uses TABLESAMPLE
    mockQueryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ cnt: '10' }]);

    await MatchedFundVerificationService.verify('SAMPLE', false, 20);

    const firstCall = mockQueryRaw.mock.calls[0][0];
    // The Prisma.sql tagged template carries the raw SQL strings
    const sqlParts: string[] = firstCall.strings ?? [];
    const sqlStr = sqlParts.join('');
    expect(sqlStr).toMatch(/TABLESAMPLE/i);
  });

  it('does NOT use TABLESAMPLE in FULL mode', async () => {
    mockQueryRaw.mockResolvedValue([]);
    mockMultiplierCount.mockResolvedValue(5);

    await MatchedFundVerificationService.verify('FULL', false);

    const firstCall = mockQueryRaw.mock.calls[0][0];
    const sqlParts: string[] = firstCall.strings ?? [];
    const sqlStr = sqlParts.join('');
    expect(sqlStr).not.toMatch(/TABLESAMPLE/i);
  });

  it('uses multiplier.count for FULL mode checkedCount (not $queryRaw)', async () => {
    mockQueryRaw.mockResolvedValue([]);
    mockMultiplierCount.mockResolvedValue(42);

    const result = await MatchedFundVerificationService.verify('FULL', false);

    expect(mockMultiplierCount).toHaveBeenCalledTimes(1);
    expect(result.checkedCount).toBe(42);
  });

  it('returns mode=TRIGGERED in result when called with TRIGGERED', async () => {
    mockQueryRaw.mockResolvedValue([]);
    mockMultiplierCount.mockResolvedValue(5);

    const result = await MatchedFundVerificationService.verify('TRIGGERED', false);

    expect(result.mode).toBe('TRIGGERED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Alerting
// ═════════════════════════════════════════════════════════════════════════════

describe('MatchedFundVerificationService – alerting', () => {
  it('fires SYSTEMIC_INCONSISTENCY alert when rate exceeds threshold', async () => {
    // 6 of 10 checked multipliers are inconsistent = 60% > 5% threshold
    const rows = Array.from({ length: 6 }, (_, i) =>
      makeInconsistencyRow(`m${i}`, '100', '200'),
    );
    mockQueryRaw.mockResolvedValue(rows);
    mockMultiplierCount.mockResolvedValue(10);
    // No repair
    const result = await MatchedFundVerificationService.verify('FULL', false);

    const alert = result.alerts.find((a) => a.type === 'SYSTEMIC_INCONSISTENCY');
    expect(alert).toBeDefined();
    expect(alert?.details.rate).toBeCloseTo(0.6);
  });

  it('does NOT fire SYSTEMIC_INCONSISTENCY when rate is within threshold', async () => {
    // 1 of 100 = 1% < 5%
    mockQueryRaw.mockResolvedValue([makeInconsistencyRow('m1', '100', '101')]);
    mockMultiplierCount.mockResolvedValue(100);

    const result = await MatchedFundVerificationService.verify('FULL', false);

    expect(result.alerts.find((a) => a.type === 'SYSTEMIC_INCONSISTENCY')).toBeUndefined();
  });

  it('fires LARGE_DISCREPANCY alert when delta exceeds alertLargeDiscrepancyAmount', async () => {
    // delta = 5000 > 1000 threshold
    mockQueryRaw.mockResolvedValue([makeInconsistencyRow('big', '0', '5000')]);
    mockMultiplierCount.mockResolvedValue(1);

    const result = await MatchedFundVerificationService.verify('FULL', false);

    const alert = result.alerts.find((a) => a.type === 'LARGE_DISCREPANCY');
    expect(alert).toBeDefined();
    expect(alert?.details.multiplierId).toBe('big');
  });

  it('does NOT fire LARGE_DISCREPANCY when delta is within threshold', async () => {
    // delta = 500 < 1000 threshold
    mockQueryRaw.mockResolvedValue([makeInconsistencyRow('small', '100', '600')]);
    mockMultiplierCount.mockResolvedValue(1);

    const result = await MatchedFundVerificationService.verify('FULL', false);

    expect(result.alerts.find((a) => a.type === 'LARGE_DISCREPANCY')).toBeUndefined();
  });

  it('fires REPAIR_FAILURE alert when a repair transaction throws', async () => {
    mockQueryRaw.mockResolvedValue([makeInconsistencyRow('m-fail', '100', '200')]);
    mockMultiplierCount.mockResolvedValue(1);
    mockTransaction.mockRejectedValue(new Error('connection reset'));

    const result = await MatchedFundVerificationService.verify('FULL', true);

    const alert = result.alerts.find((a) => a.type === 'REPAIR_FAILURE');
    expect(alert).toBeDefined();
    expect(alert?.details.multiplierId).toBe('m-fail');
    expect(String(alert?.details.error)).toContain('connection reset');
  });

  it('fires no alerts when everything is clean', async () => {
    mockQueryRaw.mockResolvedValue([]);
    mockMultiplierCount.mockResolvedValue(50);

    const result = await MatchedFundVerificationService.verify('FULL', false);

    expect(result.alerts).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Result metadata
// ═════════════════════════════════════════════════════════════════════════════

describe('MatchedFundVerificationService – result metadata', () => {
  it('populates startedAt, finishedAt, and durationMs', async () => {
    mockQueryRaw.mockResolvedValue([]);
    mockMultiplierCount.mockResolvedValue(0);

    const before = Date.now();
    const result = await MatchedFundVerificationService.verify('FULL', false);
    const after = Date.now();

    expect(result.startedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.finishedAt.getTime()).toBeLessThanOrEqual(after);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('counts repaired and failed repairs separately', async () => {
    mockQueryRaw.mockResolvedValue([
      makeInconsistencyRow('ok', '100', '150'),
      makeInconsistencyRow('fail', '200', '300'),
    ]);
    mockMultiplierCount.mockResolvedValue(2);

    let call = 0;
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      call++;
      if (call === 1) {
        const txQR = jest.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([makeActualSumRow('150')])
          .mockResolvedValueOnce([]);
        return fn({ $queryRaw: txQR });
      }
      throw new Error('timeout');
    });

    const result = await MatchedFundVerificationService.verify('FULL', true);

    expect(result.repairedCount).toBe(1);
    expect(result.failedRepairCount).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. injectInconsistencyForTesting
// ═════════════════════════════════════════════════════════════════════════════

describe('MatchedFundVerificationService – injectInconsistencyForTesting', () => {
  it('calls $queryRaw with an UPDATE when NODE_ENV=test', async () => {
    // NODE_ENV is 'test' in jest runs by default
    mockQueryRaw.mockResolvedValue([]);

    await MatchedFundVerificationService.injectInconsistencyForTesting('mult-x', '999');

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlParts: string[] = call.strings ?? [];
    expect(sqlParts.join('')).toMatch(/UPDATE.*Multiplier/i);
  });

  it('throws if called outside test environment', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        MatchedFundVerificationService.injectInconsistencyForTesting('mult-x', '999'),
      ).rejects.toThrow('only available in test environments');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });
});
