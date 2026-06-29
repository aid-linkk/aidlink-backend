import fs from 'fs';
import path from 'path';
import prisma from '../config/database';
import redis from '../config/redis';
import { CryptoUtils } from '../utils/crypto';
import { JWTUtils } from '../utils/jwt';
import { RegisterData, LoginCredentials, TokenPair, JWTPayload } from '../types';
import { Role, UserStatus } from '@prisma/client';
import { AppError } from '../middleware/error';
import { NotificationService } from './notification.service';
import { config } from '../config';
import logger from '../config/logger';
import { EmailPreferenceService } from './email-preference.service';
import crypto from 'crypto';

const TOKEN_EXPIRY_HOURS = parseInt(process.env.VERIFICATION_TOKEN_EXPIRY_HOURS || '24', 10);
const RESEND_RATE_LIMIT = parseInt(process.env.VERIFICATION_RESEND_RATE_LIMIT || '3', 10);
const MAX_FAILED_ATTEMPTS = parseInt(process.env.VERIFICATION_MAX_FAILED_ATTEMPTS || '10', 10);

function renderTemplate(filename: string, vars: Record<string, string>): string {
  const tplPath = path.join(__dirname, '../templates', filename);
  let tpl = fs.readFileSync(tplPath, 'utf-8');
  for (const [key, value] of Object.entries(vars)) {
    tpl = tpl.replaceAll(`{{${key}}}`, value);
  }
  return tpl;
}

async function sendVerificationEmail(email: string, firstName: string, token: string): Promise<void> {
  const baseUrl = process.env.APP_BASE_URL || 'https://app.aidlink.org';
  const verificationLink = `${baseUrl}/verify-email?token=${token}`;
  const year = new Date().getFullYear().toString();

  const html = renderTemplate('verify-email.html', { firstName, verificationLink, year });
  const text = renderTemplate('verify-email.txt', { firstName, verificationLink, year });

  await NotificationService.sendEmail(email, 'Verify your AidLink account', html, text);
}

async function createVerificationLog(
  userId: string,
  action: string,
  tokenHash?: string,
  ipAddress?: string,
  userAgent?: string
): Promise<void> {
  await prisma.verificationLog.create({
    data: { userId, action, tokenHash, ipAddress, userAgent },
  });
}

