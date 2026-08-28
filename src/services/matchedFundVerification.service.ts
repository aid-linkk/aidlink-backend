/**
 * MatchedFundVerificationService
 *
 * ─── ADR: Consistency Verification and Repair for matchedTotal ─────────────
 *
 * PROBLEM
 * -------
 * Multiplier.matchedTotal is a denormalized counter that must equal the sum of
 * matchedAmount from all non-refunded MatchedFund rows (refundedAt IS NULL)
 * for that multiplier. While the allocation and refund paths maintain this
 * invariant transactionally, several out-of-band scenarios can cause drift:
 *
 *   1. Direct DB writes (migrations, admin fixes) that bypass the service.
 *   2. Partial transaction failures where the MatchedFund INSERT commits but
 *      the Multiplier UPDATE fails (theoretically impossible inside a single
 *      TX, but can happen if connection is severed after the CTE fires).
 *   3. Historical data: if the backfill in 20260727_add_multiplier_matched_total
 *      was incomplete, pre-existing rows started from a wrong baseline.
 *   4. Refund edge cases: donation status changed without matched-fund reversal.
 *
 * VERIFICATION STRATEGY
 * ---------------------
 * A single SQL query aggregates the ground truth for ALL multipliers at once:
 *
 *   SELECT m.id, m."matchedTotal",
 *          COALESCE(SUM(mf."matchedAmount"), 0) AS "actualSum"
 *   FROM "Multiplier" m
 *   LEFT JOIN "MatchedFund" mf
 *          ON mf."multiplierId" = m.id
 *         AND mf."refundedAt" IS NULL
 *   GROUP BY m.id, m."matchedTotal"
 *   HAVING ABS(m."matchedTotal" - COALESCE(SUM(mf."matchedAmount"), 0))
 *          > <threshold>
 *
 * This runs server-side, never loads individual rows into Node.js memory, and
 * scales to millions of MatchedFund rows with a single index scan on
 * (multiplierId) + (refundedAt).
 *
 * For SAMPLING mode we use TABLESAMPLE SYSTEM(pct) to check a random fraction
 * of the Multiplier table — cheap for high-frequency checks.
 *
 * REPAIR STRATEGY
 * ---------------
 * For each inconsistent multiplier:
 *   1. Open an interactive transaction.
 *   2. Lock the Multiplier row with FOR UPDATE (same lock used by claimMatchCap
 *      and refundDonation, so repair is serialized against concurrent allocations).
 *   3. Re-compute the true sum inside the transaction (avoids a TOCTOU between
 *      the detection query and the repair UPDATE).
 *   4. UPDATE Multiplier.matchedTotal to the recomputed sum.
 *   5. Commit — releasing the lock immediately to minimize allocation latency.
 *
 * The two-step detect-then-repair pattern is safe because:
 *   - The FOR UPDATE in step 2 prevents concurrent allocations from modifying
 *     matchedTotal between the re-read in step 3 and the UPDATE in step 4.
 *   - If a concurrent allocation commits between detection and repair, the
 *     re-read in step 3 already sees the incremented matchedTotal, so the
 *     repair sets the correct value and does not accidentally roll it back.
 *
 * ALERTING THRESHOLDS
 * -------------------
 * Two alert conditions are checked after each verification run:
 *   - Systemic threshold: >X% of checked multipliers are inconsistent.
 *   - Large discrepancy: any single multiplier exceeds Y absolute difference.
 * Both are configurable via environment variables.
 *
 * PRECISION
 * ---------
 * All arithmetic uses Prisma.Decimal (decimal.js). The detection threshold is
 * also a Decimal to avoid floating-point noise in the comparison.
 *
 * IDEMPOTENCY
 * -----------
 * Re-running verification is safe: the repair UPDATE is idempotent — setting
 * matchedTotal to the current true sum is a no-op if it is already correct.
 */

import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import logger from '../config/logger';
import { config } from '../config';

// ─── Public types ─────────────────────────────────────────────────────────────

export type VerificationMode = 'FULL' | 'SAMPLE' | 'TRIGGERED';

export interface InconsistencyRecord {
  multiplierId: string;
  storedTotal: Prisma.Decimal;
  actualSum: Prisma.Decimal;
  /** actualSum − storedTotal (signed: positive means under-count, negative over-count) */
  delta: Prisma.Decimal;
}

