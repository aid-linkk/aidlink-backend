/**
 * Canonical Redis key prefixes for the AidLink analytics cache.
 *
 * These constants are defined ONCE here and imported by every file that
 * needs to construct or inspect analytics-related Redis keys.  Keeping them
 * in a single place prevents the silent-invalidation bug that would occur if
 * one file updated its copy of a prefix while the other kept the old value,
 * causing the writer and the invalidator to operate on different key-spaces.
 *
 * Prefix anatomy:
 *   campaign:stats:{campaignId}        — Redis hash with numeric counters
 *   campaign:donors:hll:{campaignId}   — Redis HyperLogLog for unique-donor estimation
 */

/**
 * Key prefix for the per-campaign stats hash.
 * Full key: `campaign:stats:{campaignId}`
 */
export const CACHE_PREFIX_STATS = 'campaign:stats:';

/**
 * Key prefix for the per-campaign HyperLogLog used to estimate uniqueDonors
 * in real time.  A HyperLogLog provides an O(1) cardinality estimate with a
 * standard error of ≤ 0.81 % — sufficient for display purposes on the
 * fundraising dashboard.
 *
 * Full key: `campaign:donors:hll:{campaignId}`
 *
 * Note: Redis has no PFDEL command, so a user whose only donation is later
 * refunded will remain in the HLL until the key expires or is explicitly
 * deleted.  This means the HLL can slightly overcount in the refund scenario.
 * The hourly reconciliation job (CACHE_RECONCILE) provides the exact count
 * periodically and serves as a correctness backstop.
 */
export const CACHE_PREFIX_DONORS_HLL = 'campaign:donors:hll:';
