/**
 * AdminNotificationPreferenceService
 *
 * Manages per-admin granular notification controls:
 *   - Type preferences (ALL | ALERTS_ONLY | NONE) per NotificationType
 *   - Channels (EMAIL, IN_APP, SMS)
 *   - Frequency (IMMEDIATE | DAILY_DIGEST | WEEKLY)
 *   - Entity filters (campaign whitelist, user-role whitelist)
 *   - Global mute (except SECURITY_ALERT)
 *   - Quiet hours (UTC HH:MM window)
 *
 * The gate method `shouldDeliver` is called from NotificationService before
 * creating or dispatching any notification to an ADMIN-role user.
 */

import prisma from '../config/database';
import {
    NotificationType,
    NotificationChannel,
    NotificationFrequency,
    AdminNotificationTypePreference,
    Prisma,
} from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';

// ── Types ──────────────────────────────────────────────────────────────

export type TypePreferenceMap = Partial<
    Record<NotificationType, AdminNotificationTypePreference>
>;

export interface AdminNotificationPreferenceInput {
    typePreferences?: TypePreferenceMap;
    channels?: NotificationChannel[];
    frequency?: NotificationFrequency;
    campaignFilter?: string[];
    userRoleFilter?: string[];
    muteAll?: boolean;
    quietHoursStart?: string | null;
    quietHoursEnd?: string | null;
}

export interface DeliveryDecision {
    /** Whether to deliver the notification at all */
    deliver: boolean;
    /** Channels to use (subset of the admin's configured channels) */
    channels: NotificationChannel[];
    /** Whether to queue for digest instead of sending now */
    queued: boolean;
    reason?: string;
}

// Notification types that classify as "alerts" (never suppressed by ALERTS_ONLY mode)
const ALERT_TYPES: NotificationType[] = [
    'SECURITY_ALERT',
    'SYSTEM_ALERT',
    'CAMPAIGN_SUSPENDED',
    'FRAUD_REPORTED' as NotificationType,
    'KYC_REJECTED',
];

// Notification types that are ALWAYS delivered regardless of any preference
const MANDATORY_TYPES: NotificationType[] = ['SECURITY_ALERT'];

// ── Helpers ────────────────────────────────────────────────────────────

function parseTypePreferences(json: unknown): TypePreferenceMap {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
    return json as TypePreferenceMap;
}

/** Returns true when the current UTC time falls inside a quiet-hours window. */
function isInQuietHours(start: string | null, end: string | null): boolean {
    if (!start || !end) return false;

    const now = new Date();
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
    const startMins = sh * 60 + sm;
    const endMins = eh * 60 + em;

    // Handle overnight window (e.g. 22:00–07:00)
    if (startMins > endMins) {
        return nowMins >= startMins || nowMins < endMins;
    }
    return nowMins >= startMins && nowMins < endMins;
}

/** Compute the next digest send time from now for a given frequency. */
function nextDigestTime(frequency: NotificationFrequency): Date {
    const now = new Date();
    if (frequency === NotificationFrequency.DAILY_DIGEST) {
        // Next 08:00 UTC
        const next = new Date(now);
        next.setUTCHours(8, 0, 0, 0);
        if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
        return next;
    }
    // WEEKLY — next Monday 08:00 UTC
    const next = new Date(now);
    const daysUntilMonday = (8 - next.getUTCDay()) % 7 || 7;
    next.setUTCDate(next.getUTCDate() + daysUntilMonday);
    next.setUTCHours(8, 0, 0, 0);
    return next;
}

// ── Service ────────────────────────────────────────────────────────────

export class AdminNotificationPreferenceService {

    /** Fetch preferences, creating defaults if none exist. */
    static async getPreferences(userId: string) {
        const existing = await prisma.adminNotificationPreference.findUnique({
            where: { userId },
        });
        if (!existing) {
            return this.createDefaults(userId);
        }
        return {
            ...existing,
            typePreferences: parseTypePreferences(existing.typePreferences),
        };
    }

    /** Create or fully replace preferences for an admin. */
    static async upsertPreferences(
        userId: string,
        input: AdminNotificationPreferenceInput
    ) {
        // Validate quiet hours format if provided
        const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
        if (input.quietHoursStart && !timeRe.test(input.quietHoursStart)) {
            throw new AppError('quietHoursStart must be in HH:MM (24h UTC) format', 400);
        }
        if (input.quietHoursEnd && !timeRe.test(input.quietHoursEnd)) {
            throw new AppError('quietHoursEnd must be in HH:MM (24h UTC) format', 400);
        }

        const existing = await prisma.adminNotificationPreference.findUnique({
            where: { userId },
        });
        const existingTypes = existing
            ? parseTypePreferences(existing.typePreferences)
            : {};

        const mergedTypes: TypePreferenceMap = {
            ...existingTypes,
            ...(input.typePreferences ?? {}),
        };

        const data = {
            typePreferences: mergedTypes as unknown as Prisma.InputJsonValue,
            ...(input.channels !== undefined && { channels: input.channels }),
            ...(input.frequency !== undefined && { frequency: input.frequency }),
            ...(input.campaignFilter !== undefined && { campaignFilter: input.campaignFilter }),
            ...(input.userRoleFilter !== undefined && { userRoleFilter: input.userRoleFilter }),
            ...(input.muteAll !== undefined && { muteAll: input.muteAll }),
            ...('quietHoursStart' in input && { quietHoursStart: input.quietHoursStart ?? null }),
            ...('quietHoursEnd' in input && { quietHoursEnd: input.quietHoursEnd ?? null }),
        };

        const pref = await prisma.adminNotificationPreference.upsert({
            where: { userId },
            create: { userId, ...data },
            update: data,
        });

        logger.info(`Admin notification preferences updated for ${userId}`);
        return { ...pref, typePreferences: parseTypePreferences(pref.typePreferences) };
    }

