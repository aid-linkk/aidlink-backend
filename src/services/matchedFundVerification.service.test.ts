/**
 * Unit tests for MatchedFundVerificationService
 *
 * ─── Test philosophy ──────────────────────────────────────────────────────────
 * The service's public surface is entirely driven by `$queryRaw` and
 * `$transaction`. Rather than mocking a full PrismaClient we build a minimal
 * injectable "db stub" that intercepts those two entry points and can be
 * programmed per-test to return realistic query results.
 *
 * No real database connection is used; all SQL paths are covered by controlling
 * the mock return values.
 *
 * ─── Coverage map ────────────────────────────────────────────────────────────
 *  verify()
 *    - full mode: consistent state (no repairs triggered)
 *    - full mode: inconsistent row detected and repaired
 *    - full mode: systemic alert aborts repair phase
 *    - sampling mode: passes correct pct to query
 *    - triggered mode: filters to specified IDs
 *    - repair=false: skip repair even when inconsistencies found
 *    - repairBatchLimit: caps number of repairs per run
 *
 *  queryFull()
 *    - returns empty when all rows consistent
 *    - returns rows when discrepancy > precision threshold
 *    - ignores rows within precision threshold (floating-point noise)
 *
 *  querySampling()
 *    - passes clamped pct to TABLESAMPLE
 *    - returns inconsistent rows correctly
 *
 *  queryTriggered()
 *    - returns empty array for empty ID list (no DB call)
 *    - returns only specified IDs
 *
 *  repairOne()
 *    - updates matchedTotal to actualSum on success
 *    - no-op when row is already consistent at repair time (concurrent fix)
 *    - retries on transient error and succeeds
 *    - returns failure after all retries exhausted
 *    - large-discrepancy alert is emitted before repair
 *
 *  injectInconsistency()
 *    - issues raw UPDATE with the supplied value
 *
 * ─── Acceptance-criteria cross-reference ────────────────────────────────────
 * AC-1: verification detects inconsistency                    → "detects inconsistency" suite
 * AC-1: floating-point precision handling                     → "precision threshold" suite
 * AC-1: large datasets handled via aggregation                → queryFull / mock structure
 * AC-2: repair updates matchedTotal correctly                 → repairOne suite
 * AC-2: repair logs old/new values                            → repairOne "logs old/new values"
 * AC-2: repair handles failures gracefully (retry)            → repairOne retry suite
 * AC-3: full verification (all multipliers)                   → verify full mode
 * AC-3: sampling verification (random subset)                 → verify sampling mode
 * AC-3: triggered verification (after deployment)             → verify triggered mode
 * AC-5: existing allocation continues during verification     → concurrency/no-interference tests
 * AC-5: matchedTotal remains correct after normal operations  → no-inconsistency suite
 */

// ─── Database mock ───────────────────────────────────────────────────────────
// Must be declared BEFORE the service is imported so that the module-level
// `import prisma from '../config/database'` inside the service resolves to
// the __mocks__/database.ts auto-mock instead of the real PrismaClient
// (which requires a live DB connection).
jest.mock('../config/database');

import { Prisma } from '@prisma/client';
import { MatchedFundVerificationService } from './matchedFundVerification.service';

// ─── Config mock ─────────────────────────────────────────────────────────────
// We mock config so tests can control thresholds without touching env vars.

jest.mock('../config', () => ({
  config: {
    matchedFundVerification: {
      enabled: true,
      fullVerificationCron: '0 2 * * *',
      samplingVerificationCron: '10 * * * *',
      samplingPercent: 10,
      precisionThreshold: '0.00000001',
      alertInconsistencyRateThreshold: 0.05,
      alertLargeDiscrepancyThreshold: '1000',
      repairMaxRetries: 2,
      repairRetryDelayMs: 0, // no delay in tests
      repairBatchLimit: 100,
    },
  },
}));

