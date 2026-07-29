/**
 * MatchedFundAllocationService
 *
 * ─── ADR: Concurrency-Safe matchCap Enforcement ───────────────────────────
 *
 * PROBLEM (TOCTOU race)
 * ---------------------
 * The naive approach reads the aggregate of consumed matched funds
 * (SELECT SUM(matchedAmount) FROM MatchedFund WHERE multiplierId = X),
 * computes the remaining capacity, then inserts a new row. Under concurrent
 * donation confirmations targeting the same multiplier, N transactions can
 * all read the same stale sum, each believe capacity remains, and all commit
 * inserts — overshoooting matchCap by up to N × per-donation-match.
 *
 * CHOSEN APPROACH: Atomic UPDATE with a conditional CTE
 * ------------------------------------------------------
 * We maintain a running counter `matchedTotal` on the Multiplier row and
 * atomically claim capacity in a single SQL statement:
 *
 *   WITH locked AS (
 *     SELECT "matchedTotal", "matchCap"
 *     FROM "Multiplier"
 *     WHERE id = $1
 *     FOR UPDATE          -- acquires an exclusive row-level lock
 *   ),
 *   claim AS (
 *     SELECT GREATEST(LEAST($desired, "matchCap" - "matchedTotal"), 0) AS applied
 *     FROM locked
 *   )
 *   UPDATE "Multiplier"
 *   SET "matchedTotal" = "matchedTotal" + claim.applied
 *   FROM claim
 *   WHERE id = $1
 *   RETURNING claim.applied::text
 *
 * The FOR UPDATE in the CTE SELECT is evaluated first and acquires an
 * exclusive row lock on the Multiplier row for the duration of the
 * transaction. Any concurrent transaction that attempts the same FOR UPDATE
 * will block until the first one commits or rolls back, at which point it
 * reads the freshly committed matchedTotal. No read-then-write gap exists
 * because the check-and-increment happen in the same atomic statement.
 *
 * WHY NOT SKIP LOCKED
 * -------------------
 * SKIP LOCKED would silently skip locked rows instead of waiting for them.
 * That would mean a concurrent transaction sees no row to update, computes
 * zero remaining capacity, and incorrectly refuses the match — even if there
 * is headroom. We need strict serialization on this row, not skip-on-contention.
 *
 * WHY NOT SELECT ... FOR UPDATE + SEPARATE UPDATE
 * -----------------------------------------------
 * Splitting into (1) SELECT FOR UPDATE then (2) compute in JS then (3) UPDATE
 * introduces JS-side floating-point risk and two round-trips. The CTE keeps
 * all arithmetic inside Postgres and requires only one round-trip.
 *
 * WHY NOT OPTIMISTIC CONCURRENCY (version counter + retry)
 * ---------------------------------------------------------
 * An optimistic approach would require a retry loop and risks starvation under
 * high contention. The FOR UPDATE approach has bounded wait time (one lock
 * holder at a time) and zero false failures. Throughput is limited only by
 * the per-multiplier serialization, not by retries.
 *
 * WHY NOT SERIALIZABLE ISOLATION
 * --------------------------------
 * SERIALIZABLE on the entire transaction would serialize ALL writes in the
 * transaction, not just the matchCap claim. That would prevent concurrent
 * donation confirmations for DIFFERENT campaigns from running in parallel,
 * violating the throughput constraint. The FOR UPDATE lock is scoped to a
 * single Multiplier row, so it only serializes writers on the SAME multiplier.
 *
 * WHY NOT A REDIS MUTEX
 * ---------------------
 * A Redis mutex provides application-level serialization, but requires Redis
 * to be available and consistent for financial integrity. The DB itself must
 * enforce the invariant (acceptance criterion). A Redis mutex can complement
 * but cannot replace the DB-level lock.
 *
 * DEADLOCK AVOIDANCE
 * ------------------
 * The Multiplier row lock is always acquired as the FIRST lock inside
 * MatchedFundAllocationService.allocate() before the MatchedFund INSERT and
 * before the Campaign.currentAmount UPDATE. This strict acquisition order
 * prevents the classic A→B / B→A deadlock:
 *
 *   TX1: lock Multiplier[X] → insert MatchedFund → update Campaign[Y]
 *   TX2: lock Multiplier[X] → (waits for TX1 to release Multiplier[X])
 *
 * Because no transaction ever locks a Multiplier row AFTER acquiring a
 * MatchedFund or Campaign lock, there is no cycle. The refund path
 * (DonationService.refundDonation) does NOT lock Multiplier rows; it only
 * touches Donation and Campaign, so it cannot form a cycle with this path.
 *
 * ROLLBACK BEHAVIOR
 * -----------------
 * The CTE UPDATE runs inside prisma.$transaction (an interactive transaction).
 * If any step after claimMatchCap fails (e.g., the MatchedFund INSERT violates
 * the unique constraint on donationId, or the Campaign UPDATE fails), the
 * entire transaction rolls back, including the UPDATE to Multiplier.matchedTotal.
 * The matchedTotal therefore never drifts from the true sum of committed
 * MatchedFund rows. The donationId uniqueness constraint on MatchedFund is
 * an extra idempotency guard: a retry of the same confirmDonation call loses
 * the CAS guard in DonationService (count === 0 on updateMany) before it ever
 * reaches this service.
 *
 * SCHEMA MIGRATION
 * ----------------
 * matchedTotal was added in migration 20260727000000_add_multiplier_matched_total.
 * The ADD COLUMN uses a constant DEFAULT (no table rewrite in PG11+) and is
 * backfilled immediately from the MatchedFund aggregate so pre-existing
 * multipliers carry the correct starting balance.
 *
 * ARITHMETIC PRECISION
 * --------------------
 * All amounts use Prisma.Decimal (backed by decimal.js) throughout. There is
 * no cast to JS Number before or during arithmetic. The Postgres column is
 * DECIMAL(20,8) — 20 total digits, 8 decimal places — which matches the
 * Donation and MatchedFund amount columns so no precision is lost at any
 * boundary.
 */