    /** Reset to platform defaults. */
    static async resetToDefaults(userId: string) {
        await prisma.adminNotificationPreference.deleteMany({ where: { userId } });
        return this.createDefaults(userId);
    }

    /**
     * Core gate: decide whether to deliver a notification to an admin.
     *
     * Context shape mirrors what NotificationService has at dispatch time:
     *   - notificationType: the type being sent
     *   - metadata: the notification's metadata blob (may contain campaignId, userRole)
     */
    static async shouldDeliver(
        userId: string,
        notificationType: NotificationType,
        metadata?: Record<string, unknown>
    ): Promise<DeliveryDecision> {
        // SECURITY_ALERT always goes through
        if (MANDATORY_TYPES.includes(notificationType)) {
            return { deliver: true, channels: [NotificationChannel.EMAIL, NotificationChannel.IN_APP], queued: false };
        }

        const pref = await prisma.adminNotificationPreference.findUnique({
            where: { userId },
        });

        // No prefs yet → default allow on all channels, immediate
        if (!pref) {
            return { deliver: true, channels: [NotificationChannel.EMAIL, NotificationChannel.IN_APP], queued: false };
        }

        // Global mute
        if (pref.muteAll) {
            return { deliver: false, channels: [], queued: false, reason: 'muteAll enabled' };
        }

        // Per-type preference
        const typePrefMap = parseTypePreferences(pref.typePreferences);
        const typePref = typePrefMap[notificationType] ?? AdminNotificationTypePreference.ALL;

        if (typePref === AdminNotificationTypePreference.NONE) {
            return { deliver: false, channels: [], queued: false, reason: `type preference is NONE for ${notificationType}` };
        }

        if (typePref === AdminNotificationTypePreference.ALERTS_ONLY && !ALERT_TYPES.includes(notificationType)) {
            return { deliver: false, channels: [], queued: false, reason: `type preference is ALERTS_ONLY and ${notificationType} is not an alert` };
        }

        // Entity filters
        const campaignId = metadata?.campaignId as string | undefined;
        if (pref.campaignFilter.length > 0 && campaignId && !pref.campaignFilter.includes(campaignId)) {
            return { deliver: false, channels: [], queued: false, reason: 'campaignId not in campaignFilter' };
        }

        const userRole = metadata?.userRole as string | undefined;
        if (pref.userRoleFilter.length > 0 && userRole && !pref.userRoleFilter.includes(userRole)) {
            return { deliver: false, channels: [], queued: false, reason: 'userRole not in userRoleFilter' };
        }

        // Frequency: non-IMMEDIATE goes to digest queue
        if (pref.frequency !== NotificationFrequency.IMMEDIATE) {
            return {
                deliver: true,
                channels: pref.channels,
                queued: true,
            };
        }

        // Quiet hours: defer to end of window (treat as queued)
        if (isInQuietHours(pref.quietHoursStart, pref.quietHoursEnd)) {
            return {
                deliver: true,
                channels: pref.channels,
                queued: true,
                reason: 'quiet hours active — queued for after window',
            };
        }

        return { deliver: true, channels: pref.channels, queued: false };
    }

    /**
     * Enqueue a notification for batched (digest) delivery.
     * Called when shouldDeliver returns queued=true.
     */
    static async enqueueForDigest(
        userId: string,
        notificationId: string,
        frequency: NotificationFrequency
    ): Promise<void> {
        await prisma.notificationDigestQueue.create({
            data: {
                userId,
                notificationId,
                frequency,
                scheduledFor: nextDigestTime(frequency),
            },
        });
    }

    /**
     * Fetch and mark as sent all pending digest entries due for a user.
     * Called by the digest worker (or on-demand flush).
     */
    static async flushDigest(userId: string): Promise<{ notificationIds: string[]; count: number }> {
        const now = new Date();
        const due = await prisma.notificationDigestQueue.findMany({
            where: { userId, sent: false, scheduledFor: { lte: now } },
            orderBy: { createdAt: 'asc' },
        });

        if (due.length === 0) return { notificationIds: [], count: 0 };

        const ids = due.map((d) => d.id);
        const notificationIds = due.map((d) => d.notificationId);

        await prisma.notificationDigestQueue.updateMany({
            where: { id: { in: ids } },
            data: { sent: true, sentAt: now },
        });

        logger.info(`Digest flushed for ${userId}: ${due.length} notifications`);
        return { notificationIds, count: due.length };
    }

    /** List pending digest entries for a user. */
    static async getPendingDigest(userId: string) {
        return prisma.notificationDigestQueue.findMany({
            where: { userId, sent: false },
            orderBy: { scheduledFor: 'asc' },
        });
    }

    // ── Private helpers ───────────────────────────────────────────────────

    private static async createDefaults(userId: string) {
        const pref = await prisma.adminNotificationPreference.create({
            data: {
                userId,
                typePreferences: {} as Prisma.InputJsonValue,
                channels: [NotificationChannel.EMAIL, NotificationChannel.IN_APP],
                frequency: NotificationFrequency.IMMEDIATE,
                campaignFilter: [],
                userRoleFilter: [],
                muteAll: false,
            },
        });
        logger.info(`Default admin notification preferences created for ${userId}`);
        return { ...pref, typePreferences: {} as TypePreferenceMap };
    }
}
