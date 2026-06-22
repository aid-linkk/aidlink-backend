import prisma from '../config/database';
import { CryptoUtils } from '../utils/crypto';
import { JWTUtils } from '../utils/jwt';
import { RegisterData, LoginCredentials, TokenPair, JWTPayload } from '../types';
import { Role, UserStatus } from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { EmailPreferenceService } from './email-preference.service';

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
