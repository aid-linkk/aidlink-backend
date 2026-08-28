/**
 * MatchedFundVerificationService
 *
 * ─── Purpose ─────────────────────────────────────────────────────────────────
 * Verifies and, where permitted, repairs the `matchedTotal` counter on every
 * `Multiplier` row.  `matchedTotal` is the running sum of all `matchedAmount`
 * values in the linked `MatchedFund` rows (excluding refunded ones).  It is
 * maintained atomically during allocation and refund, but several out-of-band
 * paths (migrations, admin scripts, connection faults) can cause it to drift
 * from the true sum.  This service is the correctness net that catches and
 * corrects such drift.
 *
 * ─── Verification algorithm ──────────────────────────────────────────────────
 * A single aggregation query computes the true sum for every Multiplier in one
 * round-trip:
 *
 *   SELECT m.id, m."matchedTotal",
 *          COALESCE(SUM(mf."matchedAmount"), 0) AS actual_sum
 *   FROM "Multiplier" m
 *   LEFT JOIN "MatchedFund" mf
 *          ON mf."multiplierId" = m.id AND mf."refundedAt" IS NULL
 *   GROUP BY m.id, m."matchedTotal"
 *   HAVING ABS(m."matchedTotal" - COALESCE(SUM(mf."matchedAmount"), 0)) > $threshold
 *
 * Refunded `MatchedFund` rows are excluded because `refundDonation` decrements
 * `matchedTotal` at the same time it sets `refundedAt`, keeping both sides of
 * the invariant in sync.
 *
 * For sampling passes the query adds a TABLESAMPLE SYSTEM($pct) clause on the
 * Multiplier scan so the DB only examines a fraction of rows.  Note that
 * TABLESAMPLE operates on 8 KB pages, not individual rows, so the effective
 * sample fraction can differ from the nominal percentage; this is acceptable for
 * an early-warning signal where perfect coverage is not required.
 *
 * ─── Repair algorithm ────────────────────────────────────────────────────────
 * For each inconsistent row the service opens an interactive transaction and:
 *
 *   1. Re-reads `matchedTotal` with FOR UPDATE (serialises against concurrent
 *      allocation/refund operations that also hold this lock).
 *   2. Re-computes the true sum from MatchedFund (inside the same tx so the
 *      snapshot is consistent with the locked row).
 *   3. Re-checks the discrepancy — if a concurrent transaction already corrected
 *      the value the repair is a no-op (idempotent).
 *   4. Writes the corrected value.
 *
 * The repair FOR UPDATE lock participates in the same lock-ordering protocol as
 * claimMatchCap (Multiplier lock first), so no deadlock is possible between
 * normal allocation and repair.
 *
 * ─── Alerting ────────────────────────────────────────────────────────────────
 * Three alert conditions are checked and logged at ERROR level:
 *
 *   • systemic_inconsistency: ratio of inconsistent rows > alertInconsistencyRateThreshold
 *     — aborts the repair phase entirely to avoid patching widespread corruption.
 *   • large_discrepancy: |discrepancy| > alertLargeDiscrepancyThreshold for a single row.
 *   • repair_failure: the repair transaction failed after all retries.
 *
 * In production these log lines should be forwarded to an alerting backend
 * (PagerDuty, Datadog, etc.) by the log shipper.  The service does not integrate
 * with any alerting SDK directly — that concern belongs at the infrastructure
 * layer.
 *
 * ─── Concurrency safety ──────────────────────────────────────────────────────
 * Verification (read-only) is safe to run at any time — it holds no locks and
 * does not interfere with concurrent allocation or refund transactions.
 *
 * Repair acquires an exclusive Multiplier row lock for the duration of each
 * single-row transaction (≪1 s typical).  Concurrent allocations against the
 * same Multiplier row will block briefly and then proceed normally; the repair
 * does not prevent them from claiming capacity.
 *
 * ─── Idempotency ─────────────────────────────────────────────────────────────
 * Running verify+repair N times produces the same end-state as running it once.
 * The re-read inside the repair transaction ensures that if the row was already
 * corrected by a previous pass, the no-op branch is taken.
 *
 * ─── Testing surface ─────────────────────────────────────────────────────────
 * The `prismaClient` parameter on all public methods allows callers to inject
 * a mock PrismaClient (or a transaction client) in unit tests.  The
 * `injectInconsistency` method is a test-only helper that directly writes a
 * stale `matchedTotal` so tests can simulate drift without needing real DB
 * concurrent writes.
 */

