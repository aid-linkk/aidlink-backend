import prisma from '../config/database';

export interface TransactionFilters {
  status?: string;
  contractAddress?: string;
  txHash?: string;
  fromAddress?: string;
  toAddress?: string;
  type?: string;
  blockNumber?: bigint;
  createdAtFrom?: Date;
  createdAtTo?: Date;
  sortBy?: 'createdAt' | 'blockNumber' | 'status';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface EventFilters {
  contractAddress?: string;
  eventName?: string;
  processed?: boolean;
  txHash?: string;
  createdAtFrom?: Date;
  createdAtTo?: Date;
  processedAtFrom?: Date;
  processedAtTo?: Date;
  sortBy?: 'createdAt' | 'processedAt';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export class BlockchainService {
  static async getTransactions(filters: TransactionFilters) {
    const {
      status,
      contractAddress,
      txHash,
      fromAddress,
      toAddress,
      type,
      blockNumber,
      createdAtFrom,
      createdAtTo,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page = 1,
      limit = 20,
    } = filters;

    const skip = (page - 1) * limit;
    const where: any = {};

    if (status) where.status = status;
    if (contractAddress) where.contractAddress = { contains: contractAddress, mode: 'insensitive' };
    if (txHash) where.txHash = { contains: txHash, mode: 'insensitive' };
    if (fromAddress) where.fromAddress = { contains: fromAddress, mode: 'insensitive' };
    if (toAddress) where.toAddress = { contains: toAddress, mode: 'insensitive' };
    if (type) where.type = type;
    if (blockNumber !== undefined) where.blockNumber = blockNumber;

    if (createdAtFrom || createdAtTo) {
      where.createdAt = {};
      if (createdAtFrom) where.createdAt.gte = createdAtFrom;
      if (createdAtTo) where.createdAt.lte = createdAtTo;
    }

    const [data, total] = await Promise.all([
      prisma.blockchainTransaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
      }),
      prisma.blockchainTransaction.count({ where }),
    ]);

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  static async getTransactionById(id: string) {
    return prisma.blockchainTransaction.findUnique({ where: { id } });
  }

  static async getEvents(filters: EventFilters) {
    const {
      contractAddress,
      eventName,
      processed,
      txHash,
      createdAtFrom,
      createdAtTo,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page = 1,
      limit = 20,
    } = filters;

    const skip = (page - 1) * limit;
    const where: any = {};

    if (contractAddress) where.contractAddress = { contains: contractAddress, mode: 'insensitive' };
    if (eventName) where.eventName = { contains: eventName, mode: 'insensitive' };
    if (processed !== undefined) where.processed = processed;
    if (txHash) where.txHash = { contains: txHash, mode: 'insensitive' };

    if (createdAtFrom || createdAtTo) {
      where.createdAt = {};
      if (createdAtFrom) where.createdAt.gte = createdAtFrom;
      if (createdAtTo) where.createdAt.lte = createdAtTo;
    }

    const orderBy = sortBy === 'processedAt' ? { timestamp: sortOrder } : { [sortBy]: sortOrder };

    const [data, total] = await Promise.all([
      prisma.contractEvent.findMany({
        where,
        skip,
        take: limit,
        orderBy,
      }),
      prisma.contractEvent.count({ where }),
    ]);

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  static async getEventById(id: string) {
    return prisma.contractEvent.findUnique({ where: { id } });
  }
}
