import { Request, Response, NextFunction } from 'express';
import { EmailPreferenceService } from '../services/email-preference.service';
import logger from '../config/logger';

export class UserController {
  // ── Email Preferences ──────────────────────────────────────────

  /**
   * GET /api/v1/users/email-preferences
   * Returns the current user's email notification preferences.
   */
  static async getEmailPreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).user.id;
      const preferences = await EmailPreferenceService.getPreferences(userId);

      res.status(200).json({
        success: true,
        data: preferences,
      });
    } catch (error) {
      logger.error('Error fetching email preferences:', error);
      next(error);
    }
  }

  /**
   * PUT /api/v1/users/email-preferences
   * Updates the current user's email notification preferences.
   */
  static async updateEmailPreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).user.id;
      const { categories, allEmailsDisabled } = req.body;

      const preferences = await EmailPreferenceService.upsertPreferences(
        userId,
        categories || {},
        allEmailsDisabled
      );

      res.status(200).json({
        success: true,
        data: preferences,
        message: 'Email preferences updated successfully',
      });
    } catch (error) {
      logger.error('Error updating email preferences:', error);
      next(error);
    }
  }
}
