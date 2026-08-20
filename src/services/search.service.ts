import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { getOrSet, buildKey } from '../utils/cache';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const DEFAULT_SORT_ORDER = 'desc' as const;

type CampaignSortField = 'createdAt' | 'updatedAt' | 'title' | 'targetAmount' | 'status' | 'relevance';
type DonationSortField = 'createdAt' | 'amount' | 'status' | 'relevance';

export interface SearchFilters {
  query?: string;
  entityType?: string;
  dateFrom?: Date;
  dateTo?: Date;
  status?: string;
  country?: string;
  minAmount?: number;
  maxAmount?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
  cursor?: string;
}

interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
}

interface PaginationMetadata {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  nextCursor?: string;
  prevCursor?: string;
}

interface CursorData {
  score: number;
  id: string;
}

// Bumped whenever the cursor payload shape or the score's numeric domain changes.
// Cursors encoded before this version compared a float4 relevance score against
// a value Prisma bound as `numeric`, which silently produced wrong WHERE-clause
// comparisons (see decodeCursor). Versioning lets us detect and reject them
// instead of misinterpreting the score.
const CURSOR_VERSION = 2;

class InvalidCursorError extends Error {
  constructor(message = 'Invalid or unsupported cursor') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

function encodeCursor(score: number, id: string): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, score, id })).toString('base64');
}

function decodeCursor(cursor: string): CursorData {
  let parsed: unknown;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    parsed = JSON.parse(decoded);
  } catch {
    throw new InvalidCursorError();
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { v?: unknown }).v !== CURSOR_VERSION ||
    typeof (parsed as { score?: unknown }).score !== 'number' ||
    !Number.isFinite((parsed as { score: number }).score) ||
    typeof (parsed as { id?: unknown }).id !== 'string' ||
    !(parsed as { id: string }).id
  ) {
    throw new InvalidCursorError();
  }

  const { score, id } = parsed as { score: number; id: string };
  return { score, id };
}

// Cursors predating CURSOR_VERSION (or otherwise malformed) are treated as absent
// rather than misinterpreted, so a stale cursor just resumes at the first page
// instead of corrupting pagination.
function safeDecodeCursor(cursor: string | undefined): CursorData | undefined {
  if (!cursor) return undefined;
  try {
    return decodeCursor(cursor);
  } catch (error) {
    if (error instanceof InvalidCursorError) return undefined;
    throw error;
  }
}

function normalizePagination(page?: number, limit?: number): PaginationParams {
  const normalizedPage = Math.max(1, page ?? DEFAULT_PAGE);
  const normalizedLimit = Math.max(1, Math.min(100, limit ?? DEFAULT_LIMIT));
  return {
    page: normalizedPage,
    limit: normalizedLimit,
    skip: (normalizedPage - 1) * normalizedLimit,
  };
}

function buildPaginationMetadata(page: number, limit: number, total: number): PaginationMetadata {
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

function validateAndNormalizeSort<T extends string>(
  sortBy: string | undefined,
  validFields: T[],
  defaultField: T,
  sortOrder: 'asc' | 'desc' | undefined
): { sortBy: T; sortOrder: 'asc' | 'desc' } {
  const validSortBy = validFields.includes(sortBy as T) ? (sortBy as T) : defaultField;
  const validSortOrder = sortOrder === 'asc' ? 'asc' : DEFAULT_SORT_ORDER;
  return { sortBy: validSortBy, sortOrder: validSortOrder };
}

function buildCampaignOrderBy(sortBy: CampaignSortField, sortOrder: 'asc' | 'desc'): any {
  return [{ [sortBy]: sortOrder }, { id: 'asc' }];
}

function buildDonationOrderBy(sortBy: DonationSortField, sortOrder: 'asc' | 'desc'): any {
  return [{ [sortBy]: sortOrder }, { id: 'asc' }];
}

export type BeneficiarySortField =
  | 'relevance'
  | 'createdAt'
  | 'updatedAt'
  | 'riskScore'
  | 'age'
  | 'familySize';

export interface BeneficiarySearchFilters {
  query?: string;
  country?: string;
  city?: string;
  needsCategory?: string;
  verificationStatus?: string;
  riskScoreMin?: number;
  riskScoreMax?: number;
  ageMin?: number;
  ageMax?: number;
  familySizeMin?: number;
  familySizeMax?: number;
  sortBy?: BeneficiarySortField;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
  cursor?: string;
}

interface NumericBucket {
  label: string;
  min: number;
  max: number;
}

const RISK_SCORE_BUCKETS: NumericBucket[] = [
  { label: '0-25', min: 0, max: 25 },
  { label: '26-50', min: 26, max: 50 },
  { label: '51-75', min: 51, max: 75 },
  { label: '76+', min: 76, max: Number.POSITIVE_INFINITY },
];

type BeneficiaryFacetDimension =
  | 'country'
  | 'city'
  | 'needsCategory'
  | 'status'
  | 'risk'
  | 'family'
  | 'age';

const AGE_BUCKETS: NumericBucket[] = [
  { label: '0-17', min: 0, max: 17 },
  { label: '18-25', min: 18, max: 25 },
  { label: '26-35', min: 26, max: 35 },
  { label: '36-50', min: 36, max: 50 },
  { label: '51-65', min: 51, max: 65 },
  { label: '66+', min: 66, max: Number.POSITIVE_INFINITY },
];

const FAMILY_SIZE_BUCKETS: NumericBucket[] = [
  { label: '1', min: 1, max: 1 },
  { label: '2-3', min: 2, max: 3 },
  { label: '4-5', min: 4, max: 5 },
  { label: '6+', min: 6, max: Number.POSITIVE_INFINITY },
];

function subtractYears(date: Date, years: number): Date {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() - years);
  return d;
}

