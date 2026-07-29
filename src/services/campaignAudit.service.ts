/**
 * CampaignAuditService
 *
 * Centralised writer and reader for campaign-scoped audit log entries.
 * All mutations in CampaignService, DistributionService, and ModerationService
 * call the static `log` method below to record who did what, when, and what
 * changed (old vs. new values).
 *
 * The underlying storage is the existing AuditLog table, with:
 *   entityType = 'Campaign'       for campaign-level events
 *   entityType = 'Milestone'      for milestone additions
 *   entityType = 'Distribution'   for distribution events
 *   entityType = 'BeneficiaryAssignment' for beneficiary assignment events
 *
 * All entries carry a `campaignId` in their `metadata` JSON so that a single
 * campaign-scoped query can surface the full history across entity types.
 */

import prisma from '../config/database';
import { AuditAction, Prisma, Role } from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';

// ── Types ──────────────────────────────────────────────────────────────

export interface AuditLogEntry {
    id: string;
    action: AuditAction;
    entityType: string;
    entityId: string | null;
    actor: {
        id: string | null;
        email?: string | null;
        username?: string | null;
        role?: string | null;
    } | null;
    changes: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
    ipAddress: string | null;
    createdAt: Date;
}

export interface CampaignAuditFilters {
    action?: AuditAction;
    entityType?: string;
    actorId?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
}

export interface ChangeSet {
    /** Field-level diff: key → { old, new } */
    diff?: Record<string, { old: unknown; new: unknown }>;
    /** Snapshot of the full old value (optional) */
    before?: Record<string, unknown>;
    /** Snapshot of the full new value (optional) */
    after?: Record<string, unknown>;
    /** Any extra context the caller wants to store */
    [key: string]: unknown;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Compute a field-level diff between two plain objects.
 * Only includes keys whose values actually changed.
 */
export function diffObjects(
    before: Record<string, unknown>,
    after: Record<string, unknown>
): Record<string, { old: unknown; new: unknown }> {
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const diff: Record<string, { old: unknown; new: unknown }> = {};

    for (const key of allKeys) {
        const oldVal = before[key];
        const newVal = after[key];

        // Primitive equality; deep objects are compared via JSON
        const oldStr = typeof oldVal === 'object' ? JSON.stringify(oldVal) : String(oldVal ?? '');
        const newStr = typeof newVal === 'object' ? JSON.stringify(newVal) : String(newVal ?? '');

        if (oldStr !== newStr) {
            diff[key] = { old: oldVal ?? null, new: newVal ?? null };
        }
    }

    return diff;
}

// ── Service ────────────────────────────────────────────────────────────

export class CampaignAuditService {
    /**
     * Write a single audit log entry.
     * Fire-and-forget from callers that cannot afford to fail on audit errors —
     * pass `swallowErrors = true` (default) to suppress exceptions.
     */
    static async log(opts: {
        campaignId: string;
        action: AuditAction;
        entityType: string;
        entityId: string;
        actorId: string;
        changes?: ChangeSet;
        ipAddress?: string;
        userAgent?: string;
        swallowErrors?: boolean;
    }): Promise<void> {
        const { swallowErrors = true } = opts;

        try {
            await prisma.auditLog.create({
                data: {
                    userId: opts.actorId,
                    action: opts.action,
                    entityType: opts.entityType,
                    entityId: opts.entityId,
                    changes: (opts.changes ?? null) as Prisma.InputJsonValue,
                    ipAddress: opts.ipAddress ?? null,
                    userAgent: opts.userAgent ?? null,
                    metadata: { campaignId: opts.campaignId } as Prisma.InputJsonValue,
                },
            });
        } catch (err) {
            logger.error(`CampaignAuditService.log failed [${opts.action}/${opts.entityId}]:`, err);
            if (!swallowErrors) throw err;
        }
    }

    /**
     * Query the audit history for a single campaign.
     * Returns all entries whose `metadata.campaignId` matches, across all
     * entity types (Campaign, Milestone, Distribution, BeneficiaryAssignment).
     *
     * Access control: caller must be the campaign owner or hold ADMIN/AUDITOR role.
     */
    static async getCampaignAuditLog(
        campaignId: string,
        requesterId: string,
        requesterRole: Role,
        filters: CampaignAuditFilters = {}
    ): Promise<{ data: AuditLogEntry[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
        // Verify campaign exists
        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId },
            select: { id: true, userId: true },
        });

        if (!campaign) throw AppError.from('CAMPAIGN_002');

        // Access control
        const allowedRoles: Role[] = [Role.ADMIN, Role.AUDITOR];
        if (!allowedRoles.includes(requesterRole) && campaign.userId !== requesterId) {
            throw AppError.from('COMMON_001', 'Only the campaign owner, admins, or auditors can view this audit log');
        }

        const page = filters.page ?? 1;
        const limit = Math.min(filters.limit ?? 25, 100);
        const skip = (page - 1) * limit;

        // Build filter predicate
        const where: Prisma.AuditLogWhereInput = {
            metadata: {
                path: ['campaignId'],
                equals: campaignId,
            },
            ...(filters.action && { action: filters.action }),
            ...(filters.entityType && { entityType: filters.entityType }),
            ...(filters.actorId && { userId: filters.actorId }),
            ...((filters.startDate || filters.endDate) && {
                createdAt: {
                    ...(filters.startDate && { gte: filters.startDate }),
                    ...(filters.endDate && { lte: filters.endDate }),
                },
            }),
        };

        const [raw, total] = await Promise.all([
            prisma.auditLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
                include: {
                    user: {
                        select: { id: true, email: true, username: true, role: true },
                    },
                },
            }),
            prisma.auditLog.count({ where }),
        ]);

        const data: AuditLogEntry[] = raw.map((entry) => ({
            id: entry.id,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            actor: entry.user
                ? {
                    id: entry.user.id,
                    email: entry.user.email,
                    username: entry.user.username,
                    role: entry.user.role,
                }
                : null,
            changes: entry.changes as Record<string, unknown> | null,
            metadata: entry.metadata as Record<string, unknown> | null,
            ipAddress: entry.ipAddress,
            createdAt: entry.createdAt,
        }));

        return {
            data,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    /**
     * Get a single audit log entry by ID — for deep-linking from the UI.
     */
    static async getAuditEntry(
        entryId: string,
        requesterId: string,
        requesterRole: Role
    ): Promise<AuditLogEntry> {
        const entry = await prisma.auditLog.findUnique({
            where: { id: entryId },
            include: {
                user: { select: { id: true, email: true, username: true, role: true } },
            },
        });

        if (!entry) throw new AppError('Audit log entry not found', 404);

        // Verify requester can see this entry's campaign
        const meta = (entry.metadata ?? {}) as Record<string, unknown>;
        if (meta.campaignId) {
            const campaign = await prisma.campaign.findUnique({
                where: { id: meta.campaignId as string },
                select: { userId: true },
            });

            const allowedRoles: Role[] = [Role.ADMIN, Role.AUDITOR];
            if (campaign && !allowedRoles.includes(requesterRole) && campaign.userId !== requesterId) {
                throw AppError.from('COMMON_001', 'Access denied');
            }
        }

        return {
            id: entry.id,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            actor: entry.user
                ? { id: entry.user.id, email: entry.user.email, username: entry.user.username, role: entry.user.role }
                : null,
            changes: entry.changes as Record<string, unknown> | null,
            metadata: entry.metadata as Record<string, unknown> | null,
            ipAddress: entry.ipAddress,
            createdAt: entry.createdAt,
        };
    }
}
