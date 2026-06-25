import prisma from '../config/database';
import logger from '../config/logger';
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

  static async searchBeneficiaries(filters: SearchFilters) {
    const {
      query,
      dateFrom,
      dateTo,
      status,
      country,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page = 1,
      limit = 20,
    } = filters;

    const skip = (page - 1) * limit;

    const where: any = {};

    if (query) {
      where.OR = [
        { firstName: { contains: query, mode: 'insensitive' } },
        { lastName: { contains: query, mode: 'insensitive' } },
        { idDocumentNumber: { contains: query, mode: 'insensitive' } },
        { phoneNumber: { contains: query, mode: 'insensitive' } },
      ];
    }

    if (status) {
      where.status = status;
    }

    if (country) {
      where.country = country;
    }

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = dateFrom;
      if (dateTo) where.createdAt.lte = dateTo;
    }

    const [beneficiaries, total] = await Promise.all([
      prisma.beneficiary.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
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
    ]);

    return {
      data: beneficiaries,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async globalSearch(filters: SearchFilters) {
    const { query, page = 1, limit = 10 } = filters;

    if (!query) {
      throw new Error('Query is required for global search');
    }

    const skip = (page - 1) * limit;

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
        return this.searchBeneficiaries(filters);
      case 'global':
        return this.globalSearch(filters);
      default:
        return this.globalSearch(filters);
    }
  }
}