import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { config } from '../config';
import logger from '../config/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

/** One row returned by the aggregate verification query. */
export interface InconsistentMultiplier {
  /** Multiplier primary key. */
  id: string;
  /** The stale counter currently stored in the DB. */
  storedTotal: Prisma.Decimal;
  /** The true sum computed from MatchedFund rows. */
  actualSum: Prisma.Decimal;
  /** actualSum − storedTotal (can be negative). */
  discrepancy: Prisma.Decimal;
}

/** Summary produced by a single verification run. */
export interface VerificationResult {
  /** Verification mode that produced this result. */
  mode: 'full' | 'sampling' | 'triggered';
  /** ISO-8601 timestamp when verification started. */
  startedAt: string;
  /** ISO-8601 timestamp when verification finished (after any repairs). */
  finishedAt: string;
  /** Total number of Multiplier rows examined. */
  examined: number;
  /** Number of rows found to be inconsistent. */
  inconsistentCount: number;
  /** Number of rows successfully repaired. */
  repairedCount: number;
  /** Number of rows that could not be repaired after all retries. */
  repairFailureCount: number;
  /** Details of each inconsistency found. */
  inconsistencies: InconsistentMultiplier[];
  /** True if the systemic-inconsistency threshold was breached. */
  systemicAlert: boolean;
  /** Duration of the verification + repair phase in milliseconds. */
  durationMs: number;
}

/** Result of attempting to repair a single Multiplier row. */
export interface RepairResult {
  multiplierId: string;
  /** Value of matchedTotal before repair. */
  oldValue: Prisma.Decimal;
  /** Value of matchedTotal after repair (equals actualSum). */
  newValue: Prisma.Decimal;
  /** newValue − oldValue. */
  delta: Prisma.Decimal;
  success: boolean;
  /** Human-readable error message if success=false. */
  error?: string;
}

/** Options for the verify-and-repair call. */
export interface VerifyOptions {
  mode: 'full' | 'sampling' | 'triggered';
  /**
   * For mode='triggered': only verify these specific Multiplier IDs.
   * For 'full' and 'sampling', this field is ignored.
   */
  multiplierIds?: string[];
  /** Override the sampling percentage for this run (1–100). */
  samplingPercent?: number;
  /** When false, inconsistencies are logged but not repaired. */
  repair?: boolean;
}

// ─── Row type returned by the raw aggregate query ────────────────────────────