function ageRangeToDobFilter(
  ageMin: number | undefined,
  ageMax: number | undefined,
  now: Date
): { gt?: Date; lte?: Date } | undefined {
  const dob: { gt?: Date; lte?: Date } = {};
  if (ageMin !== undefined) {
    // At least `ageMin` years old => born on or before (now - ageMin years).
    dob.lte = subtractYears(now, ageMin);
  }
  if (ageMax !== undefined) {
    // At most `ageMax` years old => born after (now - (ageMax + 1) years).
    dob.gt = subtractYears(now, ageMax + 1);
  }
  return Object.keys(dob).length ? dob : undefined;
}

type GroupCount = { _count: { _all: number } } & Record<string, unknown>;

function toValueFacet(
  groups: GroupCount[],
  field: string
): Array<{ value: unknown; count: number }> {
  return groups
    .filter((g) => g[field] !== null && g[field] !== undefined)
    .map((g) => ({ value: g[field], count: g._count._all }))
    .sort((a, b) => b.count - a.count);
}

function bucketize(
  groups: GroupCount[],
  field: string,
  buckets: NumericBucket[]
): Array<{ range: string; count: number }> {
  const counts = buckets.map(() => 0);
  for (const group of groups) {
    const raw = group[field];
    if (raw === null || raw === undefined) continue;
    const value = Number(raw);
    const index = buckets.findIndex((b) => value >= b.min && value <= b.max);
    if (index >= 0) counts[index] += group._count._all;
  }
  return buckets.map((b, i) => ({ range: b.label, count: counts[i] }));
}

// Relative weights per match quality; multiplied by a field's weight below to
// produce that field's contribution to the total relevance score.
const MATCH_TIER_SCORES = {
  exact: 100,
  startsWith: 60,
  contains: 20,
} as const;

// Relative importance of each searchable field, applied to MATCH_TIER_SCORES.
const CAMPAIGN_FIELD_WEIGHTS = {
  title: 1,
  description: 0.4,
};

const DONATION_FIELD_WEIGHTS = {
  memo: 1,
  fromWallet: 0.8,
  donorMessage: 0.3,
};

interface LikePatterns {
  exact: string;
  prefix: string;
  contains: string;
}

