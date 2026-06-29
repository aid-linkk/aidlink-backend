import prisma from '../config/database';
import redis from '../config/redis';
import logger from '../config/logger';
import { config } from '../config';
import { stripDonorPII } from '../utils/anonymity';
import {
  TrendingCampaignFilters,
  TrendingCampaign,
  ImpactMetrics,
  HistoricalStats,
  CampaignAnalyticsFilters,
  PaginatedResponse,
  PaginationParams,
} from '../types';

// Redis cache key prefixes
const CACHE_PREFIX_STATS = 'campaign:stats:';
const CACHE_PREFIX_TRENDING_DATA = 'campaigns:trending:data';

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
  // CACHE-BASED CAMPAIGN STATS
  // ============================================

  /**
   * Get campaign stats from Redis cache, falling back to DB if cache miss.
   */
  static async getCachedCampaignStats(campaignId: string): Promise<Record<string, string>> {
    const cacheKey = `${CACHE_PREFIX_STATS}${campaignId}`;
    try {
      const cached = await redis.hgetall(cacheKey);
      if (cached && Object.keys(cached).length > 0) {
        return cached;
      }
    } catch (err) {
      logger.warn(`Redis cache read failed for ${cacheKey}`, err);
    }

    // Cache miss — build from DB and populate cache
    const stats = await this.buildCampaignStats(campaignId);
    await this.setCachedCampaignStats(campaignId, stats);
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

    const uniqueDonors = await prisma.donation.groupBy({
      by: ['userId'],
      where: { campaignId, status: 'CONFIRMED', userId: { not: null } },
    });

    const beneficiaryCount = await prisma.beneficiaryAssignment.count({
      where: { campaignId },
    });

    const targetAmount = Number(campaign.targetAmount) || 1;
    const currentAmount = Number(campaign.currentAmount) || 0;
    const progress = ((currentAmount / targetAmount) * 100).toFixed(2);

    return {
      campaignId: campaign.id,
      title: campaign.title,
      status: campaign.status,
      targetAmount: String(campaign.targetAmount),
      currentAmount: String(campaign.currentAmount),
      totalDonations: String(donationAgg._count),
      totalRaised: String(donationAgg._sum.amount || '0'),
      totalDistributions: String(distributionAgg._count),
      totalDistributed: String(distributionAgg._sum.amount || '0'),
      uniqueDonors: String(uniqueDonors.length),
      beneficiariesReached: String(beneficiaryCount),
      progressPercentage: progress,
    };
  }

  /**
   * Incrementally update campaign stats cache after a donation event.
   * Called by the analytics worker.
   */
  static async incrementDonationStats(campaignId: string, amount: number): Promise<void> {
    const cacheKey = `${CACHE_PREFIX_STATS}${campaignId}`;
    try {
      const exists = await redis.exists(cacheKey);
      if (exists) {
        await redis.hincrbyfloat(cacheKey, 'totalRaised', amount);
        await redis.hincrby(cacheKey, 'totalDonations', 1);
        // Note: uniqueDonors is NOT incremented here — it would inflate the count.
        // The hourly reconciliation job sets the correct value from grouped queries.
      }
    } catch (err) {
      logger.warn(`Redis increment failed for ${cacheKey}`, err);
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
        enriched.sort((a, b) => b.trendScore - a.trendScore);
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
      totalRaised = parseFloat(cachedStats.totalRaised || '0');
      totalDistributions = parseInt(cachedStats.totalDistributions || '0', 10);
      totalDistributedAmount = parseFloat(cachedStats.totalDistributed || '0');
      uniqueDonors = parseInt(cachedStats.uniqueDonors || '0', 10);
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

      // Build and cache
      const stats = await this.buildCampaignStats(campaignId);
      await this.setCachedCampaignStats(campaignId, stats);
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
   * Run the monthly rollup for a given month.
   * Idempotent — uses upsert to safely retry.
   */
  static async runMonthlyRollup(monthStart?: Date): Promise<{ processed: number; monthOf: Date }> {
    const targetMonth = monthStart || this.floorToMonth(new Date());
    const monthEnd = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 1);
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
        const prevMonthStart = new Date(targetMonth.getFullYear(), targetMonth.getMonth() - 1, 1);
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
   * Floor a date to the start of the current hour.
   */
  private static floorToHour(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), 0, 0, 0);
  }

  /**
   * Floor a date to the start of the current month.
   */
  private static floorToMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), 1);
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
