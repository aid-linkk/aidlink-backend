import prisma from '../config/database';
import redis from '../config/redis';
import logger from '../config/logger';
import { config } from '../config';
import { Prisma } from '@prisma/client';
import { stripDonorPII } from '../utils/anonymity';
import { AppError } from '../middleware/error';
import { toCsv } from '../utils/csv';
import { CACHE_PREFIX_STATS, CACHE_PREFIX_DONORS_HLL } from '../constants/cacheKeys';
import {
  TrendingCampaignFilters,
  TrendingCampaign,
  ImpactMetrics,
  HistoricalStats,
  CampaignAnalyticsFilters,
  PaginatedResponse,
  PaginationParams,
} from '../types';

// Non-prefixed constant — just a namespace for trending data (not a stats key)
const CACHE_PREFIX_TRENDING_DATA = 'campaigns:trending:data';

/**
 * Scale factor used when storing monetary amounts in Redis as integers.
 *
 * The DB column is DECIMAL(20,8), so we multiply by 10^8 to preserve all 8
 * decimal places as an integer.  On read, divide by AMOUNT_SCALE to recover
 * the decimal value.
 *
 * Using HINCRBY (integer) instead of HINCRBYFLOAT (IEEE-754 float) eliminates
 * accumulated rounding error across thousands of increments.
 *
 * Maximum representable amount at this scale:
 *   9,223,372,036,854,775,807 (int64 max) ÷ 10^8 ≈ 92,233,720,368 base units
 *   — far beyond any plausible campaign target.
 */
const AMOUNT_SCALE = 100_000_000; // 10^8

/**
 * Convert a Prisma.Decimal (or any decimal-compatible value) to an integer
 * scaled by AMOUNT_SCALE, returned as a JavaScript number safe for ioredis
 * HINCRBY.
 *
 * Critically, this never routes through `Number(amount)` as an intermediate,
 * which would lose precision for values with > 15 significant digits.
 * Instead it uses Prisma.Decimal arithmetic to produce an exact integer string
 * and converts that to BigInt (lossless for the int64 range we care about).
 *
 * @throws {RangeError} if the scaled value exceeds Number.MAX_SAFE_INTEGER
 *   (ioredis HINCRBY expects a `number` — an out-of-range value would silently
 *   corrupt the counter).
 */
function toScaledInt(amount: Prisma.Decimal.Value): number {
  const scaledStr = new Prisma.Decimal(amount).mul(AMOUNT_SCALE).toFixed(0);
  const scaled = BigInt(scaledStr);
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER) || scaled < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(
      `Scaled amount ${scaledStr} exceeds safe integer range for ioredis HINCRBY`,
    );
  }
  return Number(scaled);
}

/**
 * Convert an integer-scaled totalRaised value (as stored in Redis) back to a
 * human-readable decimal string with 8 decimal places.
 */
function fromScaledInt(scaledValue: string | number): string {
  return new Prisma.Decimal(scaledValue).div(AMOUNT_SCALE).toFixed(8);
}

export const EXPORT_REPORT_TYPES = ['campaign', 'donor', 'organization', 'platform'] as const;
export type ExportReportType = (typeof EXPORT_REPORT_TYPES)[number];
export type ExportFormat = 'csv' | 'json';

export interface ExportedReport {
  content: string;
  filename: string;
  contentType: string;
}