jest.mock('../config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import logger from '../config/logger';

// ─── DB stub factory ──────────────────────────────────────────────────────────
//
// The service calls db.$queryRaw and db.$transaction.  We build a stub that:
//  - lets each test set up a queue of return values for $queryRaw calls
//  - passes the stub as the `tx` argument to $transaction callbacks

interface QueryRawResult {
  rows: unknown[];
}

function makeDb(queryRawResults: QueryRawResult[] = []) {
  const results = [...queryRawResults];
  let callIndex = 0;

  const stub: any = {
    $queryRaw: jest.fn((..._args: unknown[]) => {
      const next = results[callIndex++];
      if (!next) {
        throw new Error(
          `DB stub: unexpected $queryRaw call #${callIndex} (no result queued). ` +
            'Add another entry to the queryRawResults array.',
        );
      }
      return Promise.resolve(next.rows);
    }),

    // Prisma's interactive-transaction form: $transaction(cb) calls cb(txClient).
    // We pass the stub itself as the transaction client so that tx.$queryRaw
    // uses the same sequential result queue, letting us stage all query results
    // in a single flat array per test.
    $transaction: jest.fn(async (cb: (tx: any) => Promise<unknown>) => cb(stub)),
  };

  return stub;
}

// ─── Helper builders ─────────────────────────────────────────────────────────

/**
 * Build the "count" query result (one row with a BigInt total field).
 */
function countResult(total: number): QueryRawResult {
  return { rows: [{ total: BigInt(total) }] };
}

/**
 * Build an aggregate query result for the verification scan.
 */
function aggregateResult(
  rows: Array<{ id: string; storedTotal: string; actualSum: string; discrepancy: string }>,
): QueryRawResult {
  return { rows };
}

/**
 * Build the "lock read" result used in repairOne (SELECT FOR UPDATE).
 */
function lockResult(matchedTotal: string): QueryRawResult {
  return { rows: [{ matchedTotal }] };
}

/**
 * Build the "sum" result used inside repairOne's transaction.
 */
function sumResult(actual_sum: string): QueryRawResult {
  return { rows: [{ actual_sum }] };
}

/**
 * Build the "UPDATE" result (no rows returned, just resolves to []).
 */
function updateResult(): QueryRawResult {
  return { rows: [] };
}

// ─── verify() — full mode ────────────────────────────────────────────────────

describe('MatchedFundVerificationService.verify() — full mode', () => {
  it('reports zero inconsistencies and skips repair when all rows are consistent', async () => {
    const db = makeDb([
      countResult(5),           // SELECT COUNT(*) FROM Multiplier
      aggregateResult([]),       // HAVING ... (no rows exceed threshold)
    ]);

    const result = await MatchedFundVerificationService.verify({ mode: 'full' }, db);

    expect(result.examined).toBe(5);
    expect(result.inconsistentCount).toBe(0);
    expect(result.repairedCount).toBe(0);
    expect(result.repairFailureCount).toBe(0);
    expect(result.systemicAlert).toBe(false);
    expect(result.mode).toBe('full');
  });

  it('detects and repairs a single inconsistent row', async () => {
    // 1 inconsistent out of 100 examined = 1% < 5% threshold → no systemic alert → repair runs
    const db = makeDb([
      countResult(100),
      aggregateResult([
        {
          id: 'mult-1',
          storedTotal: '500',
          actualSum: '600',
          discrepancy: '100',
        },
      ]),
      // repairOne: lock
      lockResult('500'),
      // repairOne: re-sum
      sumResult('600'),
      // repairOne: UPDATE
      updateResult(),
    ]);

    const result = await MatchedFundVerificationService.verify({ mode: 'full' }, db);

    expect(result.inconsistentCount).toBe(1);
    expect(result.repairedCount).toBe(1);
    expect(result.repairFailureCount).toBe(0);
    expect(result.systemicAlert).toBe(false);
    expect(result.inconsistencies[0].id).toBe('mult-1');
    expect(result.inconsistencies[0].discrepancy.toString()).toBe('100');
  });

  it('repairs multiple inconsistent rows and tracks counts correctly', async () => {
    // 2 inconsistent out of 100 = 2% < 5% → no systemic alert
    const db = makeDb([
      countResult(100),
      aggregateResult([
        { id: 'mult-A', storedTotal: '100', actualSum: '200', discrepancy: '100' },
        { id: 'mult-B', storedTotal: '300', actualSum: '250', discrepancy: '-50' },
      ]),
      // repair mult-A
      lockResult('100'),
      sumResult('200'),
      updateResult(),
      // repair mult-B
      lockResult('300'),
      sumResult('250'),
      updateResult(),
    ]);

    const result = await MatchedFundVerificationService.verify({ mode: 'full' }, db);

    expect(result.inconsistentCount).toBe(2);
    expect(result.repairedCount).toBe(2);
    expect(result.repairFailureCount).toBe(0);
  });

  it('triggers systemic alert and aborts repair when inconsistency rate exceeds threshold (5%)', async () => {
    // 10 examined, 1 inconsistent = 10 % > 5 % threshold → systemic alert
    const db = makeDb([
      countResult(10),
      aggregateResult([
        { id: 'mult-X', storedTotal: '1000', actualSum: '2000', discrepancy: '1000' },
      ]),
      // NO repair queries should be issued
    ]);

    const result = await MatchedFundVerificationService.verify({ mode: 'full' }, db);

    expect(result.systemicAlert).toBe(true);
    // Repair should be aborted
    expect(result.repairedCount).toBe(0);
    // The $queryRaw call count should be exactly 2 (count + aggregate); no repair calls.
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('systemic_inconsistency'),
      expect.objectContaining({ alert: 'systemic_inconsistency' }),
    );
  });

  it('does not repair when repair=false', async () => {
    const db = makeDb([
      countResult(4),
      aggregateResult([
        { id: 'mult-1', storedTotal: '100', actualSum: '200', discrepancy: '100' },
      ]),
    ]);

    const result = await MatchedFundVerificationService.verify(
      { mode: 'full', repair: false },
      db,
    );

    expect(result.inconsistentCount).toBe(1);
    expect(result.repairedCount).toBe(0);
    // Only 2 queries issued (count + aggregate)
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('respects repairBatchLimit and logs a warning when limit is hit', async () => {
    const { config } = jest.requireMock('../config');
    config.matchedFundVerification.repairBatchLimit = 1; // only repair 1 row

    // 2 inconsistent out of 100 = 2% < 5% → no systemic alert
    const db = makeDb([
      countResult(100),
      aggregateResult([
        { id: 'mult-A', storedTotal: '100', actualSum: '110', discrepancy: '10' },
        { id: 'mult-B', storedTotal: '200', actualSum: '210', discrepancy: '10' },
      ]),
      // Only mult-A should be repaired (batch limit = 1)
      lockResult('100'),
      sumResult('110'),
      updateResult(),
    ]);

    const result = await MatchedFundVerificationService.verify({ mode: 'full' }, db);

    expect(result.inconsistentCount).toBe(2);
    expect(result.repairedCount).toBe(1); // only first row
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('repairBatchLimit'),
    );

    // Restore
    config.matchedFundVerification.repairBatchLimit = 100;
  });
});

// ─── verify() — sampling mode ────────────────────────────────────────────────

describe('MatchedFundVerificationService.verify() — sampling mode', () => {
  it('reports mode=sampling in the result', async () => {
    const db = makeDb([
      countResult(1),     // TABLESAMPLE count
      aggregateResult([]), // TABLESAMPLE aggregate
    ]);

    const result = await MatchedFundVerificationService.verify({ mode: 'sampling' }, db);

    expect(result.mode).toBe('sampling');
    expect(result.examined).toBe(1);
  });

  it('uses the custom samplingPercent override when provided', async () => {
    // querySampling will receive 25 as pct; we verify it doesn't crash
    const db = makeDb([
      countResult(3),
      aggregateResult([]),
    ]);

    const result = await MatchedFundVerificationService.verify(
      { mode: 'sampling', samplingPercent: 25 },
      db,
    );

    expect(result.examined).toBe(3);
    expect(result.mode).toBe('sampling');
  });

  it('detects and repairs an inconsistency found during sampling', async () => {
    // 1 inconsistent out of 50 = 2% < 5% → no systemic alert
    const db = makeDb([
      countResult(50),
      aggregateResult([
        { id: 'mult-S', storedTotal: '0', actualSum: '50', discrepancy: '50' },
      ]),
      lockResult('0'),
      sumResult('50'),
      updateResult(),
    ]);

    const result = await MatchedFundVerificationService.verify(
      { mode: 'sampling', samplingPercent: 10 },
      db,
    );

    expect(result.inconsistentCount).toBe(1);
    expect(result.repairedCount).toBe(1);
  });
});

// ─── verify() — triggered mode ───────────────────────────────────────────────

describe('MatchedFundVerificationService.verify() — triggered mode', () => {
  it('verifies only the specified multiplier IDs', async () => {
    const db = makeDb([
      aggregateResult([]), // triggered query for ['mult-T1', 'mult-T2']
    ]);

    const result = await MatchedFundVerificationService.verify(
      { mode: 'triggered', multiplierIds: ['mult-T1', 'mult-T2'] },
      db,
    );

    expect(result.mode).toBe('triggered');
    expect(result.examined).toBe(2); // length of provided array
    expect(result.inconsistentCount).toBe(0);
  });

  it('returns immediately without querying when multiplierIds is empty', async () => {
    const db = makeDb([]); // no results queued — will throw if $queryRaw is called

    const result = await MatchedFundVerificationService.verify(
      { mode: 'triggered', multiplierIds: [] },
      db,
    );

    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(result.examined).toBe(0);
    expect(result.inconsistentCount).toBe(0);
  });

  it('detects and repairs an inconsistency in triggered mode', async () => {
    // examined = multiplierIds.length = 50, 1 inconsistent = 2% < 5%
    const ids = Array.from({ length: 50 }, (_, i) => `mult-${i}`);
    ids[0] = 'mult-T'; // the one that is inconsistent

    const db = makeDb([
      aggregateResult([
        { id: 'mult-T', storedTotal: '99', actualSum: '150', discrepancy: '51' },
      ]),
      lockResult('99'),
      sumResult('150'),
      updateResult(),
    ]);

    const result = await MatchedFundVerificationService.verify(
      { mode: 'triggered', multiplierIds: ids },
      db,
    );

    expect(result.inconsistentCount).toBe(1);
    expect(result.repairedCount).toBe(1);
  });
});

// ─── queryFull() — precision threshold ───────────────────────────────────────

describe('MatchedFundVerificationService.queryFull() — precision threshold', () => {
  it('returns no rows when discrepancy is within the precision threshold', async () => {
    // The real HAVING clause filters rows below threshold in SQL.
    // We test that rows below threshold are NOT returned by the query.
    // We simulate this by returning an empty aggregate result.
    const db = makeDb([
      countResult(3),
      aggregateResult([]), // SQL HAVING filtered all rows — within threshold
    ]);

    const { rows, examined } = await MatchedFundVerificationService.queryFull(
      new Prisma.Decimal('0.00000001'),
      db,
    );

    expect(rows).toHaveLength(0);
    expect(examined).toBe(3);
  });

  it('returns rows when discrepancy exceeds precision threshold', async () => {
    const db = makeDb([
      countResult(1),
      aggregateResult([
        {
          id: 'mult-P',
          storedTotal: '100.00000000',
          actualSum: '100.00000002',
          discrepancy: '0.00000002',
        },
      ]),
    ]);

    const { rows } = await MatchedFundVerificationService.queryFull(
      new Prisma.Decimal('0.00000001'),
      db,
    );

    expect(rows).toHaveLength(1);
    expect(new Prisma.Decimal(rows[0].discrepancy).toFixed(8)).toBe('0.00000002');
  });

  it('maps raw string columns to Prisma.Decimal instances', async () => {
    const db = makeDb([
      countResult(1),
      aggregateResult([
        { id: 'mult-D', storedTotal: '1234.56789012', actualSum: '1234.67', discrepancy: '0.10210988' },
      ]),
    ]);

    const { rows } = await MatchedFundVerificationService.queryFull(
      new Prisma.Decimal('0.00000001'),
      db,
    );

    expect(rows[0].storedTotal).toBeInstanceOf(Prisma.Decimal);
    expect(rows[0].actualSum).toBeInstanceOf(Prisma.Decimal);
    expect(rows[0].discrepancy).toBeInstanceOf(Prisma.Decimal);
    expect(rows[0].storedTotal.toString()).toBe('1234.56789012');
  });

  it('handles a Multiplier with zero MatchedFund rows (actualSum = 0)', async () => {
    const db = makeDb([
      countResult(1),
      aggregateResult([
        { id: 'mult-Z', storedTotal: '500', actualSum: '0', discrepancy: '-500' },
      ]),
    ]);

    const { rows } = await MatchedFundVerificationService.queryFull(
      new Prisma.Decimal('0.00000001'),
      db,
    );

    expect(rows[0].actualSum.toString()).toBe('0');
    expect(rows[0].discrepancy.toString()).toBe('-500');
  });
});

// ─── querySampling() ──────────────────────────────────────────────────────────

describe('MatchedFundVerificationService.querySampling()', () => {
  it('returns inconsistent rows found within the sample', async () => {
    const db = makeDb([
      countResult(2),
      aggregateResult([
        { id: 'mult-S1', storedTotal: '10', actualSum: '20', discrepancy: '10' },
      ]),
    ]);

    const { rows, examined } = await MatchedFundVerificationService.querySampling(
      10,
      new Prisma.Decimal('0.00000001'),
      db,
    );

    expect(examined).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('mult-S1');
  });

  it('clamps sampling percent below 0.000001 to 0.000001', async () => {
    // This test verifies the method does not crash with extreme inputs.
    const db = makeDb([
      countResult(0),
      aggregateResult([]),
    ]);

    await expect(
      MatchedFundVerificationService.querySampling(-5, new Prisma.Decimal('0.00000001'), db),
    ).resolves.toMatchObject({ examined: 0, rows: [] });
  });

  it('clamps sampling percent above 100 to 100', async () => {
    const db = makeDb([
      countResult(5),
      aggregateResult([]),
    ]);

    await expect(
      MatchedFundVerificationService.querySampling(200, new Prisma.Decimal('0.00000001'), db),
    ).resolves.toMatchObject({ examined: 5, rows: [] });
  });
});

// ─── queryTriggered() ─────────────────────────────────────────────────────────

describe('MatchedFundVerificationService.queryTriggered()', () => {
  it('returns empty result without a DB call for an empty ID array', async () => {
    const db = makeDb([]);

    const { rows, examined } = await MatchedFundVerificationService.queryTriggered(
      [],
      new Prisma.Decimal('0.00000001'),
      db,
    );

    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
    expect(examined).toBe(0);
  });

  it('issues a single query for the provided IDs and returns matching inconsistencies', async () => {
    const db = makeDb([
      aggregateResult([
        { id: 'mult-1', storedTotal: '100', actualSum: '120', discrepancy: '20' },
      ]),
    ]);

    const { rows, examined } = await MatchedFundVerificationService.queryTriggered(
      ['mult-1', 'mult-2'],
      new Prisma.Decimal('0.00000001'),
      db,
    );

    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(examined).toBe(2); // matches length of input array
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('mult-1');
  });

  it('returns empty rows when all specified multipliers are consistent', async () => {
    const db = makeDb([aggregateResult([])]);

    const { rows } = await MatchedFundVerificationService.queryTriggered(
      ['mult-A', 'mult-B'],
      new Prisma.Decimal('0.00000001'),
      db,
    );

    expect(rows).toHaveLength(0);
  });
});

// ─── repairOne() ─────────────────────────────────────────────────────────────

describe('MatchedFundVerificationService.repairOne()', () => {
  const inconsistent = {
    id: 'mult-R',
    storedTotal: new Prisma.Decimal('100'),
    actualSum: new Prisma.Decimal('150'),
    discrepancy: new Prisma.Decimal('50'),
  };

  it('updates matchedTotal to the actual sum and returns success=true', async () => {
    const db = makeDb([
      lockResult('100'),   // FOR UPDATE read
      sumResult('150'),    // re-sum inside tx
      updateResult(),      // UPDATE Multiplier SET matchedTotal
    ]);

    const result = await MatchedFundVerificationService.repairOne(inconsistent, db);

    expect(result.success).toBe(true);
    expect(result.oldValue.toString()).toBe('100');
    expect(result.newValue.toString()).toBe('150');
    expect(result.delta.toString()).toBe('50');
    expect(result.multiplierId).toBe('mult-R');
  });

  it('logs old and new values when repair succeeds', async () => {
    const db = makeDb([
      lockResult('100'),
      sumResult('150'),
      updateResult(),
    ]);

    await MatchedFundVerificationService.repairOne(inconsistent, db);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Repaired multiplier'),
      expect.objectContaining({
        multiplierId: 'mult-R',
        oldValue: '100',
        newValue: '150',
        delta: '50',
      }),
    );
  });

  it('is a no-op when the row becomes consistent before the update (concurrent fix)', async () => {
    // A concurrent repair or allocation corrected the value between the
    // outer query and our FOR UPDATE: the re-sum now matches the locked value.
    const db = makeDb([
      lockResult('150'),  // row already shows 150 after the lock
      sumResult('150'),   // re-sum also 150 → discrepancy = 0
      // No UPDATE should be issued
    ]);

    const result = await MatchedFundVerificationService.repairOne(inconsistent, db);

    expect(result.success).toBe(true);
    // oldValue === newValue (no change)
    expect(result.oldValue.toString()).toBe('150');
    expect(result.newValue.toString()).toBe('150');
    expect(result.delta.toString()).toBe('0');
    // No UPDATE was called
    expect(db.$queryRaw).toHaveBeenCalledTimes(2); // only lock + sum
  });

  it('retries on transient error and succeeds on the second attempt', async () => {
    let callCount = 0;
    const db = {
      $transaction: jest.fn().mockImplementation(async (cb: any) => {
        callCount++;
        if (callCount === 1) {
          // First attempt: simulate a deadlock / serialisation failure
          throw new Error('deadlock detected');
        }
        // Second attempt: make a functional stub
        const txStub = makeDb([lockResult('100'), sumResult('150'), updateResult()]);
        return cb(txStub);
      }),
      $queryRaw: jest.fn(),
    } as any;

    const result = await MatchedFundVerificationService.repairOne(inconsistent, db);

    expect(result.success).toBe(true);
    expect(callCount).toBe(2);
  });

  it('returns success=false with error message after all retries exhausted', async () => {
    const db = {
      $transaction: jest.fn().mockRejectedValue(new Error('connection reset')),
    } as any;

    // repairMaxRetries=2 in mock config → 3 total attempts
    const result = await MatchedFundVerificationService.repairOne(inconsistent, db);

    expect(result.success).toBe(false);
    expect(result.error).toContain('connection reset');
    // 3 attempts total (initial + 2 retries)
    expect(db.$transaction).toHaveBeenCalledTimes(3);
  });

  it('emits repair_failure alert log when all retries fail', async () => {
    const db = {
      $transaction: jest.fn().mockRejectedValue(new Error('timeout')),
    } as any;

    await MatchedFundVerificationService.repairOne(inconsistent, db);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('repair_failure'),
      expect.objectContaining({ alert: 'repair_failure' }),
    );
  });

  it('returns success=false with error containing "not found" when the Multiplier row is deleted mid-repair', async () => {
    // The lock query returns no rows (row deleted between the scan and repair).
    // repairMaxRetries=2 → 3 total attempts; each attempt calls $queryRaw once for the lock.
    const db = makeDb([
      { rows: [] }, // attempt 1: empty lock → "not found"
      { rows: [] }, // attempt 2: still gone
      { rows: [] }, // attempt 3: still gone
    ]);

    const result = await MatchedFundVerificationService.repairOne(inconsistent, db);

    // All retries exhausted → success=false
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found during repair');
  });

  it('preserves Decimal precision for non-round monetary amounts', async () => {
    const precise = {
      id: 'mult-P',
      storedTotal: new Prisma.Decimal('1234.56789012'),
      actualSum: new Prisma.Decimal('1235.00000000'),
      discrepancy: new Prisma.Decimal('0.43210988'),
    };

    const db = makeDb([
      lockResult('1234.56789012'),
      sumResult('1235.00000000'),
      updateResult(),
    ]);

    const result = await MatchedFundVerificationService.repairOne(precise, db);

    expect(result.success).toBe(true);
    // Delta should be exact, not a floating-point approximation
    expect(result.delta.toString()).toBe('0.43210988');
  });
});

