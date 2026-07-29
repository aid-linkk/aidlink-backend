import { Request, Response, NextFunction } from 'express';
import { EmailPreferenceService } from '../services/email-preference.service';
import { UserService } from '../services/user.service';
import { AppError } from '../middleware/error';
import { AuthRequest } from '../types';
import logger from '../config/logger';

function requireUser(req: AuthRequest): NonNullable<AuthRequest['user']> {
  if (!req.user) {
    throw new AppError('Authentication required', 401);
  }
  return req.user;
}

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

  /**
   * GET /api/v1/users/notification-preferences
   * Alias for email-preferences under the name the user-dashboard spec
   * (issue #13) uses. Notification preferences and email preferences are
   * the same underlying record today; if in-app/SMS channels ever need
   * independent toggles, this is the endpoint that would grow beyond a
   * pure alias.
   */
  static async getNotificationPreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
    return UserController.getEmailPreferences(req, res, next);
  }

  /**
   * PUT /api/v1/users/notification-preferences
   * @see getNotificationPreferences
   */
  static async updateNotificationPreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
    return UserController.updateEmailPreferences(req, res, next);
  }

  // ── Profile ──────────────────────────────────────────────────────

  /**
   * GET /api/v1/users/profile
   * Returns the current user's profile, including a role-specific
   * summary (organization for ORGANIZATION users, beneficiary record for
   * BENEFICIARY users).
   */
  static async getProfile(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = requireUser(req);
      const profile = await UserService.getProfile(user.id);
      res.status(200).json({ success: true, data: profile });
    } catch (error) {
      logger.error('Error fetching profile:', error);
      next(error);
    }
  }

  /**
   * PATCH /api/v1/users/profile
   * Updates editable profile fields (currently: username).
   */
  static async updateProfile(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = requireUser(req);
      const profile = await UserService.updateProfile(user.id, req.body);
      res.status(200).json({ success: true, data: profile, message: 'Profile updated successfully' });
    } catch (error) {
      logger.error('Error updating profile:', error);
      next(error);
    }
  }

  // ── Donation history ────────────────────────────────────────────

  /**
   * GET /api/v1/users/donations
   * The current user's donation history (any role that has made
   * donations). Same underlying data as GET /donations/my-donations,
   * exposed here too so it appears alongside the rest of the dashboard.
   */
  static async getDonationHistory(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = requireUser(req);

      const filters = {
        campaignId: req.query.campaignId as string,
        status: req.query.status as string,
        startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
        endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      };
      const pagination = {
        page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 10,
        sortBy: (req.query.sortBy as string) || 'createdAt',
        sortOrder: (req.query.sortOrder as string) || 'desc',
      };

      const result = await UserService.getDonationHistory(user.id, user.role, filters, pagination);
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      logger.error('Error fetching donation history:', error);
      next(error);
    }
  }

  // ── Beneficiary applications ────────────────────────────────────

  /**
   * GET /api/v1/users/beneficiary-application
   * The current user's beneficiary application/profile and its status.
   * Only meaningful for BENEFICIARY accounts.
   */
  static async getBeneficiaryApplication(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = requireUser(req);
      const application = await UserService.getBeneficiaryApplication(user.id);
      res.status(200).json({ success: true, data: application });
    } catch (error) {
      logger.error('Error fetching beneficiary application:', error);
      next(error);
    }
  }

  // ── Organization campaigns ──────────────────────────────────────

  /**
   * GET /api/v1/users/organization-campaigns
   * Campaigns owned by the current user's organization. Only meaningful
   * for ORGANIZATION accounts.
   */
  static async getOrganizationCampaigns(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = requireUser(req);
      const pagination = {
        page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 10,
        sortBy: (req.query.sortBy as string) || 'createdAt',
        sortOrder: (req.query.sortOrder as string) || 'desc',
      };
      const result = await UserService.getOrganizationCampaigns(user.id, pagination);
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      logger.error('Error fetching organization campaigns:', error);
      next(error);
    }
  }

  // ── Privacy settings ────────────────────────────────────────────

  /** GET /api/v1/users/privacy-settings */
  static async getPrivacySettings(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = requireUser(req);
      const settings = await UserService.getPrivacySettings(user.id);
      res.status(200).json({ success: true, data: settings });
    } catch (error) {
      logger.error('Error fetching privacy settings:', error);
      next(error);
    }
  }

  /** PUT /api/v1/users/privacy-settings */
  static async updatePrivacySettings(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = requireUser(req);
      const settings = await UserService.updatePrivacySettings(user.id, req.body);
      res.status(200).json({ success: true, data: settings, message: 'Privacy settings updated successfully' });
    } catch (error) {
      logger.error('Error updating privacy settings:', error);
      next(error);
    }
  }

  // ── Account security ────────────────────────────────────────────

  /**
   * GET /api/v1/users/security/sessions
   * Lists the current user's active sessions, flagging which one is
   * making this request.
   */
  static async listSessions(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = requireUser(req);
      const authHeader = req.headers.authorization;
      const currentToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

      const sessions = await UserService.listSessions(user.id, currentToken);
      res.status(200).json({ success: true, data: sessions });
    } catch (error) {
      logger.error('Error listing sessions:', error);
      next(error);
    }
  }

  /**
   * DELETE /api/v1/users/security/sessions/:sessionId
   * Revokes a single session (e.g. "sign out this device").
   */
  static async revokeSession(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = requireUser(req);
      await UserService.revokeSession(user.id, req.params.sessionId);
      res.status(200).json({ success: true, message: 'Session revoked successfully' });
    } catch (error) {
      logger.error('Error revoking session:', error);
      next(error);
    }
  }

  /**
   * POST /api/v1/users/security/password
   * Changes the account password. Revokes every other session on
   * success.
   */
  static async changePassword(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = requireUser(req);
      const { currentPassword, newPassword } = req.body;
      const authHeader = req.headers.authorization;
      const currentToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

      await UserService.changePassword(user.id, currentPassword, newPassword, currentToken);
      res.status(200).json({
        success: true,
        message: 'Password changed successfully. You have been signed out of all other devices.',
      });
    } catch (error) {
      logger.error('Error changing password:', error);
      next(error);
    }
  }
}
