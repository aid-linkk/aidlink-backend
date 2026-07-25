/**
 * @notice Builds a stable payment idempotency key from (pledgeId,
 * billingCycleDate). Deliberately excludes Date.now()/randomness: the same
 * pledge + same billing cycle must always produce the same key, so that a
 * retried charge request (after a crash or a failed DB write) is recognized
 * by the provider as "the same request" rather than a new charge.
 *
 * The key is truncated to a day granularity, matching the Stripe hint in
 * the issue (`pledge-X-2026-07-01`) — pledge cadences are WEEKLY/MONTHLY/
 * one-off, so day-level resolution is more than sufficient to disambiguate
 * cycles while staying stable across retries within the same tick/day.
 */
export function buildPledgeIdempotencyKey(pledgeId: string, billingCycleAt: Date): string {
  const cycleDate = billingCycleAt.toISOString().slice(0, 10); // YYYY-MM-DD
  return `pledge-${pledgeId}-${cycleDate}`;
}