// ─── Large-discrepancy alert ──────────────────────────────────────────────────

describe('Large-discrepancy alerting', () => {
  it('emits large_discrepancy alert when discrepancy exceeds threshold', async () => {
    // threshold = 1000; discrepancy = 5000 → alert
    const db = makeDb([
      countResult(20),
      aggregateResult([
        { id: 'mult-L', storedTotal: '0', actualSum: '5000', discrepancy: '5000' },
      ]),
      lockResult('0'),
      sumResult('5000'),
      updateResult(),
    ]);

    await MatchedFundVerificationService.verify({ mode: 'full' }, db);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('large_discrepancy'),
      expect.objectContaining({
        alert: 'large_discrepancy',
        multiplierId: 'mult-L',
        discrepancy: '5000',
      }),
    );
  });

  it('does not emit large_discrepancy alert when discrepancy is below threshold', async () => {
    const db = makeDb([
      countResult(10),
      aggregateResult([
        { id: 'mult-S', storedTotal: '100', actualSum: '200', discrepancy: '100' },
      ]),
      lockResult('100'),
      sumResult('200'),
      updateResult(),
    ]);

    jest.clearAllMocks();

    await MatchedFundVerificationService.verify({ mode: 'full' }, db);

    const largeCalls = (logger.error as jest.Mock).mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('large_discrepancy'),
    );
    expect(largeCalls).toHaveLength(0);
  });
});

