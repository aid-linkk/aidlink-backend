import { PrismaClient, PledgeType, PledgeCadence, PledgeStatus, PledgeAttemptStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import logger from '../config/logger';

export interface CreatePledgeInput {
  donorId: string;
  campaignId?: string;
  amount: number;
  currency?: string;
  type: PledgeType;
  cadence?: PledgeCadence;
  startDate: Date;
  endDate?: Date;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface ListPledgesInput {
  donorId?: string;
  status?: PledgeStatus;
  page?: number;
  limit?: number;
}

/**
 * @notice Calculates the next run date based on cadence
 */
function calculateNextRunAt(current: Date, cadence: PledgeCadence): Date {
  const next = new Date(current);
  if (cadence === PledgeCadence.WEEKLY) {
    next.setDate(next.getDate() + 7);
  } else if (cadence === PledgeCadence.MONTHLY) {
    next.setMonth(next.getMonth() + 1);
  }
  return next;
}

export class PledgeService {
  constructor(private prisma: PrismaClient) {}

  /**
   * @notice Create a new pledge with idempotency support
   */
  async createPledge(input: CreatePledgeInput) {
    // Check idempotency
    if (input.idempotencyKey) {
      const existing = await this.prisma.pledge.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        logger.info('Pledge already exists for idempotency key', {
          idempotencyKey: input.idempotencyKey,
        });
        return existing;
      }
    }

    if (input.type === PledgeType.RECURRING && !input.cadence) {
      throw new Error('cadence is required for RECURRING pledges');
    }

    const nextRunAt = input.type === PledgeType.RECURRING
      ? calculateNextRunAt(input.startDate, input.cadence!)
      : input.startDate;

    const pledge = await this.prisma.pledge.create({
      data: {
        donorId: input.donorId,
        campaignId: input.campaignId,
        amount: new Decimal(input.amount),
        currency: input.currency ?? 'USD',
        type: input.type,
        cadence: input.cadence,
        startDate: input.startDate,
        nextRunAt,
        endDate: input.endDate,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata,
      },
    });

    logger.info('Pledge created', { pledgeId: pledge.id, type: pledge.type });
    return pledge;
  }

  /**
   * @notice Get pledge by ID with recent attempts
   */
  async getPledgeById(pledgeId: string) {
    return this.prisma.pledge.findUnique({
      where: { id: pledgeId },
      include: {
        attempts: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
  }

  /**
   * @notice List pledges with pagination and filters
   */
  async listPledges(input: ListPledgesInput) {
    const page = input.page ?? 1;
    const limit = input.limit ?? 20;
    const offset = (page - 1) * limit;

    const where = {
      ...(input.donorId && { donorId: input.donorId }),
      ...(input.status && { status: input.status }),
    };

    const [pledges, total] = await Promise.all([
      this.prisma.pledge.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.pledge.count({ where }),
    ]);

    return {
      data: pledges,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * @notice Cancel a pledge
   */
  async cancelPledge(pledgeId: string, reason?: string) {
    const pledge = await this.prisma.pledge.findUnique({ where: { id: pledgeId } });

    if (!pledge) throw new Error('Pledge not found');
    if (pledge.status === PledgeStatus.CANCELLED) {
      throw new Error('Pledge is already cancelled');
    }

    const updated = await this.prisma.pledge.update({
      where: { id: pledgeId },
      data: {
        status: PledgeStatus.CANCELLED,
        metadata: {
          ...(pledge.metadata as Record<string, unknown> ?? {}),
          cancelReason: reason,
          cancelledAt: new Date().toISOString(),
        },
      },
    });

    logger.info('Pledge cancelled', { pledgeId, reason });
    return updated;
  }

  /**
   * @notice Record a pledge attempt
   */
  async recordAttempt(
    pledgeId: string,
    status: PledgeAttemptStatus,
    options?: {
      providerReference?: string;
      failureReason?: string;
      retryCount?: number;
      metadata?: Record<string, unknown>;
    },
  ) {
    return this.prisma.pledgeAttempt.create({
      data: {
        pledgeId,
        status,
        providerReference: options?.providerReference,
        failureReason: options?.failureReason,
        retryCount: options?.retryCount ?? 0,
        metadata: options?.metadata,
      },
    });
  }

  /**
   * @notice Get pledges due for processing
   */
  async getDuePledges() {
    return this.prisma.pledge.findMany({
      where: {
        status: PledgeStatus.ACTIVE,
        nextRunAt: { lte: new Date() },
      },
    });
  }

  /**
   * @notice Update pledge after successful attempt
   */
  async markAttemptSuccess(pledgeId: string) {
    const pledge = await this.prisma.pledge.findUnique({ where: { id: pledgeId } });
    if (!pledge) throw new Error('Pledge not found');

    if (pledge.type === PledgeType.ONE_OFF) {
      return this.prisma.pledge.update({
        where: { id: pledgeId },
        data: { status: PledgeStatus.COMPLETED, nextRunAt: null },
      });
    }

    // Recurring — calculate next run
    const nextRunAt = calculateNextRunAt(
      pledge.nextRunAt ?? new Date(),
      pledge.cadence!,
    );

    // Check if past end date
    if (pledge.endDate && nextRunAt > pledge.endDate) {
      return this.prisma.pledge.update({
        where: { id: pledgeId },
        data: { status: PledgeStatus.COMPLETED, nextRunAt: null },
      });
    }

    return this.prisma.pledge.update({
      where: { id: pledgeId },
      data: { nextRunAt },
    });
  }

  /**
   * @notice Pause a pledge
   */
  async pausePledge(pledgeId: string) {
    return this.prisma.pledge.update({
      where: { id: pledgeId },
      data: { status: PledgeStatus.PAUSED },
    });
  }

  /**
   * @notice Resume a paused pledge
   */
  async resumePledge(pledgeId: string) {
    return this.prisma.pledge.update({
      where: { id: pledgeId },
      data: { status: PledgeStatus.ACTIVE },
    });
  }

  /**
   * @notice List attempts for a pledge (admin)
   */
  async listAttempts(pledgeId: string) {
    return this.prisma.pledgeAttempt.findMany({
      where: { pledgeId },
      orderBy: { createdAt: 'desc' },
    });
  }
}