export class AuthService {
  static async register(
    data: RegisterData,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<{ userId: string; message: string }> {
    const { email, password, username, role = Role.DONOR } = data;
    const normalizedEmail = email.toLowerCase();

    const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existingUser) throw new AppError('User with this email already exists', 409);

    if (username) {
      const existingUsername = await prisma.user.findUnique({ where: { username } });
      if (existingUsername) throw new AppError('Username already taken', 409);
    }

    const passwordHash = await CryptoUtils.hashPassword(password);
    const token = CryptoUtils.generateVerificationToken();
    const tokenHash = CryptoUtils.sha256(token);
    const verificationExpiry = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        username,
        role,
        status: UserStatus.PENDING_VERIFICATION,
        verificationToken: tokenHash,
        verificationExpiry,
      },
    });

    // Create default email preferences (non-blocking)
    EmailPreferenceService.createDefault(user.id).catch((err) =>
      logger.error('Failed to create email preferences for new user:', err)
    );

    // Send verification email (non-blocking)
    this.sendVerificationEmail(user.id, user.email).catch((err) =>
      logger.error('Failed to send verification email:', err)
    );

    // Generate tokens
    const tokens = this.generateTokens(user.id, user.email, user.role);

    // Send email async — don't block registration response
    sendVerificationEmail(normalizedEmail, username || normalizedEmail.split('@')[0], token).catch(
      (err) => logger.error('Failed to send verification email:', err)
    );

    logger.info(`User registered: ${normalizedEmail}`);

    return { userId: user.id, message: 'User created. Check your email to verify.' };
  }

  static async verifyEmail(
    token: string,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<void> {
    const tokenHash = CryptoUtils.sha256(token);

    const user = await prisma.user.findUnique({ where: { verificationToken: tokenHash } });

    if (!user) {
      throw new AppError('Verification link expired or invalid.', 400);
    }

    if (user.emailVerified) {
      // Already verified — succeed gracefully
      return;
    }

    // Check failed attempts lockout
    if (user.failedVerifyAttempts >= MAX_FAILED_ATTEMPTS) {
      await createVerificationLog(user.id, 'FAILED', tokenHash, meta?.ipAddress, meta?.userAgent);
      throw new AppError(
        'Too many failed verification attempts. Please request a new verification email.',
        429
      );
    }

    if (!user.verificationExpiry || user.verificationExpiry < new Date()) {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedVerifyAttempts: { increment: 1 } },
      });
      await createVerificationLog(user.id, 'EXPIRED', tokenHash, meta?.ipAddress, meta?.userAgent);
      throw new AppError('Verification link expired or invalid.', 400);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        status: UserStatus.ACTIVE,
        verificationToken: null,
        verificationExpiry: null,
        failedVerifyAttempts: 0,
      },
    });

    await createVerificationLog(user.id, 'VERIFIED', tokenHash, meta?.ipAddress, meta?.userAgent);

    logger.info(`Email verified: ${user.email}`);
  }

  static async resendVerificationEmail(
    email: string,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<{ alreadyVerified?: boolean; message: string }> {
    const normalizedEmail = email.toLowerCase();

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      // Don't reveal existence; respond as if sent
      return { message: 'If that email is registered, a verification link has been sent.' };
    }

    if (user.emailVerified) {
      return { alreadyVerified: true, message: 'Email is already verified.' };
    }

    // Redis-backed rate limit: max RESEND_RATE_LIMIT resends per hour per email
    const rateLimitKey = `resend_verification:${normalizedEmail}`;
    const count = await redis.incr(rateLimitKey);
    if (count === 1) {
      await redis.expire(rateLimitKey, 60 * 60); // 1 hour TTL
    }
    if (count > RESEND_RATE_LIMIT) {
      throw new AppError('Too many resend attempts. Please try again later.', 429);
    }

    const token = CryptoUtils.generateVerificationToken();
    const tokenHash = CryptoUtils.sha256(token);
    const verificationExpiry = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: { verificationToken: tokenHash, verificationExpiry, failedVerifyAttempts: 0 },
    });

    await createVerificationLog(user.id, 'RESENT', tokenHash, meta?.ipAddress, meta?.userAgent);

    sendVerificationEmail(normalizedEmail, user.username || normalizedEmail.split('@')[0], token).catch(
      (err) => logger.error('Failed to send verification email:', err)
    );

    return { message: 'Verification email sent.' };
  }

  static async login(credentials: LoginCredentials): Promise<{ user: any; tokens: TokenPair }> {
    const { email, password } = credentials;
    const normalizedEmail = email.toLowerCase();

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (!user || !user.passwordHash) {
      throw new AppError('Invalid credentials', 401);
    }

    const isValidPassword = await CryptoUtils.comparePassword(password, user.passwordHash);
    if (!isValidPassword) throw new AppError('Invalid credentials', 401);

    if (user.status === UserStatus.SUSPENDED) throw new AppError('Account suspended', 403);
    if (user.status === UserStatus.DELETED) throw new AppError('Account deleted', 403);

    if (!user.emailVerified) {
      throw new AppError(
        'Please verify your email before logging in. Check your inbox or resend the verification email.',
        403
      );
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

    const tokens = this.generateTokens(user.id, user.email, user.role);
    await this.createSession(user.id, tokens.accessToken, tokens.refreshToken);

    logger.info(`User logged in: ${user.email}`);
    return { user: this.sanitizeUser(user), tokens };
  }

  static async walletAuth(walletAddress: string, signature: string, message: string): Promise<{ user: any; tokens: TokenPair }> {
    let user = await prisma.user.findUnique({ where: { walletAddress } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          walletAddress,
          email: `${walletAddress}@wallet.aidlink.org`,
          role: Role.DONOR,
          status: UserStatus.ACTIVE,
          emailVerified: true,
        },
      });

      // Create default email preferences for new wallet user (non-blocking)
      EmailPreferenceService.createDefault(user.id).catch((err) =>
        logger.error('Failed to create email preferences for wallet user:', err)
      );
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

    const tokens = this.generateTokens(user.id, user.email, user.role);
    await this.createSession(user.id, tokens.accessToken, tokens.refreshToken);

    logger.info(`User authenticated via wallet: ${walletAddress}`);
    return { user: this.sanitizeUser(user), tokens };
  }

  static async refreshToken(refreshToken: string): Promise<TokenPair> {
    try {
      const payload = JWTUtils.verifyToken(refreshToken) as JWTPayload;

      const session = await prisma.session.findUnique({ where: { refreshToken } });
      if (!session) throw new AppError('Invalid refresh token', 401);

      if (session.expiresAt < new Date()) {
        await prisma.session.delete({ where: { id: session.id } });
        throw new AppError('Session expired', 401);
      }

      const tokens = this.generateTokens(payload.id, payload.email, payload.role);

      await prisma.session.update({
        where: { id: session.id },
        data: {
          token: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      return tokens;
    } catch (error) {
      throw new AppError('Invalid refresh token', 401);
    }
  }

  static async logout(userId: string, token: string): Promise<void> {
    await prisma.session.deleteMany({ where: { userId, token } });
    logger.info(`User logged out: ${userId}`);
  }

  static async logoutAll(userId: string): Promise<void> {
    await prisma.session.deleteMany({ where: { userId } });
    logger.info(`User logged out from all sessions: ${userId}`);
  }

  static async getUserById(userId: string): Promise<any> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('User not found', 404);
    return this.sanitizeUser(user);
  }

  // ── Email Verification ────────────────────────────────────────────

  static async sendVerificationEmail(userId: string, email: string): Promise<void> {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await prisma.emailVerificationToken.create({
      data: { userId, token, expiresAt },
    });

    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;

    await prisma.notification.create({
      data: {
        userId,
        type: 'EMAIL_VERIFICATION',
        title: 'Verify your email',
        message: `Please verify your email by clicking: ${verificationUrl}`,
        metadata: { verificationUrl, token },
      },
    });

    logger.info(`Verification email sent to: ${email}`);
  }

  static async verifyEmail(token: string): Promise<void> {
    const record = await prisma.emailVerificationToken.findUnique({
      where: { token },
    });

    if (!record) {
      throw new AppError('Invalid verification token', 400);
    }

    if (record.expiresAt < new Date()) {
      await prisma.emailVerificationToken.delete({ where: { token } });
      throw new AppError('Verification token has expired', 400);
    }

    if (record.usedAt) {
      throw new AppError('Verification token already used', 400);
    }

    await prisma.user.update({
      where: { id: record.userId },
      data: { emailVerified: true, status: UserStatus.ACTIVE },
    });

    await prisma.emailVerificationToken.update({
      where: { token },
      data: { usedAt: new Date() },
    });

    logger.info(`Email verified for user: ${record.userId}`);
  }

  static async resendVerificationEmail(userId: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) throw new AppError('User not found', 404);
    if (user.emailVerified) throw new AppError('Email already verified', 400);

    // Delete previous tokens
    await prisma.emailVerificationToken.deleteMany({ where: { userId } });

    await this.sendVerificationEmail(userId, user.email);
  }

  // ── Private helpers ───────────────────────────────────────────────

  private static generateTokens(userId: string, email: string, role: Role): TokenPair {
    const payload: JWTPayload = { id: userId, email, role };
    return {
      accessToken: JWTUtils.generateAccessToken(payload),
      refreshToken: JWTUtils.generateRefreshToken(payload),
    };
  }

  private static async createSession(userId: string, accessToken: string, refreshToken: string): Promise<void> {
    await prisma.session.create({
      data: {
        userId,
        token: accessToken,
        refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
  }

  static sanitizeUser(user: any): any {
    const { passwordHash, verificationToken, verificationExpiry, failedVerifyAttempts, ...sanitized } = user;
    return sanitized;
  }
}