export interface RepairRecord extends InconsistencyRecord {
  repairedAt: Date;
  success: boolean;
  error?: string;
}

export interface VerificationResult {
  mode: VerificationMode;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  checkedCount: number;
  inconsistentCount: number;
  repairedCount: number;
  failedRepairCount: number;
  inconsistencies: InconsistencyRecord[];
  repairs: RepairRecord[];
  alerts: VerificationAlert[];
}

export interface VerificationAlert {
  type: 'SYSTEMIC_INCONSISTENCY' | 'LARGE_DISCREPANCY' | 'REPAIR_FAILURE';
  message: string;
  details: Record<string, unknown>;
}

// ─── Raw query result types ───────────────────────────────────────────────────

interface InconsistencyRow {
  id: string;
  matchedTotal: string;
  actualSum: string;
}

interface ActualSumRow {
  actualSum: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class MatchedFundVerificationService {
  /**
   * Run the consistency check and optionally auto-repair inconsistencies.
   *
   * @param mode         FULL = all multipliers, SAMPLE = random subset,
   *                     TRIGGERED = all multipliers (like FULL, used to
   *                     distinguish the call source in logs/alerts).
   * @param autoRepair   When true, repair detected inconsistencies.
   * @param samplePct    Percentage of Multiplier rows to check in SAMPLE mode
   *                     (1–100). Ignored for FULL/TRIGGERED.
   */
  static async verify(
    mode: VerificationMode = 'FULL',
    autoRepair = true,
    samplePct?: number,
  ): Promise<VerificationResult> {
    const startedAt = new Date();
    const cfg = config.matchedFundVerification;
    const threshold = new Prisma.Decimal(cfg.inconsistencyThreshold);
    const effectiveSamplePct = samplePct ?? cfg.samplePercent;

    logger.info(`MatchedFundVerification: starting ${mode} verification`, {
      autoRepair,
      samplePct: mode === 'SAMPLE' ? effectiveSamplePct : undefined,
    });

    // ── 1. Detect inconsistencies ─────────────────────────────────────────────
    const inconsistencies = await this.detectInconsistencies(mode, effectiveSamplePct, threshold);
    const checkedCount = await this.countChecked(mode, effectiveSamplePct);

    logger.info(`MatchedFundVerification: found ${inconsistencies.length} inconsistencies in ${checkedCount} multipliers`);

    // ── 2. Repair ─────────────────────────────────────────────────────────────
    const repairs: RepairRecord[] = [];
    if (autoRepair && inconsistencies.length > 0) {
      for (const inc of inconsistencies) {
        const repair = await this.repairOne(inc);
        repairs.push(repair);
      }
    }

    const finishedAt = new Date();
    const repairedCount = repairs.filter((r) => r.success).length;
    const failedRepairCount = repairs.filter((r) => !r.success).length;

    // ── 3. Alerting ───────────────────────────────────────────────────────────
    const alerts = this.buildAlerts({
      checkedCount,
      inconsistencies,
      repairs,
      cfg,
      threshold,
    });

    for (const alert of alerts) {
      logger.warn(`MatchedFundVerification ALERT [${alert.type}]: ${alert.message}`, alert.details);
    }

    const result: VerificationResult = {
      mode,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      checkedCount,
      inconsistentCount: inconsistencies.length,
      repairedCount,
      failedRepairCount,
      inconsistencies,
      repairs,
      alerts,
    };

    logger.info(`MatchedFundVerification: completed ${mode} in ${result.durationMs}ms`, {
      checkedCount,
      inconsistentCount: inconsistencies.length,
      repairedCount,
      failedRepairCount,
      alertCount: alerts.length,
    });

    return result;
  }

  // ─── Detection ──────────────────────────────────────────────────────────────

  /**
   * Single-query aggregation to find all multipliers whose matchedTotal
   * deviates from the true sum of non-refunded MatchedFund.matchedAmount.
   *
   * For SAMPLE mode we use TABLESAMPLE SYSTEM(pct) which is fast (block-level
   * random sampling, no full sequential scan) and good enough for high-
   * frequency heartbeat checks.
   *
   * The HAVING clause filters server-side so only rows with actual drift are
   * returned to Node.js — typically zero rows under normal operation.
   */
  private static async detectInconsistencies(
    mode: VerificationMode,
    samplePct: number,
    threshold: Prisma.Decimal,
  ): Promise<InconsistencyRecord[]> {
    const thresholdStr = threshold.toString();

    let rows: InconsistencyRow[];

    if (mode === 'SAMPLE') {
      // Clamp sample percent to [1, 100] to satisfy TABLESAMPLE constraint.
      const pct = Math.max(1, Math.min(100, samplePct));
      rows = await prisma.$queryRaw<InconsistencyRow[]>(Prisma.sql`
        SELECT
          m.id,
          m."matchedTotal"::text           AS "matchedTotal",
          COALESCE(SUM(mf."matchedAmount"), 0)::text AS "actualSum"
        FROM   "Multiplier" TABLESAMPLE SYSTEM(${pct}) m
        LEFT JOIN "MatchedFund" mf
               ON mf."multiplierId" = m.id
              AND mf."refundedAt" IS NULL
        GROUP BY m.id, m."matchedTotal"
        HAVING ABS(m."matchedTotal"
                   - COALESCE(SUM(mf."matchedAmount"), 0)) > ${thresholdStr}::numeric
      `);
    } else {
      // FULL / TRIGGERED: check every Multiplier row.
      rows = await prisma.$queryRaw<InconsistencyRow[]>(Prisma.sql`
        SELECT
          m.id,
          m."matchedTotal"::text           AS "matchedTotal",
          COALESCE(SUM(mf."matchedAmount"), 0)::text AS "actualSum"
        FROM   "Multiplier" m
        LEFT JOIN "MatchedFund" mf
               ON mf."multiplierId" = m.id
              AND mf."refundedAt" IS NULL
        GROUP BY m.id, m."matchedTotal"
        HAVING ABS(m."matchedTotal"
                   - COALESCE(SUM(mf."matchedAmount"), 0)) > ${thresholdStr}::numeric
      `);
    }

    return rows.map((row) => {
      const storedTotal = new Prisma.Decimal(row.matchedTotal);
      const actualSum = new Prisma.Decimal(row.actualSum);
      return {
        multiplierId: row.id,
        storedTotal,
        actualSum,
        delta: actualSum.minus(storedTotal),
      };
    });
  }

  /**
   * Returns the number of multipliers that were checked (for the
   * inconsistency-rate alert calculation).
   */
  private static async countChecked(mode: VerificationMode, samplePct: number): Promise<number> {
    if (mode === 'SAMPLE') {
      // TABLESAMPLE is approximate; count separately so we can compute a rate.
      const pct = Math.max(1, Math.min(100, samplePct));
      const rows = await prisma.$queryRaw<[{ cnt: string }]>(
        Prisma.sql`SELECT COUNT(*)::text AS cnt FROM "Multiplier" TABLESAMPLE SYSTEM(${pct})`,
      );
      return parseInt(rows[0].cnt, 10);
    }
    return prisma.multiplier.count();
  }

  // ─── Repair ─────────────────────────────────────────────────────────────────

  /**
   * Repair a single inconsistent multiplier:
   *   1. Lock the Multiplier row FOR UPDATE (serialized with claimMatchCap).
   *   2. Re-aggregate the true sum *inside* the transaction (avoids TOCTOU).
   *   3. UPDATE matchedTotal to the freshly computed true sum.
   *   4. Commit.
   *
   * If the repair transaction fails (e.g. deadlock, connection error), the
   * error is captured and returned in RepairRecord rather than thrown, so
   * a single failure does not abort repairs for other multipliers.
   */
  private static async repairOne(inc: InconsistencyRecord): Promise<RepairRecord> {
    const repairedAt = new Date();
    try {
      await prisma.$transaction(
        async (tx) => {
          // Step 1: Lock the row. This serializes with claimMatchCap so no
          // concurrent allocation can slip in between our re-read and our write.
          await tx.$queryRaw(Prisma.sql`
            SELECT "matchedTotal"
            FROM   "Multiplier"
            WHERE  id = ${inc.multiplierId}
            FOR UPDATE
          `);

          // Step 2: Re-compute the true sum inside the transaction so we
          // always write the post-lock accurate value, even if a concurrent
          // allocation committed between our detection scan and this repair.
          const rows = await tx.$queryRaw<ActualSumRow[]>(Prisma.sql`
            SELECT COALESCE(SUM(mf."matchedAmount"), 0)::text AS "actualSum"
            FROM   "MatchedFund" mf
            WHERE  mf."multiplierId" = ${inc.multiplierId}
              AND  mf."refundedAt" IS NULL
          `);
          const trueSum = new Prisma.Decimal(rows[0].actualSum);

          // Step 3: Update to the recomputed value.
          await tx.$queryRaw(Prisma.sql`
            UPDATE "Multiplier"
            SET    "matchedTotal" = ${trueSum.toString()}::numeric,
                   "updatedAt"   = NOW()
            WHERE  id = ${inc.multiplierId}
          `);

          logger.info('MatchedFundVerification: repaired multiplier', {
            multiplierId: inc.multiplierId,
            oldValue: inc.storedTotal.toString(),
            newValue: trueSum.toString(),
            delta: inc.delta.toString(),
          });
        },
        {
          // Keep the repair transaction short to minimise lock hold time.
          timeout: config.matchedFundVerification.repairTimeoutMs,
        },
      );

      return {
        ...inc,
        repairedAt,
        success: true,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('MatchedFundVerification: repair failed', {
        multiplierId: inc.multiplierId,
        error,
      });
      return {
        ...inc,
        repairedAt,
        success: false,
        error,
      };
    }
  }

  // ─── Alerting ────────────────────────────────────────────────────────────────

  private static buildAlerts({
    checkedCount,
    inconsistencies,
    repairs,
    cfg,
    threshold: _threshold,
  }: {
    checkedCount: number;
    inconsistencies: InconsistencyRecord[];
    repairs: RepairRecord[];
    cfg: typeof config.matchedFundVerification;
    threshold: Prisma.Decimal;
  }): VerificationAlert[] {
    const alerts: VerificationAlert[] = [];

    // Alert 1: systemic — too many multipliers inconsistent.
    if (checkedCount > 0) {
      const inconsistencyRate = inconsistencies.length / checkedCount;
      if (inconsistencyRate > cfg.alertSystemicThreshold) {
        alerts.push({
          type: 'SYSTEMIC_INCONSISTENCY',
          message: `${(inconsistencyRate * 100).toFixed(1)}% of checked multipliers are inconsistent — possible systemic drift`,
          details: {
            inconsistentCount: inconsistencies.length,
            checkedCount,
            rate: inconsistencyRate,
            threshold: cfg.alertSystemicThreshold,
          },
        });
      }
    }

    // Alert 2: large discrepancy on any single multiplier.
    const largeThreshold = new Prisma.Decimal(cfg.alertLargeDiscrepancyAmount);
    for (const inc of inconsistencies) {
      if (inc.delta.abs().greaterThan(largeThreshold)) {
        alerts.push({
          type: 'LARGE_DISCREPANCY',
          message: `Multiplier ${inc.multiplierId} has a discrepancy of ${inc.delta.toString()} (threshold: ${cfg.alertLargeDiscrepancyAmount})`,
          details: {
            multiplierId: inc.multiplierId,
            storedTotal: inc.storedTotal.toString(),
            actualSum: inc.actualSum.toString(),
            delta: inc.delta.toString(),
          },
        });
      }
    }

    // Alert 3: repair failures.
    const failed = repairs.filter((r) => !r.success);
    for (const r of failed) {
      alerts.push({
        type: 'REPAIR_FAILURE',
        message: `Repair failed for multiplier ${r.multiplierId}: ${r.error}`,
        details: {
          multiplierId: r.multiplierId,
          storedTotal: r.storedTotal.toString(),
          actualSum: r.actualSum.toString(),
          error: r.error,
        },
      });
    }

    return alerts;
  }

  // ─── Utility ─────────────────────────────────────────────────────────────────

  /**
   * Inject a test inconsistency by directly setting matchedTotal to a wrong
   * value. ONLY safe to call in test environments — use to simulate drift
   * without going through normal allocation paths.
   *
   * @throws {Error} if called outside a test environment.
   */
  static async injectInconsistencyForTesting(
    multiplierId: string,
    wrongValue: Prisma.Decimal.Value,
  ): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('injectInconsistencyForTesting is only available in test environments');
    }
    await prisma.$queryRaw(Prisma.sql`
      UPDATE "Multiplier"
      SET    "matchedTotal" = ${new Prisma.Decimal(wrongValue).toString()}::numeric
      WHERE  id = ${multiplierId}
    `);
  }
}
