import prisma from '../config/database';
import { CryptoUtils } from '../utils/crypto';
import { JWTUtils } from '../utils/jwt';
import { RegisterData, LoginCredentials, TokenPair, JWTPayload } from '../types';
import { Role, UserStatus } from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { EmailPreferenceService } from './email-preference.service';
import crypto from 'crypto';

export class AuthService {
  static async register(data: RegisterData): Promise<{ user: any; tokens: TokenPair }> {
    const { email, password, username, role = Role.DONOR } = data;

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new AppError('User with this email already exists', 409);
    }

    if (username) {
      const existingUsername = await prisma.user.findUnique({
        where: { username },
      });

      if (existingUsername) {
        throw new AppError('Username already taken', 409);
      }
    }

    // Hash password
    const passwordHash = await CryptoUtils.hashPassword(password);

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        username,
        role,
        status: UserStatus.PENDING_VERIFICATION,
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

    logger.info(`User registered: ${user.email}`);

    return {
      user: this.sanitizeUser(user),
      tokens,
    };
  }

  static async login(credentials: LoginCredentials): Promise<{ user: any; tokens: TokenPair }> {
    const { email, password } = credentials;

    // Find user
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new AppError('Invalid credentials', 401);
    }

    if (!user.passwordHash) {
      throw new AppError('Please use wallet authentication', 400);
    }

    // Verify password
    const isValidPassword = await CryptoUtils.comparePassword(password, user.passwordHash);

    if (!isValidPassword) {
      throw new AppError('Invalid credentials', 401);
    }

    // Check user status
    if (user.status === UserStatus.SUSPENDED) {
      throw new AppError('Account suspended', 403);
    }

    if (user.status === UserStatus.DELETED) {
      throw new AppError('Account deleted', 403);
    }

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    // Generate tokens
    const tokens = this.generateTokens(user.id, user.email, user.role);

    // Create session
    await this.createSession(user.id, tokens.accessToken, tokens.refreshToken);

    logger.info(`User logged in: ${user.email}`);

    return {
      user: this.sanitizeUser(user),
      tokens,
    };
  }

  static async walletAuth(walletAddress: string, signature: string, message: string): Promise<{ user: any; tokens: TokenPair }> {
    // Verify signature (implementation depends on Stellar SDK)
    // For now, we'll create/update user with wallet address
    
    let user = await prisma.user.findUnique({
      where: { walletAddress },
    });

    if (!user) {
      // Create new user with wallet
      user = await prisma.user.create({
        data: {
          walletAddress,
          email: `${walletAddress}@wallet.aidlink.org`, // Temporary email
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

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    // Generate tokens
    const tokens = this.generateTokens(user.id, user.email, user.role);

    // Create session
    await this.createSession(user.id, tokens.accessToken, tokens.refreshToken);

    logger.info(`User authenticated via wallet: ${walletAddress}`);

    return {
      user: this.sanitizeUser(user),
      tokens,
    };
  }

  static async refreshToken(refreshToken: string): Promise<TokenPair> {
    try {
      const payload = JWTUtils.verifyToken(refreshToken) as JWTPayload;

      // Check if session exists
      const session = await prisma.session.findUnique({
        where: { refreshToken },
      });

      if (!session) {
        throw new AppError('Invalid refresh token', 401);
      }

      // Check if session is expired
      if (session.expiresAt < new Date()) {
        await prisma.session.delete({ where: { id: session.id } });
        throw new AppError('Session expired', 401);
      }

      // Generate new tokens
      const tokens = this.generateTokens(payload.id, payload.email, payload.role);

      // Update session
      await prisma.session.update({
        where: { id: session.id },
        data: {
          token: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
        },
      });

      return tokens;
    } catch (error) {
      throw new AppError('Invalid refresh token', 401);
    }
  }

  static async logout(userId: string, token: string): Promise<void> {
    await prisma.session.deleteMany({
      where: { userId, token },
    });

    logger.info(`User logged out: ${userId}`);
  }

  static async logoutAll(userId: string): Promise<void> {
    await prisma.session.deleteMany({
      where: { userId },
    });

    logger.info(`User logged out from all sessions: ${userId}`);
  }

  static async getUserById(userId: string): Promise<any> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

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
    const payload: JWTPayload = {
      id: userId,
      email,
      role,
    };

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
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      },
    });
  }

  private static sanitizeUser(user: any): any {
    const { passwordHash, ...sanitized } = user;
    return sanitized;
  }
}