interface AggregateRow {
  id: string;
  storedTotal: string;
  actualSum: string;
  discrepancy: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class MatchedFundVerificationService {
  /**
   * Main entry point. Runs a full, sampling, or triggered verification pass
   * and optionally repairs all inconsistent rows.
   *
   * @param opts  Verification options.
   * @param db    Injectable Prisma client (defaults to the module-level singleton).
   *              Pass a mock or a transaction client in tests.
   */
  static async verify(
    opts: VerifyOptions,
    db: typeof prisma = prisma,
  ): Promise<VerificationResult> {
    const cfg = config.matchedFundVerification;
    const startedAt = new Date();
    const precisionThreshold = new Prisma.Decimal(cfg.precisionThreshold);
    const largeDiscrepancyThreshold = new Prisma.Decimal(cfg.alertLargeDiscrepancyThreshold);
    const doRepair = opts.repair !== false; // default true

    logger.info(`[matchedFundVerification] Starting ${opts.mode} verification pass`, {
      mode: opts.mode,
      repair: doRepair,
      samplingPercent: opts.samplingPercent ?? cfg.samplingPercent,
    });

    // ── 1. Run the aggregation query ──────────────────────────────────────────
    let rows: InconsistentMultiplier[];
    let examined: number;

    if (opts.mode === 'triggered' && opts.multiplierIds !== undefined) {
      // For triggered mode, always use queryTriggered even with an empty list
      // (queryTriggered short-circuits immediately for empty arrays).
      ({ rows, examined } = await this.queryTriggered(
        opts.multiplierIds,
        precisionThreshold,
        db,
      ));
    } else if (opts.mode === 'sampling') {
      const pct = opts.samplingPercent ?? cfg.samplingPercent;
      ({ rows, examined } = await this.querySampling(pct, precisionThreshold, db));
    } else {
      ({ rows, examined } = await this.queryFull(precisionThreshold, db));
    }

    logger.info(
      `[matchedFundVerification] Query complete: examined=${examined} inconsistent=${rows.length}`,
    );

    // ── 2. Systemic-inconsistency alert ───────────────────────────────────────
    const inconsistencyRate = examined > 0 ? rows.length / examined : 0;
    const systemicAlert = inconsistencyRate > cfg.alertInconsistencyRateThreshold;

    if (systemicAlert) {
      logger.error('[matchedFundVerification] ALERT: systemic_inconsistency', {
        alert: 'systemic_inconsistency',
        inconsistentCount: rows.length,
        examined,
        inconsistencyRate,
        threshold: cfg.alertInconsistencyRateThreshold,
      });
    }

    // ── 3. Large-discrepancy alerts ───────────────────────────────────────────
    for (const row of rows) {
      if (row.discrepancy.abs().greaterThan(largeDiscrepancyThreshold)) {
        logger.error('[matchedFundVerification] ALERT: large_discrepancy', {
          alert: 'large_discrepancy',
          multiplierId: row.id,
          storedTotal: row.storedTotal.toString(),
          actualSum: row.actualSum.toString(),
          discrepancy: row.discrepancy.toString(),
          threshold: largeDiscrepancyThreshold.toString(),
        });
      }
    }

    // ── 4. Repair phase ───────────────────────────────────────────────────────
    let repairedCount = 0;
    let repairFailureCount = 0;

    if (doRepair && !systemicAlert && rows.length > 0) {
      const batchLimit = cfg.repairBatchLimit;
      const rowsToRepair = batchLimit > 0 ? rows.slice(0, batchLimit) : rows;

      if (batchLimit > 0 && rows.length > batchLimit) {
        logger.warn(
          `[matchedFundVerification] repairBatchLimit=${batchLimit} reached; ` +
            `${rows.length - batchLimit} inconsistencies deferred to next run`,
        );
      }

      for (const inconsistent of rowsToRepair) {
        const result = await this.repairOne(inconsistent, db);
        if (result.success) {
          repairedCount++;
        } else {
          repairFailureCount++;
        }
      }
    } else if (doRepair && systemicAlert) {
      logger.warn(
        '[matchedFundVerification] Repair aborted due to systemic inconsistency alert; ' +
          'manual investigation required',
      );
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    const result: VerificationResult = {
      mode: opts.mode,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      examined,
      inconsistentCount: rows.length,
      repairedCount,
      repairFailureCount,
      inconsistencies: rows,
      systemicAlert,
      durationMs,
    };

    logger.info('[matchedFundVerification] Pass complete', {
      mode: opts.mode,
      examined,
      inconsistentCount: rows.length,
      repairedCount,
      repairFailureCount,
      systemicAlert,
      durationMs,
    });

    return result;
  }

  // ─── Query helpers ──────────────────────────────────────────────────────────

  /**
   * Full verification: scan all Multiplier rows.
   * Uses a single aggregation JOIN — no rows are loaded into Node memory.
   */
  static async queryFull(
    precisionThreshold: Prisma.Decimal,
    db: typeof prisma = prisma,
  ): Promise<{ rows: InconsistentMultiplier[]; examined: number }> {
    // Count is read in a separate fast query (no JOIN) so the aggregate query
    // only returns inconsistent rows, keeping the result set small.
    const [countResult, aggRows] = await Promise.all([
      db.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`SELECT COUNT(*) AS total FROM "Multiplier"`),
      db.$queryRaw<AggregateRow[]>(Prisma.sql`
        SELECT
          m.id,
          m."matchedTotal"::text               AS "storedTotal",
          COALESCE(SUM(mf."matchedAmount"), 0)::text AS "actualSum",
          (COALESCE(SUM(mf."matchedAmount"), 0) - m."matchedTotal")::text AS discrepancy
        FROM "Multiplier" m
        LEFT JOIN "MatchedFund" mf
               ON mf."multiplierId" = m.id
              AND mf."refundedAt" IS NULL
        GROUP BY m.id, m."matchedTotal"
        HAVING ABS(COALESCE(SUM(mf."matchedAmount"), 0) - m."matchedTotal")
               > ${precisionThreshold.toString()}::numeric
      `),
    ]);

    const examined = Number(countResult[0]?.total ?? 0);
    return { rows: this.mapAggregateRows(aggRows), examined };
  }

  /**
   * Sampling verification: scan a random TABLESAMPLE SYSTEM($pct) of rows.
   * Fast early-warning pass; does not guarantee complete coverage.
   */
  static async querySampling(
    samplingPercent: number,
    precisionThreshold: Prisma.Decimal,
    db: typeof prisma = prisma,
  ): Promise<{ rows: InconsistentMultiplier[]; examined: number }> {
    // Clamp to valid TABLESAMPLE range.
    const pct = Math.min(Math.max(samplingPercent, 0.000001), 100);

    // Because TABLESAMPLE cannot be used through Prisma's model API and
    // pct is a server-computed number (not user input), we format it directly
    // into the SQL.  pct is already clamped to [0.000001, 100] above.
    const pctLiteral = Prisma.sql`${pct}`;

    const [countResult, aggRows] = await Promise.all([
      db.$queryRaw<Array<{ total: bigint }>>(
        Prisma.sql`SELECT COUNT(*) AS total FROM "Multiplier" TABLESAMPLE SYSTEM(${pctLiteral})`,
      ),
      db.$queryRaw<AggregateRow[]>(Prisma.sql`
        SELECT
          m.id,
          m."matchedTotal"::text               AS "storedTotal",
          COALESCE(SUM(mf."matchedAmount"), 0)::text AS "actualSum",
          (COALESCE(SUM(mf."matchedAmount"), 0) - m."matchedTotal")::text AS discrepancy
        FROM "Multiplier" TABLESAMPLE SYSTEM(${pctLiteral}) m
        LEFT JOIN "MatchedFund" mf
               ON mf."multiplierId" = m.id
              AND mf."refundedAt" IS NULL
        GROUP BY m.id, m."matchedTotal"
        HAVING ABS(COALESCE(SUM(mf."matchedAmount"), 0) - m."matchedTotal")
               > ${precisionThreshold.toString()}::numeric
      `),
    ]);

    const examined = Number(countResult[0]?.total ?? 0);
    return { rows: this.mapAggregateRows(aggRows), examined };
  }

  /**
   * Triggered verification: verify only the specified Multiplier IDs.
   * Used after a deployment, a manual fix, or when an allocation fails.
   */
  static async queryTriggered(
    multiplierIds: string[],
    precisionThreshold: Prisma.Decimal,
    db: typeof prisma = prisma,
  ): Promise<{ rows: InconsistentMultiplier[]; examined: number }> {
    if (multiplierIds.length === 0) {
      return { rows: [], examined: 0 };
    }

    const aggRows = await db.$queryRaw<AggregateRow[]>(Prisma.sql`
      SELECT
        m.id,
        m."matchedTotal"::text               AS "storedTotal",
        COALESCE(SUM(mf."matchedAmount"), 0)::text AS "actualSum",
        (COALESCE(SUM(mf."matchedAmount"), 0) - m."matchedTotal")::text AS discrepancy
      FROM "Multiplier" m
      LEFT JOIN "MatchedFund" mf
             ON mf."multiplierId" = m.id
            AND mf."refundedAt" IS NULL
      WHERE m.id = ANY(${multiplierIds}::text[])
      GROUP BY m.id, m."matchedTotal"
      HAVING ABS(COALESCE(SUM(mf."matchedAmount"), 0) - m."matchedTotal")
             > ${precisionThreshold.toString()}::numeric
    `);

    return { rows: this.mapAggregateRows(aggRows), examined: multiplierIds.length };
  }

  // ─── Repair ─────────────────────────────────────────────────────────────────

  /**
   * Attempts to repair a single inconsistent Multiplier row with retry logic.
   * Returns a `RepairResult` describing the outcome.
   *
   * Concurrency: the FOR UPDATE inside the transaction serialises against
   * concurrent claimMatchCap and refundDonation calls on the same row.
   */
  static async repairOne(
    inconsistent: InconsistentMultiplier,
    db: typeof prisma = prisma,
  ): Promise<RepairResult> {
    const cfg = config.matchedFundVerification;
    const precisionThreshold = new Prisma.Decimal(cfg.precisionThreshold);
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= cfg.repairMaxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(cfg.repairRetryDelayMs);
      }

      try {
        const repairResult = await db.$transaction(async (tx) => {
          // Step 1: Lock the Multiplier row (same lock as claimMatchCap).
          const locked = await tx.$queryRaw<Array<{ matchedTotal: string }>>(Prisma.sql`
            SELECT "matchedTotal"::text AS "matchedTotal"
            FROM "Multiplier"
            WHERE id = ${inconsistent.id}
            FOR UPDATE
          `);

          if (locked.length === 0) {
            throw new Error(`Multiplier ${inconsistent.id} not found during repair`);
          }

          const currentTotal = new Prisma.Decimal(locked[0].matchedTotal);

          // Step 2: Re-compute true sum inside the transaction (consistent snapshot).
          const sumRows = await tx.$queryRaw<Array<{ actual_sum: string }>>(Prisma.sql`
            SELECT COALESCE(SUM("matchedAmount"), 0)::text AS actual_sum
            FROM "MatchedFund"
            WHERE "multiplierId" = ${inconsistent.id}
              AND "refundedAt" IS NULL
          `);

          const actualSum = new Prisma.Decimal(sumRows[0].actual_sum);
          const freshDiscrepancy = actualSum.minus(currentTotal).abs();

          // Step 3: No-op if already consistent (concurrent repair or allocation fixed it).
          if (freshDiscrepancy.lessThanOrEqualTo(precisionThreshold)) {
            return {
              multiplierId: inconsistent.id,
              oldValue: currentTotal,
              newValue: currentTotal,
              delta: new Prisma.Decimal(0),
              success: true,
              alreadyConsistent: true,
            };
          }

          // Step 4: Write the corrected value.
          await tx.$queryRaw`
            UPDATE "Multiplier"
            SET "matchedTotal" = ${actualSum.toString()}::numeric
            WHERE id = ${inconsistent.id}
          `;

          return {
            multiplierId: inconsistent.id,
            oldValue: currentTotal,
            newValue: actualSum,
            delta: actualSum.minus(currentTotal),
            success: true,
            alreadyConsistent: false,
          };
        });

        const outcome: RepairResult = {
          multiplierId: repairResult.multiplierId,
          oldValue: repairResult.oldValue,
          newValue: repairResult.newValue,
          delta: repairResult.delta,
          success: true,
        };

        // Log successful repairs (including no-ops) so the call site (verify)
        // can also log at INFO without duplicating, and standalone callers get
        // observability too.
        if (!repairResult.alreadyConsistent) {
          logger.info('[matchedFundVerification] Repaired multiplier', {
            multiplierId: outcome.multiplierId,
            oldValue: outcome.oldValue.toString(),
            newValue: outcome.newValue.toString(),
            delta: outcome.delta.toString(),
          });
        }

        return outcome;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[matchedFundVerification] Repair attempt ${attempt + 1}/${cfg.repairMaxRetries + 1} ` +
            `failed for multiplier ${inconsistent.id}: ${lastError}`,
        );
      }
    }

    // All retries exhausted.
    const failureResult: RepairResult = {
      multiplierId: inconsistent.id,
      oldValue: inconsistent.storedTotal,
      newValue: inconsistent.storedTotal,
      delta: new Prisma.Decimal(0),
      success: false,
      error: lastError,
    };

    logger.error('[matchedFundVerification] ALERT: repair_failure', {
      alert: 'repair_failure',
      multiplierId: failureResult.multiplierId,
      error: failureResult.error,
    });

    return failureResult;
  }

  // ─── Test utilities ──────────────────────────────────────────────────────────

  /**
   * TEST-ONLY: directly sets `matchedTotal` on a Multiplier row to simulate
   * drift without needing concurrent transactions.  Must never be called in
   * production code paths.
   *
   * @param multiplierId  Target row.
   * @param value         The stale value to inject.
   * @param db            Injectable DB client (defaults to module singleton).
   */
  static async injectInconsistency(
    multiplierId: string,
    value: Prisma.Decimal.Value,
    db: typeof prisma = prisma,
  ): Promise<void> {
    await db.$queryRaw`
      UPDATE "Multiplier"
      SET "matchedTotal" = ${new Prisma.Decimal(value).toString()}::numeric
      WHERE id = ${multiplierId}
    `;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private static mapAggregateRows(rows: AggregateRow[]): InconsistentMultiplier[] {
    return rows.map((r) => ({
      id: r.id,
      storedTotal: new Prisma.Decimal(r.storedTotal),
      actualSum: new Prisma.Decimal(r.actualSum),
      discrepancy: new Prisma.Decimal(r.discrepancy),
    }));
  }
}