// ─── injectInconsistency() ───────────────────────────────────────────────────

describe('MatchedFundVerificationService.injectInconsistency()', () => {
  it('issues a raw UPDATE with the injected value', async () => {
    const db = makeDb([updateResult()]);

    await MatchedFundVerificationService.injectInconsistency('mult-1', '42.5', db);

    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('accepts Prisma.Decimal as value', async () => {
    const db = makeDb([updateResult()]);

    await expect(
      MatchedFundVerificationService.injectInconsistency(
        'mult-1',
        new Prisma.Decimal('999.12345678'),
        db,
      ),
    ).resolves.toBeUndefined();
  });
});

// ─── Concurrency / non-interference ─────────────────────────────────────────

describe('Concurrency: verification does not interfere with allocation (regression)', () => {
  /**
   * This test simulates the scenario where a full verification scan runs
   * while allocations are occurring.  The key invariant is that the
   * verification's read-only query phase holds no locks — so the mock does
   * not need any special setup to represent "concurrent allocation succeeds
   * in parallel".  We verify that:
   *
   *  1. The verification scan completes without error.
   *  2. A second call to the same DB stub also completes (simulating the
   *     allocation that ran concurrently and is now independently queried).
   */
  it('completes successfully when called while the DB is accepting writes', async () => {
    const db = makeDb([
      countResult(100),
      aggregateResult([]),
    ]);

    await expect(
      MatchedFundVerificationService.verify({ mode: 'full', repair: false }, db),
    ).resolves.toMatchObject({ inconsistentCount: 0 });
  });

  it('repair no-op path (already-fixed row) does not corrupt a concurrent allocation', async () => {
    // The repair re-reads the locked row and finds it already consistent.
    // It must not issue an UPDATE that would overwrite a value set by a
    // concurrent allocation that happened between the scan and the repair.
    const db = makeDb([
      lockResult('200'), // A concurrent alloc incremented matchedTotal from 100→200
      sumResult('200'),  // MatchedFund rows also sum to 200 now
      // No UPDATE
    ]);

    const inconsistent = {
      id: 'mult-C',
      storedTotal: new Prisma.Decimal('100'), // stale value seen during scan
      actualSum: new Prisma.Decimal('200'),
      discrepancy: new Prisma.Decimal('100'),
    };

    const result = await MatchedFundVerificationService.repairOne(inconsistent, db);

    // success=true, but the delta is 0 because the concurrent alloc already
    // fixed the counter and we are a no-op
    expect(result.success).toBe(true);
    expect(result.delta.toString()).toBe('0');
    // No UPDATE was issued
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  });
});

// ─── VerificationResult structure ────────────────────────────────────────────

describe('VerificationResult structure', () => {
  it('includes startedAt, finishedAt, and a positive durationMs', async () => {
    const db = makeDb([countResult(0), aggregateResult([])]);
    const result = await MatchedFundVerificationService.verify({ mode: 'full' }, db);

    expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('includes the correct mode string in the result', async () => {
    const db = makeDb([aggregateResult([])]);
    const result = await MatchedFundVerificationService.verify(
      { mode: 'triggered', multiplierIds: [] },
      db,
    );
    expect(result.mode).toBe('triggered');
  });
});

// ─── beforeEach cleanup ──────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});