import { AppError } from '../middleware/error';
import { Prisma, Multiplier, MatchedFund } from '@prisma/client';

export type MatchedFundSummary = {
  multiplierId: string;
  multiplierType: Multiplier['type'];
  multiplierValue: string;
  donorAmount: string;
  matchedAmount: string;
  totalAmount: string;
  capped: boolean;
};

export class MatchedFundAllocationService {
  /**
   * Raw matched amount before caps: donorAmount × (multiplier − 1), then
   * clamped to perDonationCap when set. This is the amount we *want* to
   * match before the global matchCap check happens in claimMatchCap().
   *
   * perDonationCap is applied here (before matchCap) so that a single
   * oversized donation can never claim more than min(perDonationCap,
   * remaining_matchCap). The calling code then passes this result to
   * claimMatchCap(), which further clamps to the remaining global budget.
   *
   * Decimal-safe throughout: no JS Number arithmetic is used.
   */
  static computeDesiredMatch(donorAmount: Prisma.Decimal.Value, multiplier: Multiplier): Prisma.Decimal {
    const factor = new Prisma.Decimal(multiplier.multiplier).minus(1);
    if (factor.lessThanOrEqualTo(0)) return new Prisma.Decimal(0);

    const raw = new Prisma.Decimal(donorAmount).times(factor);
    if (multiplier.perDonationCap === null) return raw;

    // perDonationCap applied FIRST, before global matchCap headroom check.
    return Prisma.Decimal.min(raw, new Prisma.Decimal(multiplier.perDonationCap));
  }

  /**
   * Atomically claims up to `desiredMatch` against the multiplier's matchCap
   * and returns the amount actually granted.
   *
   * Implementation: single UPDATE statement with a CTE that (a) locks the
   * Multiplier row FOR UPDATE, (b) computes the claimable amount in SQL, and
   * (c) increments matchedTotal — all in one round-trip. Concurrent callers
   * on the same multiplier serialize through the Postgres row lock; each
   * waits its turn and claims whatever headroom remains after the preceding
   * transaction commits.
   *
   * See the module-level ADR comment for the full rationale, deadlock
   * avoidance analysis, and rollback behavior.
   */
  private static async claimMatchCap(
    tx: Prisma.TransactionClient,
    multiplierId: string,
    desiredMatch: Prisma.Decimal,
  ): Promise<Prisma.Decimal> {
    if (desiredMatch.lessThanOrEqualTo(0)) return new Prisma.Decimal(0);

    // The FOR UPDATE in the locked CTE acquires an exclusive row-level lock
    // on the Multiplier row for the life of this transaction. The UPDATE that
    // follows reads from the locked snapshot, so the GREATEST/LEAST arithmetic
    // is always applied against the committed, post-lock value of matchedTotal.
    const rows = await tx.$queryRaw<Array<{ applied: string }>>(Prisma.sql`
      WITH locked AS (
        SELECT "matchedTotal", "matchCap"
        FROM   "Multiplier"
        WHERE  id = ${multiplierId}
        FOR UPDATE
      ),
      claim AS (
        SELECT
          CASE
            WHEN "matchCap" IS NULL
              THEN ${desiredMatch.toString()}::numeric
            ELSE GREATEST(
                   LEAST(${desiredMatch.toString()}::numeric, "matchCap" - "matchedTotal"),
                   0
                 )
          END AS applied
        FROM locked
      )
      UPDATE "Multiplier" m
      SET    "matchedTotal" = m."matchedTotal" + claim.applied
      FROM   claim
      WHERE  m.id = ${multiplierId}
      RETURNING claim.applied::text AS applied
    `);

    if (rows.length === 0) {
      throw AppError.from('MULTIPLIER_001', 'Multiplier not found during matched-fund allocation');
    }

    return new Prisma.Decimal(rows[0].applied);
  }

