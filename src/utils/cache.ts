import redis from '../config/redis';
import logger from '../config/logger';

// ─── Key builder ───────────────────────────────────────────────────────────────

/**
 * Build a namespaced cache key.
 * Pattern: aidlink:<namespace>:<key>
 */
export function buildKey(namespace: string, key: string): string {
  return `aidlink:${namespace}:${key}`;
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Read from cache; on miss, call `factory()` and store the result.
 * Redis failures are caught and logged — the factory always runs as fallback.
 */
export async function getOrSet<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      return JSON.parse(cached) as T;
    }
  } catch (err) {
    logger.warn(`Redis cache read failed for ${key}`, err);
  }

  // Cache miss or Redis error — fall through to factory
  const result = await factory();

  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(result));
  } catch (err) {
    logger.warn(`Redis cache write failed for ${key}`, err);
  }

  return result;
}

/**
 * Delete a single cache key. Logs and swallows errors so Redis failures never crash requests.
 */
export async function delCache(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn(`Redis cache delete failed for ${key}`, err);
  }
}

// ─── Invalidations ────────────────────────────────────────────────────────────

const CACHE_PREFIX_STATS = 'campaign:stats:';

/**
 * Invalidate all caches related to a campaign:
 *  • campaign stats hash
 *  • campaign listing entries (scan + delete)
 *  • trending campaign lists (all periods)
 */
export async function invalidateCampaignCache(campaignId: string): Promise<void> {
  try {
    // 1. Campaign stats
    await redis.del(`${CACHE_PREFIX_STATS}${campaignId}`);

    // 2. Campaign listing caches (scan for matching keys)
    await deleteByPattern('aidlink:campaigns:list:*');

    // 3. Trending caches (all periods)
    for (const period of ['last24h', 'last7d', 'last30d']) {
      await redis.del(`campaigns:trending:data:${period}`);
    }

    logger.info(`Campaign cache invalidated: ${campaignId}`);
  } catch (err) {
    logger.warn(`Campaign cache invalidation failed for ${campaignId}`, err);
  }
}

/**
 * Invalidate all caches related to a beneficiary:
 *  • beneficiary profile by id
 *  • beneficiary listing entries
 */
export async function invalidateBeneficiaryCache(beneficiaryId: string): Promise<void> {
  try {
    await deleteByPattern(`aidlink:beneficiary:${beneficiaryId}`);
    await deleteByPattern('aidlink:beneficiaries:list:*');
    logger.info(`Beneficiary cache invalidated: ${beneficiaryId}`);
  } catch (err) {
    logger.warn(`Beneficiary cache invalidation failed for ${beneficiaryId}`, err);
  }
}

/**
 * Invalidate all search caches.
 */
export async function invalidateSearchCache(): Promise<void> {
  try {
    await deleteByPattern('aidlink:search:*');
    logger.info('Search cache invalidated');
  } catch (err) {
    logger.warn('Search cache invalidation failed', err);
  }
}

/**
 * Invalidate all analytics caches (except campaign stats handled separately).
 * Call when donation / distribution / beneficiary data changes.
 */
export async function invalidateAnalyticsCache(): Promise<void> {
  try {
    await deleteByPattern('aidlink:analytics:*');
    await deleteByPattern('campaigns:trending:data:*');
    logger.info('Analytics cache invalidated');
  } catch (err) {
    logger.warn('Analytics cache invalidation failed', err);
  }
}

// ─── Cache warming ────────────────────────────────────────────────────────────

/**
 * Warm campaign listing caches for the first few pages with default filters.
 */
export async function warmCampaignListingCache(
  fetchFn: (filters: Record<string, unknown>, page: number, limit: number) => Promise<unknown>,
  pages = 2,
  limit = 10,
): Promise<void> {
  for (let page = 1; page <= pages; page++) {
    const filters: Record<string, unknown> = { status: 'ACTIVE' };
    const key = buildKey('campaigns', `list:${JSON.stringify({ filters, page, limit, sortBy: 'createdAt', sortOrder: 'desc' })}`);
    try {
      const data = await fetchFn(filters, page, limit);
      await redis.setex(key, 300, JSON.stringify(data));
    } catch (err) {
      logger.warn(`Cache warm failed for campaign page ${page}`, err);
    }
  }
  logger.info(`Campaign listing cache warmed: ${pages} pages`);
}

/**
 * Warm beneficiary profile cache for known beneficiary IDs.
 */
export async function warmBeneficiaryCache(
  fetchFn: (id: string) => Promise<unknown>,
  ids: string[],
): Promise<void> {
  for (const id of ids) {
    const key = buildKey('beneficiary', id);
    try {
      const data = await fetchFn(id);
      await redis.setex(key, 600, JSON.stringify(data));
    } catch (err) {
      logger.warn(`Cache warm failed for beneficiary ${id}`, err);
    }
  }
  logger.info(`Beneficiary cache warmed: ${ids.length} profiles`);
}

// ─── Redis monitoring ─────────────────────────────────────────────────────────

export interface CacheHealth {
  status: 'healthy' | 'unhealthy';
  hits: number;
  misses: number;
  keyCount: number;
  memoryUsed: string;
  uptime: number;
}

/**
 * Check Redis connectivity and gather basic stats.
 */
export async function getCacheHealth(): Promise<CacheHealth> {
  try {
    await redis.ping();

    const info = await redis.info('stats');
    const memoryInfo = await redis.info('memory');
    const serverInfo = await redis.info('server');
    const keyCount = await redis.dbsize();

    const parseInfo = (infoStr: string, key: string): string => {
      const match = infoStr.match(new RegExp(`${key}:(.+)`));
      return match ? match[1].trim() : '0';
    };

    const hits = parseInt(parseInfo(info, 'keyspace_hits') || '0', 10);
    const misses = parseInt(parseInfo(info, 'keyspace_misses') || '0', 10);
    const memoryUsed = parseInfo(memoryInfo, 'used_memory_human');
    const uptime = parseInt(parseInfo(serverInfo, 'uptime_in_seconds') || '0', 10);

    return {
      status: 'healthy',
      hits,
      misses,
      keyCount,
      memoryUsed,
      uptime,
    };
  } catch (err) {
    logger.error('Redis health check failed', err);
    return {
      status: 'unhealthy',
      hits: 0,
      misses: 0,
      keyCount: 0,
      memoryUsed: 'N/A',
      uptime: 0,
    };
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Scan and delete all keys matching a glob pattern.
 * Uses SCAN (not KEYS) to avoid blocking Redis in production.
 */
async function deleteByPattern(pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== '0');
}
