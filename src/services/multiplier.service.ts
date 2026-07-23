import prisma from '../config/database';
import { AppError } from '../middleware/error';
import { Role, MultiplierType, Prisma } from '@prisma/client';
import type { Multiplier } from '@prisma/client';

type ReadClient = Prisma.TransactionClient | typeof prisma;

const MULTIPLIER_PRECEDENCE: Record<MultiplierType, number> = {
  [MultiplierType.MILESTONE]: 3,
  [MultiplierType.CORPORATE]: 2,
  [MultiplierType.CAMPAIGN_WIDE]: 1,
};

export type MultiplierCreateInput = {
  campaignId: string;
  type: MultiplierType;
  multiplier: number;
  createdBy: string;
  matchCap?: number | null;
  perDonationCap?: number | null;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
  milestoneId?: string | null;
  metadata?: any;
  active?: boolean;
};

export type MultiplierUpdateInput = {
  active?: boolean;
  multiplier?: number;
  matchCap?: number | null;
  perDonationCap?: number | null;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
  milestoneId?: string | null;
  metadata?: any;
};

export class MultiplierService {
  static assertCanManage(campaignId: string, actorId: string, actorRole: Role): Promise<void> {
    return (async () => {
      if (actorRole === Role.ADMIN) return;

      const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { userId: true } });
      if (!campaign) throw AppError.from('CAMPAIGN_002');

      if (campaign.userId !== actorId) throw AppError.from('COMMON_001', 'You do not have permission to manage multipliers');
    })();
  }

  static validateMultiplierInput(data: {
    type: MultiplierType;
    multiplier: number;
    matchCap?: number | null;
    perDonationCap?: number | null;
    startAt?: string | Date | null;
    endAt?: string | Date | null;
    milestoneId?: string | null;
  }): {
    multiplier: number;
    matchCap?: number | null;
    perDonationCap?: number | null;
    startAt?: Date | null;
    endAt?: Date | null;
    milestoneId?: string | null;
  } {
    const {
      type,
      multiplier,
      matchCap = null,
      perDonationCap = null,
      startAt = null,
      endAt = null,
      milestoneId = null,
    } = data;

    if (typeof multiplier !== 'number' || !Number.isFinite(multiplier)) {
      throw AppError.from('MULTIPLIER_002', 'multiplier must be a valid number');
    }
    if (multiplier <= 1.0) {
      throw AppError.from('MULTIPLIER_002', 'multiplier must be > 1.0');
    }

    if (matchCap !== null && matchCap !== undefined) {
      if (typeof matchCap !== 'number' || !Number.isFinite(matchCap) || matchCap < 0) {
        throw AppError.from('MULTIPLIER_002', 'matchCap must be >= 0');
      }
    }

    if (perDonationCap !== null && perDonationCap !== undefined) {
      if (typeof perDonationCap !== 'number' || !Number.isFinite(perDonationCap) || perDonationCap < 0) {
        throw AppError.from('MULTIPLIER_002', 'perDonationCap must be >= 0');
      }
    }

    const start = startAt ? new Date(startAt) : null;
    const end = endAt ? new Date(endAt) : null;

    if (startAt && (!start || isNaN(start.getTime()))) throw AppError.from('MULTIPLIER_002', 'startAt must be a valid date');
    if (endAt && (!end || isNaN(end.getTime()))) throw AppError.from('MULTIPLIER_002', 'endAt must be a valid date');

    if (start && end && end <= start) {
      throw AppError.from('MULTIPLIER_002', 'startAt must be before endAt');
    }

    if (type === MultiplierType.MILESTONE) {
      if (!milestoneId) throw AppError.from('MULTIPLIER_002', 'milestoneId is required for MILESTONE multipliers');
    }

    return {
      multiplier,
      matchCap: matchCap ?? null,
      perDonationCap: perDonationCap ?? null,
      startAt: start,
      endAt: end,
      milestoneId: milestoneId ?? null,
    };
  }

  static async createMultiplier(actorId: string, actorRole: Role, input: Omit<MultiplierCreateInput, 'createdBy' | 'campaignId'> & { campaignId: string }): Promise<Multiplier> {
    await MultiplierService.assertCanManage(input.campaignId, actorId, actorRole);

    // Validate
    const validated = MultiplierService.validateMultiplierInput({
      type: input.type,
      multiplier: input.multiplier,
      matchCap: input.matchCap,
      perDonationCap: input.perDonationCap,
      startAt: input.startAt,
      endAt: input.endAt,
      milestoneId: input.milestoneId,
    });

    if (input.type === MultiplierType.MILESTONE && validated.milestoneId) {
      const milestone = await prisma.milestone.findUnique({ where: { id: validated.milestoneId } });
      if (!milestone || milestone.campaignId !== input.campaignId) {
        throw AppError.from('MILESTONE_001', 'Milestone not found for this campaign');
      }
    }

    const created = await prisma.multiplier.create({
      data: {
        campaignId: input.campaignId,
        createdBy: actorId,
        type: input.type,
        multiplier: validated.multiplier,
        matchCap: validated.matchCap,
        perDonationCap: validated.perDonationCap,
        startAt: validated.startAt,
        endAt: validated.endAt,
        milestoneId: validated.milestoneId,
        metadata: input.metadata ?? null,
        active: input.active ?? true,
      },
    });

    return created;
  }

  static async listMultipliers(campaignId: string): Promise<Multiplier[]> {
    return prisma.multiplier.findMany({
      where: { campaignId },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async updateMultiplier(actorId: string, actorRole: Role, multiplierId: string, campaignId: string, patch: MultiplierUpdateInput): Promise<Multiplier> {
    await MultiplierService.assertCanManage(campaignId, actorId, actorRole);

    const existing = await prisma.multiplier.findUnique({ where: { id: multiplierId } });
    if (!existing || existing.campaignId !== campaignId) throw AppError.from('MULTIPLIER_001');

    const next = {
      multiplier: patch.multiplier ?? (Number(existing.multiplier) as any),
      matchCap: patch.matchCap ?? existing.matchCap,
      perDonationCap: patch.perDonationCap ?? existing.perDonationCap,
      startAt: patch.startAt ?? existing.startAt,
      endAt: patch.endAt ?? existing.endAt,
      milestoneId: patch.milestoneId ?? existing.milestoneId,
      type: existing.type,
    };

    const validated = MultiplierService.validateMultiplierInput({
      type: existing.type,
      multiplier: Number(next.multiplier),
      matchCap: next.matchCap as any,
      perDonationCap: next.perDonationCap as any,
      startAt: next.startAt as any,
      endAt: next.endAt as any,
      milestoneId: next.milestoneId as any,
    });

    if (existing.type === MultiplierType.MILESTONE && validated.milestoneId) {
      const milestone = await prisma.milestone.findUnique({ where: { id: validated.milestoneId } });
      if (!milestone || milestone.campaignId !== campaignId) {
        throw AppError.from('MILESTONE_001', 'Milestone not found for this campaign');
      }
    }

    // Prevent reducing matchCap below the amount already consumed. matchedTotal is
    // the authoritative running total (see MatchedFundAllocationService), so this
    // reads it directly instead of re-aggregating MatchedFund rows.
    if (patch.matchCap !== undefined && patch.matchCap !== null) {
      if (Number(patch.matchCap) < Number(existing.matchedTotal)) {
        throw AppError.from('MULTIPLIER_003');
      }
    }

    const updated = await prisma.multiplier.update({
      where: { id: multiplierId },
      data: {
        active: patch.active ?? existing.active,
        multiplier: validated.multiplier,
        matchCap: validated.matchCap,
        perDonationCap: validated.perDonationCap,
        startAt: validated.startAt,
        endAt: validated.endAt,
        milestoneId: validated.milestoneId,
        metadata: patch.metadata ?? existing.metadata,
      },
    });

    return updated;
  }

  static async deactivateMultiplier(actorId: string, actorRole: Role, multiplierId: string, campaignId: string): Promise<Multiplier> {
    await MultiplierService.assertCanManage(campaignId, actorId, actorRole);

    const existing = await prisma.multiplier.findUnique({ where: { id: multiplierId } });
    if (!existing || existing.campaignId !== campaignId) throw AppError.from('MULTIPLIER_001');

    const updated = await prisma.multiplier.update({
      where: { id: multiplierId },
      data: { active: false, endAt: existing.endAt ?? new Date() },
    });

    return updated;
  }

  /**
   * Picks the single winning multiplier from a candidate set for a given
   * donation time. Precedence order is MILESTONE > CORPORATE > CAMPAIGN_WIDE;
   * within the same precedence tier the highest multiplier value wins, ties
   * broken by earliest createdAt, then by id for full determinism when
   * createdAt collides. Pure function so precedence/tie-break rules can be
   * unit tested without a database.
   */
  static selectWinningMultiplier(
    candidates: Multiplier[],
    params: { donationTime: Date; milestoneId?: string | null },
  ): Multiplier | null {
    const { donationTime, milestoneId = null } = params;

    const applicable = candidates.filter((m) => {
      if (!m.active) return false;
      if (m.startAt && donationTime < m.startAt) return false;
      if (m.endAt && donationTime > m.endAt) return false;
      if (m.type === MultiplierType.MILESTONE) {
        if (!milestoneId || m.milestoneId !== milestoneId) return false;
      }
      return true;
    });

    if (applicable.length === 0) return null;

    const maxPrecedence = Math.max(...applicable.map((m) => MULTIPLIER_PRECEDENCE[m.type]));
    const topTier = applicable.filter((m) => MULTIPLIER_PRECEDENCE[m.type] === maxPrecedence);

    topTier.sort((a, b) => {
      const byMultiplier = new Prisma.Decimal(b.multiplier).comparedTo(new Prisma.Decimal(a.multiplier));
      if (byMultiplier !== 0) return byMultiplier;

      const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
      if (byCreatedAt !== 0) return byCreatedAt;

      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return topTier[0];
  }

  static async evaluateMultiplierAtDonation(
    params: {
      campaignId: string;
      donationTime: Date;
      milestoneId?: string | null;
    },
    client: ReadClient = prisma,
  ): Promise<Multiplier | null> {
    const { campaignId, donationTime, milestoneId = null } = params;

    const candidates = (await client.multiplier.findMany({
      where: { campaignId, active: true },
    })) ?? [];

    return MultiplierService.selectWinningMultiplier(candidates, { donationTime, milestoneId });
  }
}

