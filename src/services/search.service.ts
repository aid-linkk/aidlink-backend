import prisma from '../config/database';
import { getOrSet, buildKey } from '../utils/cache';

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

export class SearchService {
  static async searchCampaigns(filters: SearchFilters) {
    const {
      query,
      dateFrom,
      dateTo,
      status,
      minAmount,
      maxAmount,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page = 1,
      limit = 20,
    } = filters;

    const cacheKey = buildKey('search', `campaigns:${JSON.stringify(filters)}`);

    return getOrSet(cacheKey, 120, async () => {
      const skip = (page - 1) * limit;

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
          take: limit,
          orderBy: { [sortBy]: sortOrder },
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
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    });
  }

  static async searchDonations(filters: SearchFilters) {
    const {
      query,
      dateFrom,
      dateTo,
      status,
      minAmount,
      maxAmount,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page = 1,
      limit = 20,
    } = filters;

    const skip = (page - 1) * limit;

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
        take: limit,
        orderBy: { [sortBy]: sortOrder },
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
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
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
    sortOrder: 'asc' | 'desc'
  ): any[] {
    const tiebreaker = { id: 'asc' as const };
    switch (sortBy) {
      case 'age':
        // Older age => earlier dateOfBirth, so invert the requested order.
        return [{ dateOfBirth: sortOrder === 'desc' ? 'asc' : 'desc' }, tiebreaker];
      case 'relevance':
        // No full-text relevance scoring available; fall back to recency.
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

  static async searchBeneficiaries(filters: BeneficiarySearchFilters) {
    const {
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page = 1,
      limit = 20,
    } = filters;

    const now = new Date();
    const skip = (page - 1) * limit;
    const where = this.buildBeneficiaryWhere(filters, now);
    const orderBy = this.buildBeneficiaryOrderBy(sortBy, sortOrder);
    const facetQueries = this.beneficiaryFacetQueries(filters, now);

    const [beneficiaries, total, ...facetResults] = await prisma.$transaction([
      prisma.beneficiary.findMany({
        where,
        skip,
        take: limit,
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
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      facets: this.assembleBeneficiaryFacets(facetResults),
    };
  }

  static async globalSearch(filters: SearchFilters) {
    const { query, page = 1, limit = 10 } = filters;

    if (!query) {
      throw new Error('Query is required for global search');
    }

    // Search across multiple entities
    const [campaigns, donations, beneficiaries] = await Promise.all([
      prisma.campaign.findMany({
        where: {
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { description: { contains: query, mode: 'insensitive' } },
          ],
        },
        take: limit,
        select: {
          id: true,
          title: true,
          status: true,
        },
      }),
      prisma.donation.findMany({
        where: {
          OR: [
            { memo: { contains: query, mode: 'insensitive' } },
            { donorMessage: { contains: query, mode: 'insensitive' } },
          ],
        },
        take: limit,
        select: {
          id: true,
          amount: true,
          status: true,
        },
      }),
      prisma.beneficiary.findMany({
        where: {
          OR: [
            { firstName: { contains: query, mode: 'insensitive' } },
            { lastName: { contains: query, mode: 'insensitive' } },
          ],
        },
        take: limit,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          status: true,
        },
      }),
    ]);

    const results = [
      ...campaigns.map(c => ({ ...c, entityType: 'campaign' })),
      ...donations.map(d => ({ ...d, entityType: 'donation' })),
      ...beneficiaries.map(b => ({ ...b, entityType: 'beneficiary' })),
    ];

    return {
      data: results,
      pagination: {
        page,
        limit,
        total: results.length,
        totalPages: Math.ceil(results.length / limit),
      },
    };
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
