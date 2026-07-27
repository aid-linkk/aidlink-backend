-- Migration: add matchedTotal running-total column to Multiplier
--
-- Context:
--   MatchedFundAllocationService enforces matchCap by atomically updating
--   Multiplier.matchedTotal in the same statement that claims the per-donation
--   slice (a single UPDATE ... RETURNING inside a WITH/CTE using FOR UPDATE).
--   Without this column the enforcement reverted to a racy aggregate query
--   (SELECT SUM from MatchedFund) that could overshoot matchCap under
--   concurrent donation confirmations.
--
-- Safety:
--   * ADD COLUMN with a constant DEFAULT is a metadata-only change in
--     PostgreSQL 11+ — it does not rewrite the table, so it is safe on large
--     tables with no downtime.
--   * The subsequent UPDATE backfills matchedTotal from the authoritative
--     MatchedFund rows so existing multipliers start with the correct
--     consumed amount rather than zero.
--   * Both statements run inside a single implicit transaction; if the
--     backfill fails the column is never committed.

-- Step 1: add the column (metadata-only, no table rewrite on Postgres 11+)
ALTER TABLE "Multiplier"
  ADD COLUMN "matchedTotal" DECIMAL(20,8) NOT NULL DEFAULT 0;

-- Step 2: backfill from MatchedFund so pre-existing multipliers start with
--         the correct consumed amount rather than zero.
UPDATE "Multiplier" m
SET    "matchedTotal" = COALESCE(agg.total, 0)
FROM   (
    SELECT   "multiplierId",
             SUM("matchedAmount") AS total
    FROM     "MatchedFund"
    GROUP BY "multiplierId"
) agg
WHERE  m.id = agg."multiplierId";
