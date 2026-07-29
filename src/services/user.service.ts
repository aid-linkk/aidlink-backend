import prisma from '../config/database';
import logger from '../config/logger';
import { AuditAction, Role, ProfileVisibility } from '@prisma/client';
import { AppError } from '../middleware/error';
import { CryptoUtils } from '../utils/crypto';
import { writeAuditLog } from './audit.service';
import { AuthService } from './auth.service';
import { BeneficiaryService } from './beneficiary.service';
import { CampaignService } from './campaign.service';
import { DonationService } from './donation.service';
import { PaginatedResponse } from '../types';

export interface UpdateProfileInput {
  username?: string;
}

export interface PrivacySettingsInput {
  profileVisibility?: ProfileVisibility;
  showDonationHistory?: boolean;
  showRealName?: boolean;
  defaultDonationAnonymous?: boolean;
}

const DEFAULT_PRIVACY_SETTINGS = {
  profileVisibility: ProfileVisibility.PRIVATE,
  showDonationHistory: false,
  showRealName: false,
  defaultDonationAnonymous: false,
};

export class UserService {
  // ── Profile ──────────────────────────────────────────────────────────

  /**
   * Returns the current user's profile plus a role-specific summary:
   * their Organization record for ORGANIZATION users, their Beneficiary
   * record for BENEFICIARY users, or nothing extra for other roles.
   */
  static async getProfile(userId: string): Promise<any> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AppError.from('AUTH_008');

    const profile = AuthService.sanitizeUser(user);

    if (user.role === Role.ORGANIZATION) {
      const organization = await prisma.organization.findUnique({ where: { userId } });
      return { ...profile, organization };
    }

    if (user.role === Role.BENEFICIARY) {
      const beneficiary = await BeneficiaryService.getBeneficiaryByUserId(userId);
      return { ...profile, beneficiary };
    }

