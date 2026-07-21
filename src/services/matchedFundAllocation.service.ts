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
   * Raw matched amount before caps: donorAmount * (multiplier - 1), clamped to
   * the multiplier's perDonationCap. Decimal-safe throughout so precision is
   * never lost to floating-point arithmetic.
   */
  static computeDesiredMatch(donorAmount: Prisma.Decimal.Value, multiplier: Multiplier): Prisma.Decimal {
    const factor = new Prisma.Decimal(multiplier.multiplier).minus(1);
    if (factor.lessThanOrEqualTo(0)) return new Prisma.Decimal(0);

    const raw = new Prisma.Decimal(donorAmount).times(factor);
    if (multiplier.perDonationCap === null) return raw;

    return Prisma.Decimal.min(raw, new Prisma.Decimal(multiplier.perDonationCap));
  }

  /**
   * Atomically claims up to `desiredMatch` against the multiplier's matchCap
   * and returns the amount actually granted. A single UPDATE statement locks
   * the Multiplier row (FOR UPDATE) and computes the claim from the row's own
   * pre-update value, so concurrent confirmations against the same multiplier
   * serialize through Postgres's row lock instead of racing on a
   * read-aggregate-then-write. No retry loop is needed: the transaction that
   * loses the lock simply waits, then claims whatever remains.
   */
  private static async claimMatchCap(
    tx: Prisma.TransactionClient,
    multiplierId: string,
    desiredMatch: Prisma.Decimal,
  ): Promise<Prisma.Decimal> {
    if (desiredMatch.lessThanOrEqualTo(0)) return new Prisma.Decimal(0);

    const rows = await tx.$queryRaw<Array<{ applied: string }>>(Prisma.sql`
      WITH locked AS (
        SELECT "matchedTotal", "matchCap"
        FROM "Multiplier"
        WHERE id = ${multiplierId}
        FOR UPDATE
      ),
      claim AS (
        SELECT
          CASE
            WHEN "matchCap" IS NULL THEN ${desiredMatch.toString()}::numeric
            ELSE GREATEST(LEAST(${desiredMatch.toString()}::numeric, "matchCap" - "matchedTotal"), 0)
          END AS applied
        FROM locked
      )
      UPDATE "Multiplier" m
      SET "matchedTotal" = m."matchedTotal" + claim.applied
      FROM claim
      WHERE m.id = ${multiplierId}
      RETURNING claim.applied::text AS applied
    `);

    if (rows.length === 0) {
      throw new AppError('Multiplier not found during matched-fund allocation', 404);
    }

    return new Prisma.Decimal(rows[0].applied);
  }

  /**
   * Allocates matched funds for a single donation within the caller's
   * transaction. Must run inside the same transaction as the donation's
   * status transition so the matched-fund ledger can never diverge from the
   * donation record. Returns null when no multiplier applies or the
   * multiplier's matchCap is already exhausted.
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

    const desiredMatch = this.computeDesiredMatch(donorAmount, multiplier);
    if (desiredMatch.lessThanOrEqualTo(0)) return null;

    const appliedAmount = await this.claimMatchCap(tx, multiplier.id, desiredMatch);
    if (appliedAmount.lessThanOrEqualTo(0)) return null;

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

  static buildSummary(matchedFund: MatchedFund | null, multiplier: Multiplier | null): MatchedFundSummary | null {
    if (!matchedFund || !multiplier) return null;

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