function escapeLikeSpecialChars(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function buildLikePatterns(query: string): LikePatterns {
  const escaped = escapeLikeSpecialChars(query);
  return {
    exact: escaped,
    prefix: `${escaped}%`,
    contains: `%${escaped}%`,
  };
}

function likeScoreCase(column: string, weight: number, patterns: LikePatterns): Prisma.Sql {
  const exactScore = Math.round(MATCH_TIER_SCORES.exact * weight);
  const prefixScore = Math.round(MATCH_TIER_SCORES.startsWith * weight);
  const containsScore = Math.round(MATCH_TIER_SCORES.contains * weight);
  const col = Prisma.raw(`"${column}"`);
  return Prisma.sql`CASE
    WHEN ${col} ILIKE ${patterns.exact} THEN ${exactScore}
    WHEN ${col} ILIKE ${patterns.prefix} THEN ${prefixScore}
    WHEN ${col} ILIKE ${patterns.contains} THEN ${containsScore}
    ELSE 0
  END`;
}

// Shared date/amount conditions for relevance queries; status is entity-specific
// (different enum types) and pushed on by the caller.
function relevanceFilterConditions(filters: SearchFilters, amountColumn: string): Prisma.Sql[] {
  const { dateFrom, dateTo, minAmount, maxAmount } = filters;
  const conditions: Prisma.Sql[] = [];
  if (dateFrom) conditions.push(Prisma.sql`"createdAt" >= ${dateFrom}`);
  if (dateTo) conditions.push(Prisma.sql`"createdAt" <= ${dateTo}`);
  if (minAmount) conditions.push(Prisma.sql`${Prisma.raw(amountColumn)} >= ${minAmount}`);
  if (maxAmount) conditions.push(Prisma.sql`${Prisma.raw(amountColumn)} <= ${maxAmount}`);
  return conditions;
}

export class SearchService {
  static async searchCampaigns(filters: SearchFilters) {
    const { query, dateFrom, dateTo, status, minAmount, maxAmount, sortBy, sortOrder, page, limit, cursor } = filters;

    // Use trigram similarity search when query is provided and sortBy is relevance or not specified
    if (query && (!sortBy || sortBy === 'relevance')) {
      const cacheKey = buildKey('search', `campaigns:${JSON.stringify({ ...filters, sortBy: 'relevance' })}`);
      return getOrSet(cacheKey, 120, async () => {
        return this.searchCampaignsByRelevance(filters, query);
      });
    }

    const cacheKey = buildKey('search', `campaigns:${JSON.stringify(filters)}`);

    return getOrSet(cacheKey, 120, async () => {
      const { page: normalizedPage, limit: normalizedLimit, skip } = normalizePagination(page, limit);
      const { sortBy: validSortBy, sortOrder: validSortOrder } = validateAndNormalizeSort(
        sortBy,
        ['createdAt', 'updatedAt', 'title', 'targetAmount', 'status', 'relevance'],
        'createdAt',
        sortOrder
      );
      const orderBy = buildCampaignOrderBy(validSortBy, validSortOrder);

      const where: any = {};

      if (query) {
        where.OR = [
          { title: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
        ];
      }

      if (status) {
        where.status = status;
      }

      if (dateFrom || dateTo) {
        where.createdAt = {};
        if (dateFrom) where.createdAt.gte = dateFrom;
        if (dateTo) where.createdAt.lte = dateTo;
      }

      if (minAmount || maxAmount) {
        where.targetAmount = {};
        if (minAmount) where.targetAmount.gte = minAmount;
        if (maxAmount) where.targetAmount.lte = maxAmount;
      }

      const [campaigns, total] = await Promise.all([
        prisma.campaign.findMany({
          where,
          skip,
          take: normalizedLimit,
          orderBy,
          include: {
            organization: {
              select: {
                name: true,
              },
            },
            _count: {
              select: {
                donations: true,
                beneficiaries: true,
              },
            },
          },
        }),
        prisma.campaign.count({ where }),
      ]);

      return {
        data: campaigns,
        pagination: buildPaginationMetadata(normalizedPage, normalizedLimit, total),
      };
    });
  }

  static async searchDonations(filters: SearchFilters) {
    const { query, dateFrom, dateTo, status, minAmount, maxAmount, sortBy, sortOrder, page, limit, cursor } = filters;

    // Use trigram similarity search when query is provided and sortBy is relevance or not specified
    if (query && (!sortBy || sortBy === 'relevance')) {
      const cacheKey = buildKey('search', `donations:${JSON.stringify({ ...filters, sortBy: 'relevance' })}`);
      return getOrSet(cacheKey, 120, async () => {
        return this.searchDonationsByRelevance(filters, query);
      });
    }

    const cacheKey = buildKey('search', `donations:${JSON.stringify(filters)}`);

    return getOrSet(cacheKey, 120, async () => {
      const { page: normalizedPage, limit: normalizedLimit, skip } = normalizePagination(page, limit);
      const { sortBy: validSortBy, sortOrder: validSortOrder } = validateAndNormalizeSort(
        sortBy,
        ['createdAt', 'amount', 'status', 'relevance'],
        'createdAt',
        sortOrder
      );
      const orderBy = buildDonationOrderBy(validSortBy, validSortOrder);

      const where: any = {};

      if (query) {
        where.OR = [
          { memo: { contains: query, mode: 'insensitive' } },
          { donorMessage: { contains: query, mode: 'insensitive' } },
          { fromWallet: { contains: query, mode: 'insensitive' } },
        ];
      }

      if (status) {
        where.status = status;
      }

      if (dateFrom || dateTo) {
        where.createdAt = {};
        if (dateFrom) where.createdAt.gte = dateFrom;
        if (dateTo) where.createdAt.lte = dateTo;
      }

      if (minAmount || maxAmount) {
        where.amount = {};
        if (minAmount) where.amount.gte = minAmount;
        if (maxAmount) where.amount.lte = maxAmount;
      }

      const [donations, total] = await Promise.all([
        prisma.donation.findMany({
          where,
          skip,
          take: normalizedLimit,
          orderBy,
          include: {
            campaign: {
              select: {
                id: true,
                title: true,
              },
            },
            user: query
              ? {
                  select: {
                    id: true,
                    username: true,
                    email: true,
                  },
                }
              : undefined,
          },
        }),
        prisma.donation.count({ where }),
      ]);

      return {
        data: donations,
        pagination: buildPaginationMetadata(normalizedPage, normalizedLimit, total),
      };
    });
  }

  private static async searchCampaignsByRelevance(filters: SearchFilters, query: string) {
    const { page = 1, limit = 20, cursor } = filters;
    const normalizedLimit = Math.max(1, Math.min(100, limit));
    
    // Build filter conditions
    const conditions: Prisma.Sql[] = [];
    if (filters.status) conditions.push(Prisma.sql`status = ${filters.status}::"CampaignStatus"`);
    if (filters.dateFrom) conditions.push(Prisma.sql`"createdAt" >= ${filters.dateFrom}`);
    if (filters.dateTo) conditions.push(Prisma.sql`"createdAt" <= ${filters.dateTo}`);
    if (filters.minAmount) conditions.push(Prisma.sql`"targetAmount" >= ${filters.minAmount}`);
    if (filters.maxAmount) conditions.push(Prisma.sql`"targetAmount" <= ${filters.maxAmount}`);
    
    const whereSql = conditions.length ? Prisma.join(conditions, ' AND ') : Prisma.sql`TRUE`;

    // Use word_similarity for trigram-based relevance scoring. word_similarity() returns
    // a float4 (real); explicitly casting to double precision makes every occurrence of
    // this expression (SELECT, threshold filter, cursor comparison) compare in the same
    // Postgres type, and makes the value we hand back to JS the same one we compare
    // against on the next page — see decodeCursor/encodeCursor above.
    const scoreExpr = Prisma.sql`CAST(GREATEST(
      word_similarity(${query}, title),
      COALESCE(word_similarity(${query}, description), 0)
    ) AS DOUBLE PRECISION)`;

    // Build cursor condition if provided. Postgres does not allow referencing a SELECT-list
    // alias (e.g. bare "score") from the same query's WHERE clause, so the expression is
    // repeated rather than aliased. The (score, id) < (x, y) row-comparison form is also
    // avoided in favor of an explicit OR, so both operands of every comparison have a
    // known, matching type instead of relying on implicit tuple-comparison promotion.
    let cursorCondition = Prisma.sql``;
    const decodedCursor = safeDecodeCursor(cursor);
    if (decodedCursor) {
      const { score: lastScore, id: lastId } = decodedCursor;
      cursorCondition = Prisma.sql` AND (
        ${scoreExpr} < CAST(${lastScore} AS DOUBLE PRECISION)
        OR (${scoreExpr} = CAST(${lastScore} AS DOUBLE PRECISION) AND id < ${lastId})
      )`;
    }

    const [rankedRows, countRows] = await Promise.all([
      prisma.$queryRaw<Array<{ id: string; score: number }>>(Prisma.sql`
        SELECT id, ${scoreExpr} AS score
        FROM "Campaign"
        WHERE ${whereSql}
          AND (${scoreExpr} > 0.2${cursorCondition})
        ORDER BY score DESC, id DESC
        LIMIT ${normalizedLimit}
      `),
      prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS count
        FROM "Campaign"
        WHERE ${whereSql} AND ${scoreExpr} > 0.2
      `),
    ]);
    
    const total = countRows[0]?.count ?? 0;
    const ids = rankedRows.map((r: { id: string; score: number }) => r.id);
    const scoreMap = new Map(rankedRows.map((r: { id: string; score: number }) => [r.id, r.score]));
    
    const campaigns = ids.length
      ? await prisma.campaign.findMany({
          where: { id: { in: ids } },
          include: {
            organization: { select: { name: true } },
            _count: { select: { donations: true, beneficiaries: true } },
          },
        })
      : [];
    
    // Sort by score descending, then by id descending for stability
    const data = campaigns.sort((a: any, b: any) => {
      const scoreA = (scoreMap.get(a.id) ?? 0) as number;
      const scoreB = (scoreMap.get(b.id) ?? 0) as number;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return b.id.localeCompare(a.id);
    });
    
    // Generate next cursor if there are more results
    let nextCursor: string | undefined;
    if (data.length === normalizedLimit && ids.length > 0) {
      const lastResult = data[data.length - 1];
      const lastScore = (scoreMap.get(lastResult.id) ?? 0) as number;
      nextCursor = encodeCursor(lastScore, lastResult.id);
    }
    
    return {
      data: data.map((c: any) => ({ ...c, relevanceScore: scoreMap.get(c.id) ?? 0 })),
      pagination: {
        page,
        limit: normalizedLimit,
        total,
        totalPages: Math.ceil(total / normalizedLimit),
        nextCursor,
      },
    };
  }

  private static async searchDonationsByRelevance(filters: SearchFilters, query: string) {
    const { page = 1, limit = 20, cursor } = filters;
    const normalizedLimit = Math.max(1, Math.min(100, limit));
    
    // Build filter conditions
    const conditions: Prisma.Sql[] = [];
    if (filters.status) conditions.push(Prisma.sql`status = ${filters.status}::"DonationStatus"`);
    if (filters.dateFrom) conditions.push(Prisma.sql`"createdAt" >= ${filters.dateFrom}`);
    if (filters.dateTo) conditions.push(Prisma.sql`"createdAt" <= ${filters.dateTo}`);
    if (filters.minAmount) conditions.push(Prisma.sql`amount >= ${filters.minAmount}`);
    if (filters.maxAmount) conditions.push(Prisma.sql`amount <= ${filters.maxAmount}`);
    
    const whereSql = conditions.length ? Prisma.join(conditions, ' AND ') : Prisma.sql`TRUE`;

    // See searchCampaignsByRelevance for why the score is cast to double precision and
    // why the cursor comparison repeats the expression via an explicit OR instead of
    // referencing the "score" alias or using tuple comparison.
    const scoreExpr = Prisma.sql`CAST(GREATEST(
      COALESCE(word_similarity(${query}, memo), 0),
      COALESCE(word_similarity(${query}, "fromWallet"), 0),
      COALESCE(word_similarity(${query}, "donorMessage"), 0)
    ) AS DOUBLE PRECISION)`;

    let cursorCondition = Prisma.sql``;
    const decodedCursor = safeDecodeCursor(cursor);
    if (decodedCursor) {
      const { score: lastScore, id: lastId } = decodedCursor;
      cursorCondition = Prisma.sql` AND (
        ${scoreExpr} < CAST(${lastScore} AS DOUBLE PRECISION)
        OR (${scoreExpr} = CAST(${lastScore} AS DOUBLE PRECISION) AND id < ${lastId})
      )`;
    }

    const [rankedRows, countRows] = await Promise.all([
      prisma.$queryRaw<Array<{ id: string; score: number }>>(Prisma.sql`
        SELECT id, ${scoreExpr} AS score
        FROM "Donation"
        WHERE ${whereSql}
          AND (${scoreExpr} > 0.2${cursorCondition})
        ORDER BY score DESC, id DESC
        LIMIT ${normalizedLimit}
      `),
      prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS count
        FROM "Donation"
        WHERE ${whereSql} AND ${scoreExpr} > 0.2
      `),
    ]);
    
    const total = countRows[0]?.count ?? 0;
    const ids = rankedRows.map((r: { id: string; score: number }) => r.id);
    const scoreMap = new Map(rankedRows.map((r: { id: string; score: number }) => [r.id, r.score]));
    
    const donations = ids.length
      ? await prisma.donation.findMany({
          where: { id: { in: ids } },
          include: {
            campaign: { select: { id: true, title: true } },
            user: { select: { id: true, username: true, email: true } },
          },
        })
      : [];
    
    // Sort by score descending, then by id descending for stability
    const data = donations.sort((a: any, b: any) => {
      const scoreA = (scoreMap.get(a.id) ?? 0) as number;
      const scoreB = (scoreMap.get(b.id) ?? 0) as number;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return b.id.localeCompare(a.id);
    });
    
    // Generate next cursor if there are more results
    let nextCursor: string | undefined;
    if (data.length === normalizedLimit && ids.length > 0) {
      const lastResult = data[data.length - 1];
      const lastScore = (scoreMap.get(lastResult.id) ?? 0) as number;
      nextCursor = encodeCursor(lastScore, lastResult.id);
    }
    
    return {
      data: data.map((d: any) => ({ ...d, relevanceScore: scoreMap.get(d.id) ?? 0 })),
      pagination: {
        page,
        limit: normalizedLimit,
        total,
        totalPages: Math.ceil(total / normalizedLimit),
        nextCursor,
      },
    };
  }

  static buildBeneficiaryWhere(
    filters: BeneficiarySearchFilters,
    now: Date,
    exclude: ReadonlySet<string> = new Set()
  ): any {
    const {
      query,
      country,
      city,
      needsCategory,
      verificationStatus,
      riskScoreMin,
      riskScoreMax,
      ageMin,
      ageMax,
      familySizeMin,
      familySizeMax,
    } = filters;

    const where: any = {};

    if (query) {
      where.OR = [
        { firstName: { contains: query, mode: 'insensitive' } },
        { lastName: { contains: query, mode: 'insensitive' } },
        { idDocumentNumber: { contains: query, mode: 'insensitive' } },
        { phoneNumber: { contains: query, mode: 'insensitive' } },
        { needsAssessment: { contains: query, mode: 'insensitive' } },
      ];
    }

    if (verificationStatus && !exclude.has('status')) where.status = verificationStatus;
    if (country && !exclude.has('country')) where.country = country;
    if (city && !exclude.has('city')) where.city = city;
    if (needsCategory && !exclude.has('needsCategory')) where.needsCategory = needsCategory;

    if (!exclude.has('risk') && (riskScoreMin !== undefined || riskScoreMax !== undefined)) {
      where.riskScore = {};
      if (riskScoreMin !== undefined) where.riskScore.gte = riskScoreMin;
      if (riskScoreMax !== undefined) where.riskScore.lte = riskScoreMax;
    }

    if (!exclude.has('family') && (familySizeMin !== undefined || familySizeMax !== undefined)) {
      where.familySize = {};
      if (familySizeMin !== undefined) where.familySize.gte = familySizeMin;
      if (familySizeMax !== undefined) where.familySize.lte = familySizeMax;
    }

    if (!exclude.has('age')) {
      const dobFilter = ageRangeToDobFilter(ageMin, ageMax, now);
      if (dobFilter) where.dateOfBirth = dobFilter;
    }

    return where;
  }

  static buildBeneficiaryOrderBy(
    sortBy: BeneficiarySortField,
    sortOrder: 'asc' | 'desc',
    hasRelevanceScore: boolean = false
  ): any[] {
    const tiebreaker = { id: 'asc' as const };
    switch (sortBy) {
      case 'age':
        // Older age => earlier dateOfBirth, so invert the requested order.
        return [{ dateOfBirth: sortOrder === 'desc' ? 'asc' : 'desc' }, tiebreaker];
      case 'relevance':
        // Use relevanceScore if available (from trigram similarity), otherwise fall back to recency.
        if (hasRelevanceScore) {
          return [{ relevanceScore: sortOrder }, tiebreaker];
        }
        return [{ createdAt: sortOrder }, tiebreaker];
      case 'createdAt':
      case 'updatedAt':
      case 'riskScore':
      case 'familySize':
        return [{ [sortBy]: sortOrder }, tiebreaker];
      default:
        return [{ createdAt: 'desc' }, tiebreaker];
    }
  }

  static beneficiaryFacetQueries(filters: BeneficiarySearchFilters, now: Date): any[] {
    const whereExcluding = (dimension: BeneficiaryFacetDimension) =>
      this.buildBeneficiaryWhere(filters, now, new Set<string>([dimension]));

    const ageBase = whereExcluding('age');
    const ageQueries = AGE_BUCKETS.map((bucket) => {
      const dob = ageRangeToDobFilter(
        bucket.min > 0 ? bucket.min : undefined,
        Number.isFinite(bucket.max) ? bucket.max : undefined,
        now
      );
      const where = dob ? { AND: [ageBase, { dateOfBirth: dob }] } : ageBase;
      return prisma.beneficiary.count({ where });
    });

    return [
      prisma.beneficiary.groupBy({ by: ['country'], where: whereExcluding('country'), _count: { _all: true } }),
      prisma.beneficiary.groupBy({ by: ['city'], where: whereExcluding('city'), _count: { _all: true } }),
      prisma.beneficiary.groupBy({ by: ['needsCategory'], where: whereExcluding('needsCategory'), _count: { _all: true } }),
      prisma.beneficiary.groupBy({ by: ['status'], where: whereExcluding('status'), _count: { _all: true } }),
      prisma.beneficiary.groupBy({ by: ['riskScore'], where: whereExcluding('risk'), _count: { _all: true } }),
      prisma.beneficiary.groupBy({ by: ['familySize'], where: whereExcluding('family'), _count: { _all: true } }),
      ...ageQueries,
    ];
  }

  static assembleBeneficiaryFacets(results: any[]) {
    const [countryGroups, cityGroups, needsGroups, statusGroups, riskGroups, familyGroups, ...ageCounts] =
      results;

    return {
      countries: toValueFacet(countryGroups as GroupCount[], 'country'),
      cities: toValueFacet(cityGroups as GroupCount[], 'city'),
      needsCategories: toValueFacet(needsGroups as GroupCount[], 'needsCategory'),
      verificationStatuses: toValueFacet(statusGroups as GroupCount[], 'status'),
      riskScoreRanges: bucketize(riskGroups as GroupCount[], 'riskScore', RISK_SCORE_BUCKETS),
      ageRanges: AGE_BUCKETS.map((bucket, i) => ({
        range: bucket.label,
        count: (ageCounts[i] as number) ?? 0,
      })),
      familySizeRanges: bucketize(familyGroups as GroupCount[], 'familySize', FAMILY_SIZE_BUCKETS),
    };
  }

  private static async searchBeneficiariesByRelevance(filters: BeneficiarySearchFilters, query: string) {
    const { page = 1, limit = 20, cursor } = filters;
    const normalizedLimit = Math.max(1, Math.min(100, limit));
    
    const now = new Date();
    const where = this.buildBeneficiaryWhere(filters, now);
    
    // Build filter conditions for SQL
    const conditions: Prisma.Sql[] = [];
    if (filters.verificationStatus) conditions.push(Prisma.sql`status = ${filters.verificationStatus}::"BeneficiaryStatus"`);
    if (filters.country) conditions.push(Prisma.sql`country = ${filters.country}`);
    if (filters.city) conditions.push(Prisma.sql`city = ${filters.city}`);
    if (filters.needsCategory) conditions.push(Prisma.sql`"needsCategory" = ${filters.needsCategory}`);
    
    const whereSql = conditions.length ? Prisma.join(conditions, ' AND ') : Prisma.sql`TRUE`;
    
    // Build cursor condition if provided
    let cursorCondition = Prisma.sql``;
    const decodedCursor = safeDecodeCursor(cursor);
    if (decodedCursor) {
      const { score: lastScore, id: lastId } = decodedCursor;
      cursorCondition = Prisma.sql` AND (score, id) < (${lastScore}, ${lastId})`;
    }

    // Use word_similarity for trigram-based relevance scoring
    const scoreExpr = Prisma.sql`GREATEST(
      word_similarity(${query}, "firstName"),
      word_similarity(${query}, "lastName"),
      word_similarity(${query}, "idDocumentNumber"),
      word_similarity(${query}, "phoneNumber"),
      COALESCE(word_similarity(${query}, "needsAssessment"), 0)
    )`;
    
    const [rankedRows, countRows] = await Promise.all([
      prisma.$queryRaw<Array<{ id: string; score: number }>>(Prisma.sql`
        SELECT id, ${scoreExpr} AS score
        FROM "Beneficiary"
        WHERE ${whereSql}
          AND (${scoreExpr} > 0.2${cursorCondition})
        ORDER BY score DESC, id DESC
        LIMIT ${normalizedLimit}
      `),
      prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS count
        FROM "Beneficiary"
        WHERE ${whereSql} AND ${scoreExpr} > 0.2
      `),
    ]);
    
    const total = countRows[0]?.count ?? 0;
    const ids = rankedRows.map((r: { id: string; score: number }) => r.id);
    const scoreMap = new Map(rankedRows.map((r: { id: string; score: number }) => [r.id, r.score]));
    
    const beneficiaries = ids.length
      ? await prisma.beneficiary.findMany({
          where: { id: { in: ids } },
          include: {
            user: {
              select: {
                id: true,
                email: true,
              },
            },
            _count: {
              select: {
                distributions: true,
              },
            },
          },
        })
      : [];
    
    // Sort by score descending, then by id descending for stability
    const data = beneficiaries.sort((a: any, b: any) => {
      const scoreA = (scoreMap.get(a.id) ?? 0) as number;
      const scoreB = (scoreMap.get(b.id) ?? 0) as number;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return b.id.localeCompare(a.id);
    });
    
    // Generate next cursor if there are more results
    let nextCursor: string | undefined;
    if (data.length === normalizedLimit && ids.length > 0) {
      const lastResult = data[data.length - 1];
      const lastScore = (scoreMap.get(lastResult.id) ?? 0) as number;
      nextCursor = encodeCursor(lastScore, lastResult.id);
    }
    
    return {
      data: data.map((b: any) => ({ ...b, relevanceScore: scoreMap.get(b.id) ?? 0 })),
      pagination: {
        page,
        limit: normalizedLimit,
        total,
        totalPages: Math.ceil(total / normalizedLimit),
        nextCursor,
      },
    };
  }

  static async searchBeneficiaries(filters: BeneficiarySearchFilters) {
    const { sortBy, sortOrder, page, limit, query, cursor } = filters;

    const now = new Date();

    // Use trigram similarity search when query is provided and sortBy is relevance or not specified
    if (query && (!sortBy || sortBy === 'relevance')) {
      const cacheKey = buildKey('search', `beneficiaries:${JSON.stringify({ ...filters, sortBy: 'relevance' })}`);
      return getOrSet(cacheKey, 120, async () => {
        return this.searchBeneficiariesByRelevance(filters, query);
      });
    }

    const cacheKey = buildKey('search', `beneficiaries:${JSON.stringify(filters)}`);

    return getOrSet(cacheKey, 120, async () => {
      const { page: normalizedPage, limit: normalizedLimit, skip } = normalizePagination(page, limit);
      const { sortBy: validSortBy, sortOrder: validSortOrder } = validateAndNormalizeSort(
        sortBy,
        ['relevance', 'createdAt', 'updatedAt', 'riskScore', 'age', 'familySize'],
        'createdAt',
        sortOrder
      );
      const where = this.buildBeneficiaryWhere(filters, now);
      const orderBy = this.buildBeneficiaryOrderBy(validSortBy, validSortOrder, false);
      const facetQueries = this.beneficiaryFacetQueries(filters, now);

      const [beneficiaries, total, ...facetResults] = await prisma.$transaction([
        prisma.beneficiary.findMany({
          where,
          skip,
          take: normalizedLimit,
          orderBy,
          include: {
            user: {
              select: {
                id: true,
                email: true,
              },
            },
            _count: {
              select: {
                distributions: true,
              },
            },
          },
        }),
        prisma.beneficiary.count({ where }),
        ...facetQueries,
      ]);

      return {
        data: beneficiaries,
        pagination: buildPaginationMetadata(normalizedPage, normalizedLimit, total),
        facets: this.assembleBeneficiaryFacets(facetResults),
      };
    });
  }

  static async globalSearch(filters: SearchFilters) {
    const { query, page, limit, cursor } = filters;

    if (!query) {
      throw new Error('Query is required for global search');
    }

    const { page: normalizedPage, limit: normalizedLimit } = normalizePagination(page, limit);

    // Use trigram similarity search with BM25-inspired scoring
    const cacheKey = buildKey('search', `global:${JSON.stringify(filters)}`);
    return getOrSet(cacheKey, 120, async () => {
      // Fetch candidates from each entity type with trigram similarity scores
      const [campaignRows, donationRows, beneficiaryRows] = await Promise.all([
        prisma.$queryRaw<Array<{ id: string; title: string; status: string; score: number }>>(Prisma.sql`
          SELECT id, title, status, 
            GREATEST(word_similarity(${query}, title), word_similarity(${query}, description)) AS score
          FROM "Campaign"
          WHERE GREATEST(word_similarity(${query}, title), word_similarity(${query}, description)) > 0.2
          ORDER BY score DESC, id DESC
          LIMIT ${normalizedLimit * 3}
        `),
        prisma.$queryRaw<Array<{ id: string; amount: number; status: string; score: number }>>(Prisma.sql`
          SELECT id, amount, status,
            GREATEST(
              COALESCE(word_similarity(${query}, memo), 0),
              COALESCE(word_similarity(${query}, "fromWallet"), 0),
              COALESCE(word_similarity(${query}, "donorMessage"), 0)
            ) AS score
          FROM "Donation"
          WHERE GREATEST(
            COALESCE(word_similarity(${query}, memo), 0),
            COALESCE(word_similarity(${query}, "fromWallet"), 0),
            COALESCE(word_similarity(${query}, "donorMessage"), 0)
          ) > 0.2
          ORDER BY score DESC, id DESC
          LIMIT ${normalizedLimit * 3}
        `),
        prisma.$queryRaw<Array<{ id: string; firstName: string; lastName: string; status: string; score: number }>>(Prisma.sql`
          SELECT id, "firstName", "lastName", status,
            GREATEST(
              word_similarity(${query}, "firstName"),
              word_similarity(${query}, "lastName"),
              word_similarity(${query}, "idDocumentNumber"),
              word_similarity(${query}, "phoneNumber"),
              COALESCE(word_similarity(${query}, "needsAssessment"), 0)
            ) AS score
          FROM "Beneficiary"
          WHERE GREATEST(
            word_similarity(${query}, "firstName"),
            word_similarity(${query}, "lastName"),
            word_similarity(${query}, "idDocumentNumber"),
            word_similarity(${query}, "phoneNumber"),
            COALESCE(word_similarity(${query}, "needsAssessment"), 0)
          ) > 0.2
          ORDER BY score DESC, id DESC
          LIMIT ${normalizedLimit * 3}
        `),
      ]);

      // Normalize scores per entity type to [0,1] range
      const normalizeScores = (rows: Array<{ score: number; id: string }>) => {
        const maxScore = Math.max(...rows.map(r => r.score), 1);
        return rows.map(r => ({ ...r, normalizedScore: r.score / maxScore }));
      };

      const normalizedCampaigns = normalizeScores(campaignRows);
      const normalizedDonations = normalizeScores(donationRows);
      const normalizedBeneficiaries = normalizeScores(beneficiaryRows);

      // Combine all candidates with entity type
      const allCandidates = [
        ...normalizedCampaigns.map(c => ({ ...c, entityType: 'campaign' as const })),
        ...normalizedDonations.map(d => ({ ...d, entityType: 'donation' as const })),
        ...normalizedBeneficiaries.map(b => ({ ...b, entityType: 'beneficiary' as const })),
      ] as Array<{
        id: string;
        normalizedScore: number;
        score: number;
        entityType: 'campaign' | 'donation' | 'beneficiary';
        title?: string;
        amount?: number;
        firstName?: string;
        lastName?: string;
        status: string;
      }>;

      // Sort by normalized score descending, then by id descending for stability
      allCandidates.sort((a, b) => {
        if (b.normalizedScore !== a.normalizedScore) {
          return b.normalizedScore - a.normalizedScore;
        }
        return b.id.localeCompare(a.id);
      });

      // De-duplicate by (entityType, id)
      const seen = new Set<string>();
      const deduplicated = allCandidates.filter(item => {
        const key = `${item.entityType}:${item.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Apply cursor-based pagination
      let startIndex = 0;
      const decodedCursor = safeDecodeCursor(cursor);
      if (decodedCursor) {
        const { score: lastScore, id: lastId } = decodedCursor;
        startIndex = deduplicated.findIndex(item =>
          item.normalizedScore < lastScore ||
          (item.normalizedScore === lastScore && item.id.localeCompare(lastId) < 0)
        ) + 1;
      }

      const endIndex = startIndex + normalizedLimit;
      const paginatedResults = deduplicated.slice(startIndex, endIndex);

      // Generate next cursor
      let nextCursor: string | undefined;
      if (paginatedResults.length === normalizedLimit && endIndex < deduplicated.length) {
        const lastResult = paginatedResults[paginatedResults.length - 1];
        nextCursor = encodeCursor(lastResult.normalizedScore, lastResult.id);
      }

      // Format results
      const data = paginatedResults.map(item => {
        const { normalizedScore, ...rest } = item;
        return { ...rest, relevanceScore: normalizedScore };
      });

      return {
        data,
        pagination: {
          page: normalizedPage,
          limit: normalizedLimit,
          total: deduplicated.length,
          totalPages: Math.ceil(deduplicated.length / normalizedLimit),
          nextCursor,
        },
      };
    });
  }

  static async advancedSearch(filters: SearchFilters) {
    const { entityType } = filters;

    switch (entityType) {
      case 'campaign':
        return this.searchCampaigns(filters);
      case 'donation':
        return this.searchDonations(filters);
      case 'beneficiary':
        return this.searchBeneficiaries({
          query: filters.query,
          country: filters.country,
          verificationStatus: filters.status,
          sortBy: filters.sortBy as BeneficiarySortField,
          sortOrder: filters.sortOrder,
          page: filters.page,
          limit: filters.limit,
        });
      case 'global':
        return this.globalSearch(filters);
      default:
        return this.globalSearch(filters);
    }
  }
}