    return profile;
  }

  /**
   * Updates editable profile fields. Only `username` is user-editable
   * today — email changes go through the verification flow and
   * walletAddress is only ever set via wallet-auth signature proof, so
   * neither belongs in a plain profile-update endpoint.
   */
  static async updateProfile(userId: string, input: UpdateProfileInput): Promise<any> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AppError.from('AUTH_008');

    if (input.username && input.username !== user.username) {
      const existing = await prisma.user.findUnique({ where: { username: input.username } });
      if (existing && existing.id !== userId) {
        throw AppError.from('USER_001');
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.username !== undefined ? { username: input.username } : {}),
      },
    });

    await writeAuditLog(AuditAction.USER_UPDATED, 'User', userId, userId, {
      from: { username: user.username },
      to: { username: updated.username },
    });

    logger.info(`Profile updated for user ${userId}`);
    return AuthService.sanitizeUser(updated);
  }

  // ── Role-specific dashboard views ───────────────────────────────────

  /** Donation history for the current user — delegates to DonationService. */
  static async getDonationHistory(
    userId: string,
    userRole: Role,
    filters: { campaignId?: string; status?: string; startDate?: Date; endDate?: Date },
    pagination: { page?: number; limit?: number; sortBy?: string; sortOrder?: string }
  ): Promise<PaginatedResponse<any>> {
    return DonationService.getDonations({ ...filters, userId }, pagination, userId, userRole);
  }

  /**
   * A beneficiary's own application/profile — same underlying record
   * exposed by GET /beneficiaries/me, surfaced here too so it appears
   * alongside the rest of the dashboard under /users.
   */
  static async getBeneficiaryApplication(userId: string): Promise<any> {
    const beneficiary = await BeneficiaryService.getBeneficiaryByUserId(userId);
    if (!beneficiary) {
      throw AppError.from('AUTH_008', 'No beneficiary application exists for this account');
    }
    return beneficiary;
  }

  /** Campaigns owned by the current user's organization. */
  static async getOrganizationCampaigns(
    userId: string,
    pagination: { page?: number; limit?: number; sortBy?: string; sortOrder?: string }
  ): Promise<PaginatedResponse<any>> {
    const organization = await prisma.organization.findUnique({ where: { userId } });
    if (!organization) {
      throw AppError.from('AUTH_008', 'No organization exists for this account');
    }
    return CampaignService.getCampaigns({ organizationId: organization.id }, pagination);
  }

  // ── Privacy settings ─────────────────────────────────────────────────

  /** Fetch privacy settings for a user, creating defaults on first read. */
  static async getPrivacySettings(userId: string): Promise<typeof DEFAULT_PRIVACY_SETTINGS> {
    const existing = await prisma.privacySettings.findUnique({ where: { userId } });
    if (existing) {
      const { id: _id, userId: _userId, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = existing;
      return rest;
    }
    return { ...DEFAULT_PRIVACY_SETTINGS };
  }

  static async updatePrivacySettings(
    userId: string,
    input: PrivacySettingsInput
  ): Promise<typeof DEFAULT_PRIVACY_SETTINGS> {
    const existing = await prisma.privacySettings.findUnique({ where: { userId } });
    const before = existing
      ? {
          profileVisibility: existing.profileVisibility,
          showDonationHistory: existing.showDonationHistory,
          showRealName: existing.showRealName,
          defaultDonationAnonymous: existing.defaultDonationAnonymous,
        }
      : DEFAULT_PRIVACY_SETTINGS;

    const merged = { ...before, ...input };

    const updated = await prisma.privacySettings.upsert({
      where: { userId },
      create: { userId, ...merged },
      update: { ...merged },
    });

    await writeAuditLog(AuditAction.SETTINGS_UPDATED, 'User', userId, userId, {
      field: 'privacySettings',
      from: before,
      to: merged,
    });

    logger.info(`Privacy settings updated for user ${userId}`);

    const { id: _id, userId: _userId, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = updated;
    return rest;
  }

  // ── Account security ────────────────────────────────────────────────

  /**
   * Lists this user's active sessions (e.g. for a "devices" screen), with
   * `isCurrent` flagged against the token of the session making this
   * request so the UI can distinguish "this device" from others.
   */
  static async listSessions(userId: string, currentToken?: string): Promise<any[]> {
    const sessions = await prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return sessions.map((session: any) => ({
      id: session.id,
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      isCurrent: currentToken !== undefined && session.token === currentToken,
    }));
  }

  /** Revokes a single session by ID, scoped to the requesting user. */
  static async revokeSession(userId: string, sessionId: string): Promise<void> {
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) {
      throw AppError.from('USER_004');
    }

    await prisma.session.delete({ where: { id: sessionId } });

    await writeAuditLog(AuditAction.SETTINGS_UPDATED, 'Session', sessionId, userId, {
      action: 'session_revoked',
    });

    logger.info(`Session ${sessionId} revoked for user ${userId}`);
  }

  /**
   * Changes the account password after verifying the current one.
   * Revokes every other session on success so a stolen credential can't
   * keep an existing token alive after the password changes.
   */
  static async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentToken?: string
  ): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AppError.from('AUTH_008');

    if (!user.passwordHash) {
      throw AppError.from('USER_003');
    }

    const isValid = await CryptoUtils.comparePassword(currentPassword, user.passwordHash);
    if (!isValid) {
      throw AppError.from('USER_002');
    }

    const newPasswordHash = await CryptoUtils.hashPassword(newPassword);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: newPasswordHash } });

    // Revoke every session except the one making this request, so the
    // caller isn't logged out by their own password-change action.
    await prisma.session.deleteMany({
      where: {
        userId,
        ...(currentToken ? { token: { not: currentToken } } : {}),
      },
    });

    await writeAuditLog(AuditAction.SETTINGS_UPDATED, 'User', userId, userId, {
      action: 'password_changed',
    });

    logger.info(`Password changed for user ${userId}`);
  }
}
