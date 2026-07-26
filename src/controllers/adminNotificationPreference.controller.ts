import { Response, NextFunction } from 'express';
import { AdminNotificationPreferenceService } from '../services/adminNotificationPreference.service';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import { Role } from '@prisma/client';

export class AdminNotificationPreferenceController {

    /**
     * GET /api/v1/admin/notification-preferences
     * Get the authenticated admin's notification preferences.
     */
    static async getPreferences(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);
            const data = await AdminNotificationPreferenceService.getPreferences(req.user.id);
            res.status(200).json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    /**
     * PUT /api/v1/admin/notification-preferences
     * Create or update notification preferences for the authenticated admin.
     * Partial updates are merged with existing preferences.
     */
    static async upsertPreferences(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);
            const data = await AdminNotificationPreferenceService.upsertPreferences(
                req.user.id,
                req.body
            );
            res.status(200).json({
                success: true,
                data,
                message: 'Notification preferences updated',
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * DELETE /api/v1/admin/notification-preferences
     * Reset to platform defaults.
     */
    static async resetPreferences(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);
            const data = await AdminNotificationPreferenceService.resetToDefaults(req.user.id);
            res.status(200).json({
                success: true,
                data,
                message: 'Notification preferences reset to defaults',
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v1/admin/notification-preferences/digest
     * List pending digest-queue entries for the authenticated admin.
     */
    static async getPendingDigest(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);
            const data = await AdminNotificationPreferenceService.getPendingDigest(req.user.id);
            res.status(200).json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v1/admin/notification-preferences/digest/flush
     * Manually flush all due digest entries for the authenticated admin.
     * Returns the notificationIds that were flushed.
     */
    static async flushDigest(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user) throw new AppError('Authentication required', 401);
            const data = await AdminNotificationPreferenceService.flushDigest(req.user.id);
            res.status(200).json({
                success: true,
                data,
                message: `${data.count} digest notification(s) flushed`,
            });
        } catch (error) {
            next(error);
        }
    }
}
