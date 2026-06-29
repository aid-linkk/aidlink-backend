import prisma from '../config/database';
import { AppError } from '../middleware/error';
import { Role } from '@prisma/client';
import { MultiplierType } from '@prisma/client';
import type { Multiplier } from '@prisma/client';



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
      if (!campaign) throw new AppError('Campaign not found', 404);

      if (campaign.userId !== actorId) throw new AppError('You do not have permission to manage multipliers', 403);
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
      throw new AppError('multiplier must be a valid number', 400);
    }
    if (multiplier <= 1.0) {
      throw new AppError('multiplier must be > 1.0', 400);
    }

    if (matchCap !== null && matchCap !== undefined) {
      if (typeof matchCap !== 'number' || !Number.isFinite(matchCap) || matchCap < 0) {
        throw new AppError('matchCap must be >= 0', 400);
      }
    }

    if (perDonationCap !== null && perDonationCap !== undefined) {
      if (typeof perDonationCap !== 'number' || !Number.isFinite(perDonationCap) || perDonationCap < 0) {
        throw new AppError('perDonationCap must be >= 0', 400);
      }
    }

    const start = startAt ? new Date(startAt) : null;
    const end = endAt ? new Date(endAt) : null;

    if (startAt && (!start || isNaN(start.getTime()))) throw new AppError('startAt must be a valid date', 400);
    if (endAt && (!end || isNaN(end.getTime()))) throw new AppError('endAt must be a valid date', 400);

    if (start && end && end <= start) {
      throw new AppError('startAt must be before endAt', 400);
    }

    if (type === MultiplierType.MILESTONE) {
      if (!milestoneId) throw new AppError('milestoneId is required for MILESTONE multipliers', 400);
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
        throw new AppError('Milestone not found for this campaign', 404);
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
    if (!existing || existing.campaignId !== campaignId) throw new AppError('Multiplier not found', 404);

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
        throw new AppError('Milestone not found for this campaign', 404);
      }
    }

    // Prevent reducing matchCap below already-matched amount
    if (patch.matchCap !== undefined && patch.matchCap !== null) {
      const used = await prisma.matchedFund.aggregate({
        where: { campaignId, multiplierId },
        _sum: { matchedAmount: true },
      });
      const usedMatched = Number(used._sum.matchedAmount ?? 0);
      if (Number(patch.matchCap) < usedMatched) {
        throw new AppError('matchCap cannot be reduced below already-matched amount', 400);
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
    if (!existing || existing.campaignId !== campaignId) throw new AppError('Multiplier not found', 404);

    const updated = await prisma.multiplier.update({
      where: { id: multiplierId },
      data: { active: false, endAt: existing.endAt ?? new Date() },
    });

    return updated;
  }

  static async getApplicableMultipliersAtTime(params: {
    campaignId: string;
    donationTime: Date;
    milestoneId?: string | null;
  }): Promise<Multiplier[]> {
    const { campaignId, donationTime, milestoneId = null } = params;

    // Note: we fetch active multipliers in window. For MILESTONE, we match milestoneId.
    return prisma.multiplier.findMany({
      where: {
        campaignId,
        active: true,
        startAt: { lte: donationTime },
        endAt: { gte: donationTime },
      },
    }).catch(() => [] as Multiplier[]);
  }

  static async evaluateMultiplierAtDonation(params: {
    campaignId: string;
    donationTime: Date;
    // milestone scoping is optional until milestone logic exists in this app.
    milestoneId?: string | null;
  }): Promise<Multiplier | null> {

    const { campaignId, donationTime, milestoneId = null } = params;

    // The window logic is currently complicated by null start/end.
    // We do explicit filtering in JS for correctness.
    const candidates = (await prisma.multiplier.findMany({
      where: { campaignId, active: true },
      orderBy: { createdAt: 'asc' },
    })) ?? [];

    const applicable = candidates.filter((m) => {
      if (m.startAt && donationTime < m.startAt) return false;
      if (m.endAt && donationTime > m.endAt) return false;
      if (m.type === MultiplierType.MILESTONE) {
        if (!milestoneId) return false;
        if (!m.milestoneId || m.milestoneId !== milestoneId) return false;
      }
      return true;
    });

    if (applicable.length === 0) return null;

    const precedence = (t: MultiplierType) => {
      switch (t) {
        case MultiplierType.MILESTONE:
          return 3;
        case MultiplierType.CORPORATE:
          return 2;
        case MultiplierType.CAMPAIGN_WIDE:
          return 1;
      }
    };

    const maxPrec = Math.max(...applicable.map((m: Multiplier) => precedence(m.type)));
    const samePrec = applicable.filter((m: Multiplier) => precedence(m.type) === maxPrec);

    samePrec.sort((a: Multiplier, b: Multiplier) => {
      const am = Number(a.multiplier);
      const bm = Number(b.multiplier);
      if (bm !== am) return bm - am; // highest multiplier wins
      return a.createdAt.getTime() - b.createdAt.getTime();
    });


    return samePrec[0] ?? null;
  }
}