export class AnalyticsService {
  static async getCampaignAnalytics(campaignId: string): Promise<any> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        _count: {
          select: {
            donations: true,
            beneficiaries: true,
            distributions: true,
          },
        },
        donations: {
          where: { status: 'CONFIRMED' },
          select: {
            amount: true,
            createdAt: true,
          },
        },
        distributions: {
          select: {
            amount: true,
            status: true,
            createdAt: true,
          },
        },
      },
    });

    if (!campaign) {
      throw new Error('Campaign not found');
    }

    // Calculate donation statistics
    const totalDonations = campaign.donations.length;
    const totalRaised = campaign.donations.reduce((sum, d) => sum + Number(d.amount), 0);
    const avgDonation = totalDonations > 0 ? totalRaised / totalDonations : 0;

    // Calculate distribution statistics
    const totalDistributed = campaign.distributions
      .filter((d) => d.status === 'COMPLETED')
      .reduce((sum, d) => sum + Number(d.amount), 0);

    // Calculate progress percentage
    const progress =
      Number(campaign.targetAmount) > 0
        ? (Number(campaign.currentAmount) / Number(campaign.targetAmount)) * 100
        : 0;

    // Daily donation trend (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const dailyDonations = await prisma.donation.groupBy({
      by: ['createdAt'],
      where: {
        campaignId,
        status: 'CONFIRMED',
        createdAt: { gte: thirtyDaysAgo },
      },
      _sum: { amount: true },
      _count: true,
    });

    return {
      campaign: {
        id: campaign.id,
        title: campaign.title,
        targetAmount: campaign.targetAmount,
        currentAmount: campaign.currentAmount,
        progress,
        status: campaign.status,
      },
      donations: {
        total: totalDonations,
        totalRaised,
        avgDonation,
        count: campaign._count.donations,
      },
      distributions: {
        total: campaign._count.distributions,
        totalDistributed,
        completed: campaign.distributions.filter((d) => d.status === 'COMPLETED').length,
      },
      beneficiaries: {
        total: campaign._count.beneficiaries,
      },
      dailyTrend: dailyDonations,
    };
  }

  static async getDonorAnalytics(userId: string): Promise<any> {
    const donations = await prisma.donation.findMany({
      where: { userId, status: 'CONFIRMED' },
      include: {
        campaign: {
          select: {
            id: true,
            title: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const totalDonated = donations.reduce((sum, d) => sum + Number(d.amount), 0);
    const campaignsSupported = new Set(donations.map((d) => d.campaignId)).size;

    // Monthly donation trend
    const monthlyDonations = await prisma.$queryRaw`
      SELECT 
        DATE_TRUNC('month', "createdAt") as month,
        SUM(amount) as total,
        COUNT(*) as count
      FROM "Donation"
      WHERE "userId" = ${userId}
        AND "status" = 'CONFIRMED'
      GROUP BY DATE_TRUNC('month', "createdAt")
      ORDER BY month DESC
      LIMIT 12
    `;

    return {
      totalDonated,
      totalDonations: donations.length,
      campaignsSupported,
      avgDonation: donations.length > 0 ? totalDonated / donations.length : 0,
      recentDonations: donations.slice(0, 10).map((d) =>
        d.isAnonymous ? stripDonorPII(d) : d
      ),
      monthlyTrend: monthlyDonations,
    };
  }

  static async getOrganizationAnalytics(organizationId: string): Promise<any> {
    const campaigns = await prisma.campaign.findMany({
      where: { organizationId },
      include: {
        _count: {
          select: {
            donations: true,
            beneficiaries: true,
            distributions: true,
          },
        },
        donations: {
          where: { status: 'CONFIRMED' },
          select: { amount: true },
        },
      },
    });

    const totalCampaigns = campaigns.length;
    const activeCampaigns = campaigns.filter((c) => c.status === 'ACTIVE').length;
    const totalRaised = campaigns.reduce(
      (sum, c) => sum + c.donations.reduce((dSum, d) => dSum + Number(d.amount), 0),
      0
    );
    const totalBeneficiaries = campaigns.reduce((sum, c) => sum + c._count.beneficiaries, 0);
    const totalDistributions = campaigns.reduce((sum, c) => sum + c._count.distributions, 0);

    return {
      campaigns: {
        total: totalCampaigns,
        active: activeCampaigns,
        completed: campaigns.filter((c) => c.status === 'COMPLETED').length,
      },
      funds: {
        totalRaised,
        avgPerCampaign: totalCampaigns > 0 ? totalRaised / totalCampaigns : 0,
      },
      impact: {
        totalBeneficiaries,
        totalDistributions,
      },
    };
  }

  static async getPlatformAnalytics(): Promise<any> {
    const [
      totalUsers,
      totalCampaigns,
      totalDonations,
      totalDistributions,
      totalBeneficiaries,
      recentUsers,
      recentCampaigns,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.campaign.count(),
      prisma.donation.count({ where: { status: 'CONFIRMED' } }),
      prisma.distribution.count({ where: { status: 'COMPLETED' } }),
      prisma.beneficiary.count(),
      prisma.user.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          username: true,
          role: true,
          createdAt: true,
        },
      }),
      prisma.campaign.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          status: true,
          currentAmount: true,
          targetAmount: true,
          createdAt: true,
        },
      }),
    ]);

    // Calculate total funds raised
    const fundsResult = await prisma.donation.aggregate({
      where: { status: 'CONFIRMED' },
      _sum: { amount: true },
    });

    // Calculate total funds distributed
    const distributedResult = await prisma.distribution.aggregate({
      where: { status: 'COMPLETED' },
      _sum: { amount: true },
    });

    return {
      overview: {
        totalUsers,
        totalCampaigns,
        totalDonations,
        totalDistributions,
        totalBeneficiaries,
      },
      financials: {
        totalRaised: fundsResult._sum.amount || 0,
        totalDistributed: distributedResult._sum.amount || 0,
      },
      recent: {
        users: recentUsers,
        campaigns: recentCampaigns,
      },
    };
  }

  static async generateReport(reportType: string, filters: any): Promise<any> {
    switch (reportType) {
      case 'campaign':
        if (!filters.campaignId) {
          throw new Error('Campaign ID is required for campaign report');
        }
        return this.getCampaignAnalytics(filters.campaignId);

      case 'donor':
        if (!filters.userId) {
          throw new Error('User ID is required for donor report');
        }
        return this.getDonorAnalytics(filters.userId);

      case 'organization':
        if (!filters.organizationId) {
          throw new Error('Organization ID is required for organization report');
        }
        return this.getOrganizationAnalytics(filters.organizationId);

      case 'platform':
        return this.getPlatformAnalytics();

      default:
        throw new Error('Invalid report type');
    }
  }

  // ============================================
  // ADMIN ANALYTICS EXPORT
  // ============================================

  /**
   * Generate a downloadable export (CSV or JSON) for a supported report type.
   * Reuses generateReport() for the underlying data so the export never
   * drifts from the existing JSON analytics contract.
   */
  static async exportReport(
    reportType: string,
    filters: any,
    format: ExportFormat = 'csv'
  ): Promise<ExportedReport> {
    if (!EXPORT_REPORT_TYPES.includes(reportType as ExportReportType)) {
      throw new AppError(
        `Invalid report type. Supported types: ${EXPORT_REPORT_TYPES.join(', ')}`,
        400
      );
    }

    let report: any;
    try {
      report = await this.generateReport(reportType, filters);
    } catch (err) {
      // generateReport throws plain Errors for missing/invalid filters (e.g.
      // "Campaign ID is required") — surface those as 400s, not 500s.
      throw err instanceof Error ? new AppError(err.message, 400) : err;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${reportType}-analytics-${timestamp}.${format}`;

    if (format === 'json') {
      return {
        content: JSON.stringify(report, null, 2),
        filename,
        contentType: 'application/json',
      };
    }

    const { columns, rows } = this.buildExportRows(reportType as ExportReportType, report);
    return {
      content: toCsv(columns, rows),
      filename,
      contentType: 'text/csv',
    };
  }

  /**
   * Flattens a generateReport() result into CSV-ready columns/rows per report type.
   */
  private static buildExportRows(
    reportType: ExportReportType,
    report: any
  ): { columns: string[]; rows: Array<Record<string, unknown>> } {
    switch (reportType) {
      case 'campaign':
        return {
          columns: [
            'campaignId',
            'title',
            'status',
            'targetAmount',
            'currentAmount',
            'progressPercentage',
            'totalDonations',
            'totalRaised',
            'avgDonation',
            'totalDistributions',
            'totalDistributed',
            'beneficiariesTotal',
          ],
          rows: [
            {
              campaignId: report.campaign.id,
              title: report.campaign.title,
              status: report.campaign.status,
              targetAmount: report.campaign.targetAmount,
              currentAmount: report.campaign.currentAmount,
              progressPercentage: report.campaign.progress,
              totalDonations: report.donations.total,
              totalRaised: report.donations.totalRaised,
              avgDonation: report.donations.avgDonation,
              totalDistributions: report.distributions.total,
              totalDistributed: report.distributions.totalDistributed,
              beneficiariesTotal: report.beneficiaries.total,
            },
          ],
        };

      case 'donor':
        return {
          columns: ['donationId', 'campaignId', 'campaignTitle', 'amount', 'createdAt'],
          rows: report.recentDonations.map((d: any) => ({
            donationId: d.id,
            campaignId: d.campaign?.id,
            campaignTitle: d.campaign?.title,
            amount: d.amount,
            createdAt: d.createdAt,
          })),
        };

      case 'organization':
        return {
          columns: [
            'totalCampaigns',
            'activeCampaigns',
            'completedCampaigns',
            'totalRaised',
            'avgPerCampaign',
            'totalBeneficiaries',
            'totalDistributions',
          ],
          rows: [
            {
              totalCampaigns: report.campaigns.total,
              activeCampaigns: report.campaigns.active,
              completedCampaigns: report.campaigns.completed,
              totalRaised: report.funds.totalRaised,
              avgPerCampaign: report.funds.avgPerCampaign,
              totalBeneficiaries: report.impact.totalBeneficiaries,
              totalDistributions: report.impact.totalDistributions,
            },
          ],
        };

      case 'platform':
        return {
          columns: [
            'totalUsers',
            'totalCampaigns',
            'totalDonations',
            'totalDistributions',
            'totalBeneficiaries',
            'totalRaised',
            'totalDistributedAmount',
          ],
          rows: [
            {
              totalUsers: report.overview.totalUsers,
              totalCampaigns: report.overview.totalCampaigns,
              totalDonations: report.overview.totalDonations,
              totalDistributions: report.overview.totalDistributions,
              totalBeneficiaries: report.overview.totalBeneficiaries,
              totalRaised: report.financials.totalRaised,
              totalDistributedAmount: report.financials.totalDistributed,
            },
          ],
        };
    }
  }

  // ============================================
  // CACHE-BASED CAMPAIGN STATS
  // ============================================

  /**
   * Get campaign stats from Redis cache, falling back to DB if cache miss.
   *
   * `uniqueDonors` is always sourced from the HyperLogLog PFCOUNT rather than
   * from the stats hash field.  This ensures it is updated in real time on
   * every confirmed donation (via PFADD in incrementDonationStats) instead of
   * only at the hourly reconciliation boundary.
   *
   * The HyperLogLog has a standard error of ≤ 0.81 %, which is acceptable for
   * display purposes.  The hourly reconciliation job provides the exact DB
   * count as a correctness backstop.
   */
  static async getCachedCampaignStats(campaignId: string): Promise<Record<string, string>> {
    const cacheKey = `${CACHE_PREFIX_STATS}${campaignId}`;
    const hllKey = `${CACHE_PREFIX_DONORS_HLL}${campaignId}`;

    let stats: Record<string, string> | null = null;
    try {
      const cached = await redis.hgetall(cacheKey);
      if (cached && Object.keys(cached).length > 0) {
        stats = cached;
      }
    } catch (err) {
      logger.warn(`Redis cache read failed for ${cacheKey}`, err);
    }

    if (!stats) {
      // Cache miss — build from DB and populate cache (also seeds the HLL)
      const built = await this.buildCampaignStats(campaignId);
      await this.setCachedCampaignStats(campaignId, built);
      stats = built;
    }

    // Overlay uniqueDonors with the live HyperLogLog estimate.
    // PFCOUNT is O(1) and provides a real-time approximate count that is
    // updated on every donation confirmation, eliminating the stale window
    // that existed when uniqueDonors was only refreshed by the hourly job.
    try {
      const hllCount = await redis.pfcount(hllKey);
      stats = { ...stats, uniqueDonors: String(hllCount) };
    } catch (err) {
      logger.warn(`HLL PFCOUNT failed for ${hllKey}, using cached value`, err);
      // Fall back to the value in the stats hash (set at last DB rebuild)
    }

    return stats;
  }

  /**
   * Store campaign stats in Redis cache.
   */
  static async setCachedCampaignStats(
    campaignId: string,
    stats: Record<string, string>
  ): Promise<void> {
    const cacheKey = `${CACHE_PREFIX_STATS}${campaignId}`;
    try {
      await redis.hset(cacheKey, stats);
      await redis.expire(cacheKey, config.analytics.campaignStatsCacheTTL);
    } catch (err) {
      logger.warn(`Redis cache write failed for ${cacheKey}`, err);
    }
  }

  /**
   * Build campaign stats from raw database queries.
   *
   * totalRaised is stored as an integer-scaled value (× 10^8) so that
   * subsequent HINCRBY increments on the live hash avoid IEEE-754 rounding
   * error.  All callers that read totalRaised must divide by AMOUNT_SCALE
   * (or call fromScaledInt) to recover the decimal representation.
   *
   * On every full rebuild we also (re)seed the HyperLogLog for this campaign
   * with the exact set of confirmed donor user-IDs from the DB, so that the
   * HLL is accurate immediately after a cache miss rather than starting empty.
   */
  static async buildCampaignStats(campaignId: string): Promise<Record<string, string>> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, title: true, targetAmount: true, currentAmount: true, status: true },
    });

    if (!campaign) {
      throw new Error('Campaign not found');
    }

    const [donationAgg, distributionAgg] = await Promise.all([
      prisma.donation.aggregate({
        where: { campaignId, status: 'CONFIRMED' },
        _count: true,
        _sum: { amount: true },
      }),
      prisma.distribution.aggregate({
        where: { campaignId, status: 'COMPLETED' },
        _count: true,
        _sum: { amount: true },
      }),
    ]);

    const uniqueDonorRows = await prisma.donation.groupBy({
      by: ['userId'],
      where: { campaignId, status: 'CONFIRMED', userId: { not: null } },
    });

    const beneficiaryCount = await prisma.beneficiaryAssignment.count({
      where: { campaignId },
    });

    const targetAmount = Number(campaign.targetAmount) || 1;
    const currentAmount = Number(campaign.currentAmount) || 0;
    const progress = ((currentAmount / targetAmount) * 100).toFixed(2);

    // Seed (or re-seed) the HyperLogLog with the current confirmed donor set so
    // it is accurate immediately after a cache miss.  The HLL key shares the
    // same TTL as the stats hash key so stale HLL entries don't accumulate
    // after a campaign is archived.
    const hllKey = `${CACHE_PREFIX_DONORS_HLL}${campaignId}`;
    const donorUserIds = uniqueDonorRows
      .map((r) => r.userId)
      .filter((uid): uid is string => uid !== null);
    if (donorUserIds.length > 0) {
      try {
        await redis.pfadd(hllKey, ...donorUserIds);
        await redis.expire(hllKey, config.analytics.campaignStatsCacheTTL);
      } catch (err) {
        logger.warn(`HLL seed failed for campaign ${campaignId}`, err);
      }
    }

    // Store totalRaised as an integer-scaled value to avoid float drift.
    const rawTotalRaised = donationAgg._sum.amount
      ? toScaledInt(donationAgg._sum.amount)
      : 0;

    return {
      campaignId: campaign.id,
      title: campaign.title,
      status: campaign.status,
      targetAmount: String(campaign.targetAmount),
      currentAmount: String(campaign.currentAmount),
      totalDonations: String(donationAgg._count),
      // Integer-scaled: divide by AMOUNT_SCALE (10^8) to get the decimal value.
      totalRaised: String(rawTotalRaised),
      totalDistributions: String(distributionAgg._count),
      totalDistributed: String(distributionAgg._sum.amount || '0'),
      // uniqueDonors in the hash is a snapshot from DB at build time; live reads
      // should call PFCOUNT on the HLL key (campaign:donors:hll:{id}) instead.
      uniqueDonors: String(uniqueDonorRows.length),
      beneficiariesReached: String(beneficiaryCount),
      progressPercentage: progress,
    };
  }

  /**
   * Incrementally update campaign stats cache after a donation confirmation.
   *
   * Design decisions:
   *  • totalRaised is incremented using HINCRBY with an integer-scaled value
   *    (amount × 10^8) rather than HINCRBYFLOAT.  This avoids IEEE-754
   *    rounding error that accumulates across thousands of float increments.
   *    Readers must divide by AMOUNT_SCALE (10^8) to recover the decimal value.
   *  • uniqueDonors is updated via PFADD on the HyperLogLog key
   *    (campaign:donors:hll:{campaignId}).  The HLL provides an O(1) estimate
   *    with ≤ 0.81 % standard error (Redis spec, PFADD/PFCOUNT) — sufficient
   *    for display purposes.  This replaces the previous approach of only
   *    updating uniqueDonors in the hourly reconciliation job, which left a
   *    stale window of up to 59 minutes.
   *
   * Called fire-and-forget from dispatchPostConfirmationSideEffects; errors
   * are logged but never propagated to the HTTP request path.
   */
  static async incrementDonationStats(
    campaignId: string,
    amount: Prisma.Decimal.Value,
    userId?: string | null,
  ): Promise<void> {
    const cacheKey = `${CACHE_PREFIX_STATS}${campaignId}`;
    const hllKey = `${CACHE_PREFIX_DONORS_HLL}${campaignId}`;
    try {
      const exists = await redis.exists(cacheKey);
      if (exists) {
        const scaledAmount = toScaledInt(amount);
        await redis.hincrby(cacheKey, 'totalRaised', scaledAmount);
        await redis.hincrby(cacheKey, 'totalDonations', 1);
      }
    } catch (err) {
      logger.warn(`Redis increment failed for ${cacheKey}`, err);
    }

    // Update the HyperLogLog regardless of whether the stats hash exists.
    // The HLL key has the same TTL as the stats hash so it expires together.
    // Note: there is no PFDEL command in Redis, so if a user's only donation
    // is later refunded, their userId remains in the HLL, causing a slight
    // overcount.  The hourly reconciliation job provides the exact count.
    if (userId) {
      try {
        await redis.pfadd(hllKey, userId);
        // Keep the HLL key alive as long as the stats hash would live.
        await redis.expire(hllKey, config.analytics.campaignStatsCacheTTL);
      } catch (err) {
        logger.warn(`HLL PFADD failed for ${hllKey}`, err);
      }
    }
  }

  /**
   * Decrementally update campaign stats cache after a donation refund.
   *
   * Mirrors incrementDonationStats with negative HINCRBY values to keep the
   * cache consistent without the race window that invalidateCampaignCache()
   * introduced.
   *
   * The race with the old invalidation approach:
   *   1. Refund sets status = REFUNDED
   *   2. invalidateCampaignCache() deletes the key
   *   3. A concurrent confirmation's incrementDonationStats() sees exists=0
   *      and silently skips the increment
   *   4. The key is later rebuilt from DB, but the increment from step 3 is lost
   *
   * With decrementDonationStats(), the key is never deleted; concurrent
   * increments and decrements are serialised by Redis and produce the correct
   * net result.
   *
   * HyperLogLog note: Redis has no PFDEL command, so we cannot remove a userId
   * from the HLL on refund.  If the user has no other donations to this
   * campaign they will remain counted in the HLL until the key expires.  This
   * is an acceptable known overcount (documented here); the hourly
   * reconciliation job (CACHE_RECONCILE) provides the exact DB count
   * periodically and will correct any drift.
   *
   * Called fire-and-forget from refundDonation; errors are logged but never
   * propagated to the HTTP request path.
   */
  static async decrementDonationStats(
    campaignId: string,
    amount: Prisma.Decimal.Value,
    _userId?: string | null, // reserved — cannot remove from HLL (no PFDEL in Redis)
  ): Promise<void> {
    const cacheKey = `${CACHE_PREFIX_STATS}${campaignId}`;
    try {
      const exists = await redis.exists(cacheKey);
      if (exists) {
        const scaledAmount = toScaledInt(amount);
        // Negative HINCRBY decrements the integer-scaled totalRaised
        await redis.hincrby(cacheKey, 'totalRaised', -scaledAmount);
        await redis.hincrby(cacheKey, 'totalDonations', -1);
      }
    } catch (err) {
      logger.warn(`Redis decrement failed for ${cacheKey}`, err);
    }
  }

  /**
   * Incrementally update campaign stats cache after a distribution event.
   * Called by the analytics worker.
   */
  static async incrementDistributionStats(campaignId: string, amount: number): Promise<void> {
    const cacheKey = `${CACHE_PREFIX_STATS}${campaignId}`;
    try {
      const exists = await redis.exists(cacheKey);
      if (exists) {
        await redis.hincrbyfloat(cacheKey, 'totalDistributed', amount);
        await redis.hincrby(cacheKey, 'totalDistributions', 1);
      }
    } catch (err) {
      logger.warn(`Redis increment failed for ${cacheKey}`, err);
    }
  }

  /**
   * Invalidates the Redis cache for a specific campaign.
   */
  static async invalidateCampaignCache(campaignId: string): Promise<void> {
    const cacheKey = `${CACHE_PREFIX_STATS}${campaignId}`;
    try {
      await redis.del(cacheKey);
      logger.info(`Cache invalidated for campaign ${campaignId}`);
    } catch (err) {
      logger.warn(`Cache invalidation failed for ${cacheKey}`, err);
    }
  }

  // ============================================
  // TRENDING CAMPAIGNS
  // ============================================

  /**
   * Get trending campaigns. Tries cache first (from Redis), falls back to DB.
   */
  static async getTrendingCampaigns(
    filters: TrendingCampaignFilters = {}
  ): Promise<TrendingCampaign[]> {
    const { period = 'last24h', sortBy = 'trendScore', limit = 10 } = filters;

    // Try cached top-level data first
    try {
      const cachedData = await redis.get(`${CACHE_PREFIX_TRENDING_DATA}:${period}`);
      if (cachedData) {
        const trendings = JSON.parse(cachedData) as TrendingCampaign[];
        const sorted = this.sortTrendingCampaigns(trendings, sortBy);
        return sorted.slice(0, limit);
      }
    } catch (err) {
      logger.warn('Redis trending cache read failed', err);
    }

    // Fallback to DB
    return this.queryTrendingCampaignsFromDb(period, sortBy, limit);
  }

  /**
   * Query trending campaigns from the CampaignTrending table joined with Campaign.
   */
  static async queryTrendingCampaignsFromDb(
    period: string,
    sortBy: string,
    limit: number
  ): Promise<TrendingCampaign[]> {
    const trendingRows = await prisma.campaignTrending.findMany({
      where: { period },
      orderBy: { [sortBy === 'trendScore' ? 'trendScore' : sortBy]: 'desc' },
      take: limit,
    });

    if (trendingRows.length === 0) {
      return [];
    }

    const campaignIds = trendingRows.map((t) => t.campaignId);
    const campaigns = await prisma.campaign.findMany({
      where: { id: { in: campaignIds } },
      select: {
        id: true,
        title: true,
        imageUrl: true,
        status: true,
        currentAmount: true,
        targetAmount: true,
        organization: {
          select: { id: true, name: true, logo: true },
        },
      },
    });

    const campaignMap = new Map(campaigns.map((c) => [c.id, c]));

    return trendingRows
      .filter((t) => campaignMap.has(t.campaignId))
      .map((t) => {
        const campaign = campaignMap.get(t.campaignId)!;
        return {
          campaignId: t.campaignId,
          title: campaign.title,
          imageUrl: campaign.imageUrl,
          status: campaign.status,
          currentAmount: Number(campaign.currentAmount),
          targetAmount: Number(campaign.targetAmount),
          trendScore: Number(t.trendScore),
          donationVelocity: Number(t.donationVelocity),
          donorGrowth: t.donorGrowth,
          distributionImpact: Number(t.distributionImpact),
          period: t.period,
          rank: t.rank,
          organization: campaign.organization,
        };
      });
  }

  /**
   * Sort trending campaigns by the specified field.
   */
  private static sortTrendingCampaigns(
    campaigns: TrendingCampaign[],
    sortBy: string
  ): TrendingCampaign[] {
    return [...campaigns].sort((a, b) => {
      if (sortBy === 'donationVelocity') return b.donationVelocity - a.donationVelocity;
      if (sortBy === 'distributionImpact') return b.distributionImpact - a.distributionImpact;
      return b.trendScore - a.trendScore; // default: trendScore
    });
  }

  /**
   * Refresh the trending campaigns table and Redis cache.
   * Called by the analytics worker on schedule.
   */
  static async refreshTrendingCampaigns(): Promise<void> {
    try {
      const periods: Array<'last24h' | 'last7d' | 'last30d'> = ['last24h', 'last7d', 'last30d'];

      for (const period of periods) {
        const windowStart = this.getPeriodStart(period);

        // Query raw donation/distribution data for trending calculation
        const trendingData = await prisma.$queryRaw<
          Array<{
            campaignId: string;
            donationCount: number;
            donationVolume: number;
            uniqueDonors: number;
            distributionCount: number;
            distributionVolume: number;
          }>
        >`
          WITH campaign_metrics AS (
            SELECT
              d."campaignId",
              COUNT(DISTINCT d.id) AS "donationCount",
              COALESCE(SUM(d.amount), 0) AS "donationVolume",
              COUNT(DISTINCT d."userId") AS "uniqueDonors",
              COALESCE(SUM(CASE WHEN dist.status = 'COMPLETED' THEN dist.amount ELSE 0 END), 0) AS "distributionVolume",
              COUNT(DISTINCT CASE WHEN dist.status = 'COMPLETED' THEN dist.id END) AS "distributionCount"
            FROM "Campaign" c
            LEFT JOIN "Donation" d ON d."campaignId" = c.id
              AND d.status = 'CONFIRMED'
              AND d."createdAt" >= ${windowStart}::timestamp
            LEFT JOIN "Distribution" dist ON dist."campaignId" = c.id
              AND dist."createdAt" >= ${windowStart}::timestamp
            WHERE c.status IN ('ACTIVE', 'COMPLETED')
            GROUP BY d."campaignId"
          )
          SELECT * FROM campaign_metrics
          WHERE "donationCount" > 0 OR "distributionCount" > 0
        `;

        // Calculate trend scores and upsert
        const count = config.analytics.trendingCampaignsCount;
        const enriched = trendingData.map((row) => {
          const donationVelocity =
            period === 'last24h'
              ? Number(row.donationVolume) * 24
              : period === 'last7d'
                ? Number(row.donationVolume) / 7
                : Number(row.donationVolume) / 30;
          const distributionImpact = Number(row.distributionVolume);
          const trendScore =
            donationVelocity * 0.4 + distributionImpact * 0.3 + row.uniqueDonors * 0.3;

          return {
            campaignId: row.campaignId,
            donationVelocity,
            donorGrowth: row.uniqueDonors,
            distributionImpact,
            trendScore,
          };
        });

        // Sort by trendScore descending, assign ranks
       enriched.sort((a, b) => {
          if (b.trendScore !== a.trendScore) return b.trendScore - a.trendScore;
          return a.campaignId.localeCompare(b.campaignId); // deterministic tiebreaker
        });
        const topN = enriched.slice(0, count);

        // Upsert into CampaignTrending table (compound key: campaignId + period)
        for (let i = 0; i < topN.length; i++) {
          const entry = topN[i];
          await prisma.campaignTrending.upsert({
            where: {
              campaignId_period: { campaignId: entry.campaignId, period },
            },
            create: {
              campaignId: entry.campaignId,
              trendScore: entry.trendScore,
              donationVelocity: entry.donationVelocity,
              donorGrowth: entry.donorGrowth,
              distributionImpact: entry.distributionImpact,
              period,
              rank: i + 1,
            },
            update: {
              trendScore: entry.trendScore,
              donationVelocity: entry.donationVelocity,
              donorGrowth: entry.donorGrowth,
              distributionImpact: entry.distributionImpact,
              rank: i + 1,
              refreshedAt: new Date(),
            },
          });
        }

        // Remove stale entries not in top N
        if (topN.length > 0) {
          const keptIds = new Set(topN.map((t) => t.campaignId));
          await prisma.campaignTrending.deleteMany({
            where: {
              period,
              campaignId: { notIn: [...keptIds] },
            },
          });
        }

        // Cache the full trending list in Redis for fast reads
        const fullTrendingList = await this.queryTrendingCampaignsFromDb(
          period,
          'trendScore',
          count
        );
        await redis.setex(
          `${CACHE_PREFIX_TRENDING_DATA}:${period}`,
          900, // 15 min TTL
          JSON.stringify(fullTrendingList)
        );

        logger.info(`Trending campaigns refreshed for period: ${period}, count: ${topN.length}`);
      }
    } catch (error) {
      logger.error('Failed to refresh trending campaigns', error);
      throw error;
    }
  }

  // ============================================
  // IMPACT METRICS
  // ============================================

  /**
   * Get comprehensive impact metrics for a campaign, using cache when available.
   *
   * uniqueDonors is read from the HyperLogLog (PFCOUNT) rather than from the
   * stats hash field or the DB, so it reflects real-time donation activity
   * rather than the value frozen at the last hourly reconciliation run.
   */
  static async getCampaignImpactMetrics(campaignId: string): Promise<ImpactMetrics> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, title: true, targetAmount: true, currentAmount: true },
    });

    if (!campaign) {
      throw new Error('Campaign not found');
    }

    // Use cached stats when available (avoids raw table scans per acceptance criteria)
    let cachedStats: Record<string, string> | null = null;
    try {
      const cacheKey = `${CACHE_PREFIX_STATS}${campaignId}`;
      const cached = await redis.hgetall(cacheKey);
      if (cached && Object.keys(cached).length > 0) {
        cachedStats = cached;
      }
    } catch (err) {
      logger.warn(`Redis cache read failed for impact metrics on ${campaignId}`, err);
    }

    let totalDonations: number;
    let totalRaised: number;
    let totalDistributions: number;
    let totalDistributedAmount: number;
    let uniqueDonors: number;
    let beneficiariesReached: number;

    if (cachedStats) {
      totalDonations = parseInt(cachedStats.totalDonations || '0', 10);
      // totalRaised is stored as an integer-scaled value (× 10^8); divide back.
      totalRaised = parseFloat(fromScaledInt(cachedStats.totalRaised || '0'));
      totalDistributions = parseInt(cachedStats.totalDistributions || '0', 10);
      totalDistributedAmount = parseFloat(cachedStats.totalDistributed || '0');
      // uniqueDonors is NOT read from the hash field here — use HLL instead.
      uniqueDonors = 0; // will be overwritten by PFCOUNT below
      beneficiariesReached = parseInt(cachedStats.beneficiariesReached || '0', 10);
    } else {
      // Fallback: aggregate from raw tables (cache miss)
      const [donationAgg, distributionAgg, donorGrowth, beneficiaryCount] = await Promise.all([
        prisma.donation.aggregate({
          where: { campaignId, status: 'CONFIRMED' },
          _count: true,
          _sum: { amount: true },
        }),
        prisma.distribution.aggregate({
          where: { campaignId, status: 'COMPLETED' },
          _count: true,
          _sum: { amount: true },
        }),
        prisma.donation.groupBy({
          by: ['userId'],
          where: { campaignId, status: 'CONFIRMED', userId: { not: null } },
        }),
        prisma.beneficiaryAssignment.count({ where: { campaignId } }),
      ]);

      totalDonations = donationAgg._count;
      totalRaised = Number(donationAgg._sum.amount || 0);
      totalDistributions = distributionAgg._count;
      totalDistributedAmount = Number(distributionAgg._sum.amount || 0);
      uniqueDonors = donorGrowth.length;
      beneficiariesReached = beneficiaryCount;

      // Build and cache (also seeds the HLL)
      const stats = await this.buildCampaignStats(campaignId);
      await this.setCachedCampaignStats(campaignId, stats);
    }

    // Always overlay uniqueDonors with the live HyperLogLog estimate so it
    // reflects real-time donor activity instead of the last reconciliation
    // snapshot.  Standard error: ≤ 0.81 % (Redis HyperLogLog spec).
    const hllKey = `${CACHE_PREFIX_DONORS_HLL}${campaignId}`;
    try {
      uniqueDonors = await redis.pfcount(hllKey);
    } catch (err) {
      logger.warn(`HLL PFCOUNT failed for ${hllKey} in impact metrics, using DB/cache value`, err);
      // uniqueDonors retains the value from the cache-hit or the DB fallback above
    }

    const targetAmount = Number(campaign.targetAmount) || 1;
    const currentAmount = Number(campaign.currentAmount) || 0;
    const conversionRate =
      totalDonations > 0 ? (totalDistributions / (totalDonations + totalDistributions)) * 100 : 0;
    const impactScore =
      beneficiariesReached * 0.4 +
      (totalDistributedAmount / Math.max(targetAmount, 1)) * 0.3 +
      (uniqueDonors / Math.max(totalDonations + 1, 1)) * 0.3;

    return {
      campaignId: campaign.id,
      title: campaign.title,
      totalDonations,
      totalRaised,
      donorGrowth: uniqueDonors,
      totalDistributions,
      totalDistributedAmount,
      beneficiariesReached,
      conversionRate: Math.round(conversionRate * 100) / 100,
      avgDonationAmount: totalDonations > 0 ? totalRaised / totalDonations : 0,
      progressPercentage: (currentAmount / targetAmount) * 100,
      impactScore: Math.round(impactScore * 100) / 100,
    };
  }

  // ============================================
  // HISTORICAL STATS
  // ============================================

  /**
   * Get historical statistics for a campaign from rollup tables.
   */
  static async getCampaignHistoricalStats(
    campaignId: string,
    granularity: 'hourly' | 'monthly' = 'hourly',
    range?: { startDate: Date; endDate: Date }
  ): Promise<HistoricalStats> {
    if (granularity === 'hourly') {
      const where: any = { campaignId };
      if (range) {
        where.hour = { gte: range.startDate, lte: range.endDate };
      }

      const rows = await prisma.campaignHourlyStat.findMany({
        where,
        orderBy: { hour: 'asc' },
      });

      return {
        campaignId,
        granularity: 'hourly',
        data: rows.map((r) => ({
          timestamp: r.hour,
          donationCount: r.donationCount,
          donationVolume: Number(r.donationVolume),
          uniqueDonors: r.uniqueDonors,
          distributionCount: r.distributionCount,
          distributionVolume: Number(r.distributionVolume),
          itemsDistributed: r.itemsDistributed,
          activeDonors: r.activeDonors,
        })),
      };
    }

    // Monthly
    const where: any = { campaignId };
    if (range) {
      where.month = { gte: range.startDate, lte: range.endDate };
    }

    const rows = await prisma.campaignMonthlyStat.findMany({
      where,
      orderBy: { month: 'asc' },
    });

    return {
      campaignId,
      granularity: 'monthly',
      data: rows.map((r) => ({
        timestamp: r.month,
        donationCount: r.donationCount,
        donationVolume: Number(r.donationVolume),
        uniqueDonors: r.uniqueDonors,
        distributionCount: r.distributionCount,
        distributionVolume: Number(r.distributionVolume),
        itemsDistributed: r.itemsDistributed,
        donorGrowth: r.donorGrowth,
        distributionReach: r.distributionReach,
        campaignActivity: r.campaignActivity,
        activeDonors: r.activeDonors,
      })),
    };
  }

  // ============================================
  // AGGREGATED CAMPAIGN ANALYTICS (ADMIN)
  // ============================================

  /**
   * Query aggregated campaign metrics for admin dashboards.
   * Uses rollup tables instead of raw scans.
   */
  static async getAggregatedCampaignAnalytics(
    filters: CampaignAnalyticsFilters,
    pagination: PaginationParams
  ): Promise<PaginatedResponse<any>> {
    const { page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = pagination;
    const skip = (page - 1) * limit;

    const campaigns = await prisma.campaign.findMany({
      where: {
        ...(filters.status && { status: filters.status as any }),
        ...(filters.startDate && { startDate: { gte: filters.startDate } }),
        ...(filters.endDate && { endDate: { lte: filters.endDate } }),
      },
      skip,
      take: limit,
      orderBy: { [sortBy]: sortOrder },
      select: {
        id: true,
        title: true,
        status: true,
        targetAmount: true,
        currentAmount: true,
        startDate: true,
        endDate: true,
        organization: { select: { id: true, name: true } },
        _count: { select: { donations: true, beneficiaries: true, distributions: true } },
      },
    });

    const total = await prisma.campaign.count({
      where: {
        ...(filters.status && { status: filters.status as any }),
        ...(filters.startDate && { startDate: { gte: filters.startDate } }),
        ...(filters.endDate && { endDate: { lte: filters.endDate } }),
      },
    });

    // Enrich with rollup summary data
    const campaignIds = campaigns.map((c) => c.id);
    const rollupSummaries = await prisma.campaignHourlyStat.findMany({
      where: { campaignId: { in: campaignIds } },
      orderBy: { hour: 'desc' },
    });

    const rollupMap = new Map<string, any[]>();
    for (const r of rollupSummaries) {
      if (!rollupMap.has(r.campaignId)) {
        rollupMap.set(r.campaignId, []);
      }
      rollupMap.get(r.campaignId)!.push(r);
    }

    return {
      data: campaigns.map((campaign) => {
        const rollups = rollupMap.get(campaign.id) || [];
        const recentRollup = rollups[0];
        return {
          ...campaign,
          targetAmount: Number(campaign.targetAmount),
          currentAmount: Number(campaign.currentAmount),
          stats: {
            donationCount: campaign._count.donations,
            beneficiaryCount: campaign._count.beneficiaries,
            distributionCount: campaign._count.distributions,
            lastHourActivity: recentRollup
              ? {
                  donations: recentRollup.donationCount,
                  distributions: recentRollup.distributionCount,
                  hour: recentRollup.hour,
                }
              : null,
          },
        };
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ============================================
  // ROLLUP LOGIC (called by worker)
  // ============================================

  /**
   * Get the start of a time window based on period string.
   */
  private static getPeriodStart(period: 'last24h' | 'last7d' | 'last30d'): Date {
    const now = new Date();
    switch (period) {
      case 'last24h':
        return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case 'last7d':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case 'last30d':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
  }

  /**
   * Get the last processed hour from the rollup tracker.
   */
  private static async getLastProcessedHour(type: string): Promise<Date | null> {
    const tracker = await prisma.rollupTracker.findUnique({
      where: { type },
    });
    return tracker?.lastHour || null;
  }

  /**
   * Update the last processed hour in the rollup tracker.
   */
  private static async updateLastProcessedHour(type: string, hour: Date): Promise<void> {
    await prisma.rollupTracker.upsert({
      where: { type },
      create: {
        type,
        lastProcessedTimestamp: new Date(),
        lastHour: hour,
      },
      update: {
        lastProcessedTimestamp: new Date(),
        lastHour: hour,
      },
    });
  }

  /**
   * Get the last processed month from the rollup tracker.
   */
  private static async getLastProcessedMonth(type: string): Promise<Date | null> {
    const tracker = await prisma.rollupTracker.findUnique({
      where: { type },
    });
    return tracker?.lastMonth || null;
  }

  /**
   * Update the last processed month in the rollup tracker.
   */
  private static async updateLastProcessedMonth(type: string, month: Date): Promise<void> {
    await prisma.rollupTracker.upsert({
      where: { type },
      create: {
        type,
        lastProcessedTimestamp: new Date(),
        lastMonth: month,
      },
      update: {
        lastProcessedTimestamp: new Date(),
        lastMonth: month,
      },
    });
  }

  /**
   * Run the hourly rollup for a given hour window.
   * Idempotent — uses upsert to safely retry.
   */
  static async runHourlyRollup(hourStart?: Date): Promise<{ processed: number; hourOf: Date }> {
    const targetHour = hourStart || this.floorToHour(new Date());
    const hourEnd = new Date(targetHour.getTime() + 60 * 60 * 1000);
    const trackerKey = 'campaign_hourly_stats';

    // Get campaigns with activity in this hour
    const activeCampaigns = await prisma.donation.findMany({
      where: {
        status: 'CONFIRMED',
        createdAt: { gte: targetHour, lt: hourEnd },
      },
      select: { campaignId: true },
      distinct: ['campaignId'],
    });

    const distributionCampaigns = await prisma.distribution.findMany({
      where: {
        status: 'COMPLETED',
        distributedAt: { gte: targetHour, lt: hourEnd },
      },
      select: { campaignId: true },
      distinct: ['campaignId'],
    });

    const allCampaignIds = [
      ...new Set([
        ...activeCampaigns.map((d) => d.campaignId),
        ...distributionCampaigns.map((d) => d.campaignId),
      ]),
    ];

    let processed = 0;

    for (const campaignId of allCampaignIds) {
      try {
        const [donationAgg, distributionAgg, uniqueDonorsResult, newBeneficiaries] =
          await Promise.all([
            prisma.donation.aggregate({
              where: {
                campaignId,
                status: 'CONFIRMED',
                createdAt: { gte: targetHour, lt: hourEnd },
              },
              _count: true,
              _sum: { amount: true },
            }),
            prisma.distribution.aggregate({
              where: {
                campaignId,
                status: 'COMPLETED',
                distributedAt: { gte: targetHour, lt: hourEnd },
              },
              _count: true,
              _sum: { amount: true },
            }),
            prisma.donation.groupBy({
              by: ['userId'],
              where: {
                campaignId,
                status: 'CONFIRMED',
                createdAt: { gte: targetHour, lt: hourEnd },
                userId: { not: null },
              },
            }),
            prisma.beneficiaryAssignment.count({
              where: {
                campaignId,
                assignedAt: { gte: targetHour, lt: hourEnd },
              },
            }),
          ]);

        await prisma.campaignHourlyStat.upsert({
          where: {
            campaignId_hour: { campaignId, hour: targetHour },
          },
          create: {
            campaignId,
            hour: targetHour,
            donationCount: donationAgg._count,
            donationVolume: donationAgg._sum.amount || 0,
            uniqueDonors: uniqueDonorsResult.length,
            distributionCount: distributionAgg._count,
            distributionVolume: distributionAgg._sum.amount || 0,
            itemsDistributed: distributionAgg._count,
            newBeneficiaries,
            activeDonors: uniqueDonorsResult.length,
          },
          update: {
            donationCount: donationAgg._count,
            donationVolume: donationAgg._sum.amount || 0,
            uniqueDonors: uniqueDonorsResult.length,
            distributionCount: distributionAgg._count,
            distributionVolume: distributionAgg._sum.amount || 0,
            itemsDistributed: distributionAgg._count,
            newBeneficiaries,
            activeDonors: uniqueDonorsResult.length,
          },
        });

        // Also rebuild and refresh the Redis cache for this campaign
        const stats = await this.buildCampaignStats(campaignId);
        await this.setCachedCampaignStats(campaignId, stats);

        processed++;
      } catch (err) {
        logger.error(`Hourly rollup failed for campaign ${campaignId}`, err);
      }
    }

    // Update tracker
    await this.updateLastProcessedHour(trackerKey, targetHour);

    logger.info(
      `Hourly rollup completed: ${processed} campaigns processed for hour ${targetHour.toISOString()}`
    );
    return { processed, hourOf: targetHour };
  }


  /**
 * Catch up any hours missed since the last successful run.
 * Called by the worker's scheduled job instead of runHourlyRollup() directly.
 */
static async catchUpHourlyRollups(): Promise<{ hoursProcessed: number }> {
  const trackerKey = 'campaign_hourly_stats';
  const currentHour = this.floorToHour(new Date());
  const lastHour = await this.getLastProcessedHour(trackerKey);

  // First run ever — nothing to catch up, just process the current hour.
  if (!lastHour) {
    await this.runHourlyRollup(currentHour);
    return { hoursProcessed: 1 };
  }

  let cursor = new Date(lastHour.getTime() + 60 * 60 * 1000); // next hour after last processed
  let hoursProcessed = 0;

  while (cursor <= currentHour) {
    await this.runHourlyRollup(cursor);
    cursor = new Date(cursor.getTime() + 60 * 60 * 1000);
    hoursProcessed++;
  }

  return { hoursProcessed };
}
  /**
   * Run the monthly rollup for a given month.
   * Idempotent — uses upsert to safely retry.
   */
  static async runMonthlyRollup(monthStart?: Date): Promise<{ processed: number; monthOf: Date }> {
    const targetMonth = monthStart || this.floorToMonth(new Date());
    const monthEnd = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 1));
    const trackerKey = 'campaign_monthly_stats';

    // Get all active campaigns
    const campaigns = await prisma.campaign.findMany({
      where: {
        OR: [
          { createdAt: { lt: monthEnd } },
          { status: { in: ['ACTIVE', 'COMPLETED', 'PAUSED'] } },
        ],
      },
      select: { id: true },
    });

    let processed = 0;

    for (const campaign of campaigns) {
      try {
        const [donationAgg, distributionAgg, uniqueDonorsResult] = await Promise.all([
          prisma.donation.aggregate({
            where: {
              campaignId: campaign.id,
              status: 'CONFIRMED',
              createdAt: { gte: targetMonth, lt: monthEnd },
            },
            _count: true,
            _sum: { amount: true },
          }),
          prisma.distribution.aggregate({
            where: {
              campaignId: campaign.id,
              status: 'COMPLETED',
              distributedAt: { gte: targetMonth, lt: monthEnd },
            },
            _count: true,
            _sum: { amount: true },
          }),
          prisma.donation.groupBy({
            by: ['userId'],
            where: {
              campaignId: campaign.id,
              status: 'CONFIRMED',
              createdAt: { gte: targetMonth, lt: monthEnd },
              userId: { not: null },
            },
          }),
        ]);

        // Donor growth: unique donors this month vs previous month
        const prevMonthStart = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() - 1, 1));
        const prevMonthDonors = await prisma.donation.groupBy({
          by: ['userId'],
          where: {
            campaignId: campaign.id,
            status: 'CONFIRMED',
            createdAt: { gte: prevMonthStart, lt: targetMonth },
            userId: { not: null },
          },
        });

        const donorGrowth = uniqueDonorsResult.length - prevMonthDonors.length;
        const distributionReach = distributionAgg._count;
        const campaignActivity = donationAgg._count + distributionAgg._count;

        await prisma.campaignMonthlyStat.upsert({
          where: {
            campaignId_month: { campaignId: campaign.id, month: targetMonth },
          },
          create: {
            campaignId: campaign.id,
            month: targetMonth,
            donationCount: donationAgg._count,
            donationVolume: donationAgg._sum.amount || 0,
            uniqueDonors: uniqueDonorsResult.length,
            distributionCount: distributionAgg._count,
            distributionVolume: distributionAgg._sum.amount || 0,
            itemsDistributed: distributionAgg._count,
            donorGrowth,
            distributionReach,
            campaignActivity,
            activeDonors: uniqueDonorsResult.length,
          },
          update: {
            donationCount: donationAgg._count,
            donationVolume: donationAgg._sum.amount || 0,
            uniqueDonors: uniqueDonorsResult.length,
            distributionCount: distributionAgg._count,
            distributionVolume: distributionAgg._sum.amount || 0,
            itemsDistributed: distributionAgg._count,
            donorGrowth,
            distributionReach,
            campaignActivity,
            activeDonors: uniqueDonorsResult.length,
          },
        });

        processed++;
      } catch (err) {
        logger.error(`Monthly rollup failed for campaign ${campaign.id}`, err);
      }
    }

    // Update tracker
    await this.updateLastProcessedMonth(trackerKey, targetMonth);

    logger.info(
      `Monthly rollup completed: ${processed} campaigns processed for month ${targetMonth.toISOString()}`
    );
    return { processed, monthOf: targetMonth };
  }

  /**
 * Catch up any months missed since the last successful run.
 * Called by the worker's scheduled job instead of runMonthlyRollup() directly.
 */
static async catchUpMonthlyRollups(): Promise<{ monthsProcessed: number }> {
  const trackerKey = 'campaign_monthly_stats';
  const currentMonth = this.floorToMonth(new Date());
  const lastMonth = await this.getLastProcessedMonth(trackerKey);

  // First run ever — nothing to catch up, just process the current month.
  if (!lastMonth) {
    await this.runMonthlyRollup(currentMonth);
    return { monthsProcessed: 1 };
  }

  // Months aren't a fixed duration, so advance by month index rather than milliseconds.
  let cursor = new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 1));
  let monthsProcessed = 0;

  while (cursor <= currentMonth) {
    await this.runMonthlyRollup(cursor);
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    monthsProcessed++;
  }

  return { monthsProcessed };
}

/**
 * Backfill hourly rollups for an explicit time range.
 * Unlike catchUpHourlyRollups (gap detection via tracker), this is for
 * manual/on-demand recomputation — e.g. after a data fix, or hydrating
 * history for a specific campaign. Does NOT touch the rollup tracker,
 * since backfill runs are independent of the "current" processing cursor.
 */
static async backfillHourlyRollups(
  startHour: Date,
  endHour: Date
): Promise<{ hoursProcessed: number }> {
  let cursor = this.floorToHour(startHour);
  const end = this.floorToHour(endHour);
  let hoursProcessed = 0;

  while (cursor <= end) {
    await this.runHourlyRollup(cursor);
    cursor = new Date(cursor.getTime() + 60 * 60 * 1000);
    hoursProcessed++;
  }

  logger.info(`Backfill completed: ${hoursProcessed} hours processed from ${startHour.toISOString()} to ${endHour.toISOString()}`);
  return { hoursProcessed };
}

/**
 * Backfill monthly rollups for an explicit time range.
 */
static async backfillMonthlyRollups(
  startMonth: Date,
  endMonth: Date
): Promise<{ monthsProcessed: number }> {
  let cursor = this.floorToMonth(startMonth);
  const end = this.floorToMonth(endMonth);
  let monthsProcessed = 0;

  while (cursor <= end) {
    await this.runMonthlyRollup(cursor);
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    monthsProcessed++;
  }

  logger.info(`Backfill completed: ${monthsProcessed} months processed from ${startMonth.toISOString()} to ${endMonth.toISOString()}`);
  return { monthsProcessed };
}

  /**
   * Floor a date to the start of the current hour.
   */
private static floorToHour(date: Date): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    0, 0, 0
  ));
}

  /**
   * Floor a date to the start of the current month.
   */
private static floorToMonth(date: Date): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    1
  ));
}

  /**
   * Rebuild all campaign caches — full reconciliation.
   * Called by the reconciliation job to heal any drift between Redis and DB.
   */
  static async rebuildAllCampaignCaches(): Promise<number> {
    const campaigns = await prisma.campaign.findMany({
      where: { status: { in: ['ACTIVE', 'COMPLETED', 'PAUSED'] } },
      select: { id: true },
    });

    let rebuilt = 0;
    for (const campaign of campaigns) {
      try {
        const stats = await this.buildCampaignStats(campaign.id);
        await this.setCachedCampaignStats(campaign.id, stats);
        rebuilt++;
      } catch (err) {
        logger.error(`Cache rebuild failed for campaign ${campaign.id}`, err);
      }
    }

    logger.info(`Cache reconciliation completed: ${rebuilt} campaigns rebuilt`);
    return rebuilt;
  }
}