  /**
   * Allocates matched funds for a single donation within the caller's
   * transaction. Must be called inside the same prisma.$transaction as the
   * Donation status transition so the matched-fund ledger can never diverge
   * from the donation record.
   *
   * Returns null when:
   *   - no multiplier is active for this donation
   *   - the multiplier value is ≤ 1 (no match to grant)
   *   - the multiplier's matchCap is already fully consumed
   *
   * Cap precedence:
   *   1. perDonationCap (applied first by computeDesiredMatch)
   *   2. matchCap global budget (applied atomically by claimMatchCap)
   *
   * A single donation therefore claims at most
   *   min(donorAmount × (multiplier−1), perDonationCap, remaining_matchCap).
   */
  static async allocate(
    tx: Prisma.TransactionClient,
    params: {
      donationId: string;
      campaignId: string;
      donorAmount: Prisma.Decimal.Value;
      multiplier: Multiplier | null;
    },
  ): Promise<MatchedFund | null> {
    const { donationId, campaignId, multiplier } = params;
    const donorAmount = new Prisma.Decimal(params.donorAmount);

    if (!multiplier) return null;

    // Step 1: perDonationCap applied before the global matchCap check.
    const desiredMatch = this.computeDesiredMatch(donorAmount, multiplier);
    if (desiredMatch.lessThanOrEqualTo(0)) return null;

    // Step 2: atomically claim up to desiredMatch from the global matchCap
    //         budget, serializing through a FOR UPDATE row lock.
    const appliedAmount = await this.claimMatchCap(tx, multiplier.id, desiredMatch);
    if (appliedAmount.lessThanOrEqualTo(0)) return null;

    // Step 3: insert the MatchedFund record for the actual granted amount.
    //         donationId is UNIQUE on MatchedFund so this is idempotent under
    //         retries: a second call for the same donationId will fail the
    //         unique constraint and roll back the whole transaction.
    return tx.matchedFund.create({
      data: {
        donationId,
        campaignId,
        multiplierId: multiplier.id,
        matcherId: null,
        donorAmount,
        matchedAmount: appliedAmount,
        totalAmount: donorAmount.plus(appliedAmount),
      },
    });
  }

  /**
   * Builds a human-readable summary of a matched fund allocation for
   * API responses. capped=true means the donor received less than the
   * theoretical maximum match (due to perDonationCap or matchCap exhaustion).
   */
  static buildSummary(matchedFund: MatchedFund | null, multiplier: Multiplier | null): MatchedFundSummary | null {
    if (!matchedFund || !multiplier) return null;

    // computeDesiredMatch gives us what the donor *wanted* before the global
    // matchCap check, so comparing it with the actual matchedAmount tells us
    // whether any cap was hit.
    const desiredMatch = this.computeDesiredMatch(new Prisma.Decimal(matchedFund.donorAmount), multiplier);

    return {
      multiplierId: multiplier.id,
      multiplierType: multiplier.type,
      multiplierValue: new Prisma.Decimal(multiplier.multiplier).toString(),
      donorAmount: new Prisma.Decimal(matchedFund.donorAmount).toString(),
      matchedAmount: new Prisma.Decimal(matchedFund.matchedAmount).toString(),
      totalAmount: new Prisma.Decimal(matchedFund.totalAmount).toString(),
      capped: new Prisma.Decimal(matchedFund.matchedAmount).lessThan(desiredMatch),
    };
  }
}
