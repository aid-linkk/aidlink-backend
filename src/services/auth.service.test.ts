import { AuthService } from './auth.service';
import { Role, UserStatus } from '@prisma/client';
import { Keypair } from 'soroban-client';
import redis from '../config/redis';

jest.mock('../config/database', () => {
  const mock = {
    __esModule: true,
    default: {
      user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      session: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
        delete: jest.fn(),
      },
      emailVerificationToken: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      notification: { create: jest.fn() },
    },
  };
  return mock;
});

jest.mock('../utils/crypto', () => ({
  CryptoUtils: {
    hashPassword: jest.fn().mockResolvedValue('hashed-password'),
    comparePassword: jest.fn(),
  },
}));

jest.mock('../utils/jwt', () => ({
  JWTUtils: {
    generateAccessToken: jest.fn().mockReturnValue('access-token'),
    generateRefreshToken: jest.fn().mockReturnValue('refresh-token'),
    verifyToken: jest.fn(),
  },
}));

jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('./email-preference.service', () => ({
  EmailPreferenceService: {
    createDefault: jest.fn().mockResolvedValue(undefined),
  },
}));

const prismaMock = require('../config/database').default;
const { CryptoUtils } = require('../utils/crypto');
const { JWTUtils } = require('../utils/jwt');

const mockUser = (overrides: any = {}) => ({
  id: 'user-1',
  email: 'test@example.com',
  passwordHash: 'hashed-password',
  username: 'testuser',
  role: Role.DONOR,
  status: UserStatus.ACTIVE,
  lastLogin: null,
  emailVerified: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const mockSession = (overrides: any = {}) => ({
  id: 'session-1',
  userId: 'user-1',
  token: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  ...overrides,
});

const mockVerificationToken = (overrides: any = {}) => ({
  id: 'token-1',
  userId: 'user-1',
  token: 'valid-token',
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  usedAt: null,
  createdAt: new Date(),
  ...overrides,
});

describe('AuthService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('register', () => {
    const registerData = {
      email: 'new@example.com',
      password: 'Password123!',
      username: 'newuser',
      role: Role.DONOR,
    };

    it('registers a new user successfully', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.user.create.mockResolvedValue(
        mockUser({ email: 'new@example.com', username: 'newuser' })
      );
      prismaMock.emailVerificationToken.create.mockResolvedValue(mockVerificationToken());
      prismaMock.notification.create.mockResolvedValue({});

      const result = await AuthService.register(registerData);

      expect(result).toHaveProperty('user');
      expect(result).toHaveProperty('tokens');
      expect(result.user.email).toBe('new@example.com');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.tokens.accessToken).toBe('access-token');
      expect(result.tokens.refreshToken).toBe('refresh-token');
      expect(CryptoUtils.hashPassword).toHaveBeenCalledWith('Password123!');
    });

    it('rejects duplicate email', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser());

      await expect(AuthService.register(registerData)).rejects.toThrow(
        'User with this email already exists'
      );
    });

    it('rejects duplicate username', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(mockUser());

      await expect(AuthService.register(registerData)).rejects.toThrow('Username already taken');
    });

    it('handles database error during user creation', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.user.create.mockRejectedValue(new Error('Database connection failed'));

      await expect(AuthService.register(registerData)).rejects.toThrow(
        'Database connection failed'
      );
    });
  });

  describe('login', () => {
    const credentials = { email: 'test@example.com', password: 'correct-password' };

    it('logs in with valid credentials', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser());
      CryptoUtils.comparePassword.mockResolvedValue(true);
      prismaMock.user.update.mockResolvedValue(mockUser());
      prismaMock.session.create.mockResolvedValue(mockSession());

      const result = await AuthService.login(credentials);

      expect(result).toHaveProperty('user');
      expect(result).toHaveProperty('tokens');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(prismaMock.session.create).toHaveBeenCalled();
    });

    it('generates tokens with the canonical id payload field', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser());
      CryptoUtils.comparePassword.mockResolvedValue(true);
      prismaMock.user.update.mockResolvedValue(mockUser());
      prismaMock.session.create.mockResolvedValue(mockSession());

      await AuthService.login(credentials);

      expect(JWTUtils.generateAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1', email: 'test@example.com', role: Role.DONOR })
      );
    });

    it('rejects invalid email', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      await expect(AuthService.login(credentials)).rejects.toThrow('Invalid credentials');
    });

    it('rejects wrong password', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser());
      CryptoUtils.comparePassword.mockResolvedValue(false);

      await expect(AuthService.login(credentials)).rejects.toThrow('Invalid credentials');
    });

    it('rejects login when user has no password hash', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser({ passwordHash: null }));

      await expect(AuthService.login(credentials)).rejects.toThrow(
        'Please use wallet authentication'
      );
    });

    it('rejects suspended account', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser({ status: UserStatus.SUSPENDED }));
      CryptoUtils.comparePassword.mockResolvedValue(true);

      await expect(AuthService.login(credentials)).rejects.toThrow('Account suspended');
    });

    it('rejects deleted account', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser({ status: UserStatus.DELETED }));
      CryptoUtils.comparePassword.mockResolvedValue(true);

      await expect(AuthService.login(credentials)).rejects.toThrow('Account deleted');
    });

    it('updates last login on successful authentication', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser());
      CryptoUtils.comparePassword.mockResolvedValue(true);
      prismaMock.user.update.mockResolvedValue(mockUser());
      prismaMock.session.create.mockResolvedValue(mockSession());

      await AuthService.login(credentials);

      expect(prismaMock.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1' },
          data: expect.objectContaining({ lastLogin: expect.any(Date) }),
        })
      );
    });
  });

  describe('walletAuth (issue #170 — Ed25519 signature verification)', () => {
    // These tests exercise the real challenge/verification flow, which uses
    // the live Redis instance (same as resendVerificationEmail's rate-limit
    // tests above) rather than a mock — Prisma remains mocked.
    let keypair: Keypair;
    let walletAddress: string;

    beforeEach(async () => {
      keypair = Keypair.random();
      walletAddress = keypair.publicKey();
      // Belt-and-braces: clear any leftover state for this fresh address.
      await redis.del(`wallet-challenge:${walletAddress}`);
      await redis.del(`wallet-auth-fail:${walletAddress}`);
    });

    async function signedChallenge(kp: Keypair, address: string) {
      const challenge = await AuthService.issueWalletChallenge(address);
      const signature = kp.sign(Buffer.from(challenge.message, 'utf8')).toString('base64');
      return { ...challenge, signature };
    }

    it('rejects empty signature and message with a 401', async () => {
      await expect(AuthService.walletAuth(walletAddress, '', '')).rejects.toMatchObject({
        statusCode: 401,
      });
      expect(prismaMock.user.create).not.toHaveBeenCalled();
    });

    it('rejects a valid message signed by a different keypair with a 401', async () => {
      const attacker = Keypair.random();
      const challenge = await AuthService.issueWalletChallenge(walletAddress);
      const badSignature = attacker.sign(Buffer.from(challenge.message, 'utf8')).toString('base64');

      await expect(
        AuthService.walletAuth(walletAddress, badSignature, challenge.message)
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(prismaMock.user.create).not.toHaveBeenCalled();
    });

    it('authenticates an existing wallet user on a valid signature', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser({ walletAddress }));
      prismaMock.user.update.mockResolvedValue(mockUser({ walletAddress }));
      prismaMock.session.create.mockResolvedValue(mockSession());

      const { signature, message } = await signedChallenge(keypair, walletAddress);
      const result = await AuthService.walletAuth(walletAddress, signature, message);

      expect(result).toHaveProperty('tokens');
      expect(prismaMock.user.create).not.toHaveBeenCalled();
    });

    it('creates a new user only after successful signature verification', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.user.create.mockResolvedValue(
        mockUser({ walletAddress, email: `${walletAddress}@wallet.aidlink.org` })
      );
      prismaMock.user.update.mockResolvedValue(mockUser({ walletAddress }));
      prismaMock.session.create.mockResolvedValue(mockSession());

      const { signature, message } = await signedChallenge(keypair, walletAddress);
      const result = await AuthService.walletAuth(walletAddress, signature, message);

      expect(result).toHaveProperty('tokens');
      expect(prismaMock.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ walletAddress }) })
      );
    });

    it('does not create a user row for a failed verification attempt', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      await expect(AuthService.walletAuth(walletAddress, 'bogus', 'bogus')).rejects.toMatchObject({
        statusCode: 401,
      });
      expect(prismaMock.user.create).not.toHaveBeenCalled();
    });

    it('rejects reuse of an already-consumed {signature, message} pair', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser({ walletAddress }));
      prismaMock.user.update.mockResolvedValue(mockUser({ walletAddress }));
      prismaMock.session.create.mockResolvedValue(mockSession());

      const { signature, message } = await signedChallenge(keypair, walletAddress);

      await expect(AuthService.walletAuth(walletAddress, signature, message)).resolves.toHaveProperty('tokens');
      await expect(AuthService.walletAuth(walletAddress, signature, message)).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('rejects a challenge whose stored domain no longer matches the server domain', async () => {
      const challenge = await AuthService.issueWalletChallenge(walletAddress);

      // Simulate a challenge that was (somehow) issued for a foreign domain
      // by overwriting the stored payload directly, the way a cross-service
      // replay would look from the verifier's point of view.
      const tamperedPayload = { nonce: challenge.nonce, domain: 'evil.com', issuedAt: challenge.issuedAt };
      await redis.setex(`wallet-challenge:${walletAddress}`, 300, JSON.stringify(tamperedPayload));

      const foreignMessage = [
        'AidLink wallet authentication',
        'domain: evil.com',
        `address: ${walletAddress}`,
        `nonce: ${challenge.nonce}`,
        `issuedAt: ${challenge.issuedAt}`,
      ].join('\n');
      const signature = keypair.sign(Buffer.from(foreignMessage, 'utf8')).toString('base64');

      await expect(
        AuthService.walletAuth(walletAddress, signature, foreignMessage)
      ).rejects.toMatchObject({ statusCode: 401 });
    });

    it('rejects a challenge that has expired (nonce no longer in Redis)', async () => {
      const challenge = await AuthService.issueWalletChallenge(walletAddress);
      const signature = keypair.sign(Buffer.from(challenge.message, 'utf8')).toString('base64');

      // Force-expire: delete the stored challenge directly instead of
      // waiting out the real 5-minute TTL.
      await redis.del(`wallet-challenge:${walletAddress}`);

      await expect(
        AuthService.walletAuth(walletAddress, signature, challenge.message)
      ).rejects.toMatchObject({ statusCode: 401 });
    });

    it('rate-limits after 5 failed attempts: the 6th fails with 429', async () => {
      for (let i = 0; i < 5; i++) {
        await expect(AuthService.walletAuth(walletAddress, 'bogus', 'bogus')).rejects.toMatchObject({
          statusCode: 401,
        });
      }

      await expect(AuthService.walletAuth(walletAddress, 'bogus', 'bogus')).rejects.toMatchObject({
        statusCode: 429,
      });
    });

    it('issueWalletChallenge rejects a malformed Stellar address', async () => {
      await expect(AuthService.issueWalletChallenge('not-a-real-address')).rejects.toMatchObject({
        statusCode: 400,
      });
    });
  });

  describe('refreshToken', () => {
    it('refreshes tokens with valid refresh token', async () => {
      JWTUtils.verifyToken.mockReturnValue({
        id: 'user-1',
        email: 'test@example.com',
        role: Role.DONOR,
      });
      prismaMock.session.findUnique.mockResolvedValue(
        mockSession({ expiresAt: new Date(Date.now() + 3600000) })
      );
      prismaMock.session.update.mockResolvedValue(mockSession());

      const tokens = await AuthService.refreshToken('valid-refresh-token');

      expect(tokens.accessToken).toBe('access-token');
      expect(tokens.refreshToken).toBe('refresh-token');
    });

    it('rejects invalid refresh token', async () => {
      JWTUtils.verifyToken.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      await expect(AuthService.refreshToken('bad-token')).rejects.toThrow('Invalid refresh token');
    });

    it('rejects expired session', async () => {
      JWTUtils.verifyToken.mockReturnValue({
        id: 'user-1',
        email: 'test@example.com',
        role: Role.DONOR,
      });
      prismaMock.session.findUnique.mockResolvedValue(
        mockSession({ expiresAt: new Date(Date.now() - 3600000) })
      );

      await expect(AuthService.refreshToken('expired-token')).rejects.toThrow(
        'Invalid refresh token'
      );
    });
  });

  describe('logout', () => {
    it('deletes session on logout', async () => {
      prismaMock.session.deleteMany.mockResolvedValue({ count: 1 });

      await AuthService.logout('user-1', 'some-token');

      expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', token: 'some-token' },
      });
    });

    it('handles logout when no session exists', async () => {
      prismaMock.session.deleteMany.mockResolvedValue({ count: 0 });

      await expect(AuthService.logout('user-1', 'nonexistent-token')).resolves.not.toThrow();
    });
  });

  describe('logoutAll', () => {
    it('deletes all sessions for user', async () => {
      prismaMock.session.deleteMany.mockResolvedValue({ count: 3 });

      await AuthService.logoutAll('user-1');

      expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    });
  });

  describe('getUserById', () => {
    it('returns user by id', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser());

      const user = await AuthService.getUserById('user-1');

      expect(user).not.toHaveProperty('passwordHash');
      expect(user.email).toBe('test@example.com');
    });

    it('throws error for non-existent user', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      await expect(AuthService.getUserById('nonexistent')).rejects.toThrow('User not found');
    });
  });

  describe('sendVerificationEmail', () => {
    it('creates a verification token and notification', async () => {
      prismaMock.emailVerificationToken.create.mockResolvedValue(mockVerificationToken());
      prismaMock.notification.create.mockResolvedValue({});

      await AuthService.sendVerificationEmail('user-1', 'test@example.com');

      expect(prismaMock.emailVerificationToken.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'user-1', token: expect.any(String) }),
        })
      );
      expect(prismaMock.notification.create).toHaveBeenCalled();
    });
  });

  describe('verifyEmail', () => {
    it('verifies email with valid token', async () => {
      prismaMock.emailVerificationToken.findUnique.mockResolvedValue(mockVerificationToken());
      prismaMock.user.update.mockResolvedValue(mockUser({ emailVerified: true }));
      prismaMock.emailVerificationToken.update.mockResolvedValue({});

      await AuthService.verifyEmail('valid-token');

      expect(prismaMock.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ emailVerified: true, status: UserStatus.ACTIVE }),
        })
      );
      expect(prismaMock.emailVerificationToken.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ usedAt: expect.any(Date) }),
        })
      );
    });

    it('rejects invalid token', async () => {
      prismaMock.emailVerificationToken.findUnique.mockResolvedValue(null);

      await expect(AuthService.verifyEmail('bad-token')).rejects.toThrow(
        'Invalid verification token'
      );
    });

    it('rejects expired token', async () => {
      prismaMock.emailVerificationToken.findUnique.mockResolvedValue(
        mockVerificationToken({ expiresAt: new Date(Date.now() - 3600000) })
      );
      prismaMock.emailVerificationToken.delete.mockResolvedValue({});

      await expect(AuthService.verifyEmail('expired-token')).rejects.toThrow(
        'Verification token has expired'
      );
    });

    it('rejects already used token', async () => {
      prismaMock.emailVerificationToken.findUnique.mockResolvedValue(
        mockVerificationToken({ usedAt: new Date() })
      );

      await expect(AuthService.verifyEmail('used-token')).rejects.toThrow(
        'Verification token already used'
      );
    });
  });

  describe('resendVerificationEmail', () => {
    it('resends verification for unverified user', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser({ emailVerified: false }));
      prismaMock.emailVerificationToken.deleteMany.mockResolvedValue({ count: 1 });
      prismaMock.emailVerificationToken.create.mockResolvedValue(mockVerificationToken());
      prismaMock.notification.create.mockResolvedValue({});

      await AuthService.resendVerificationEmail('user-1');

      expect(prismaMock.emailVerificationToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(prismaMock.emailVerificationToken.create).toHaveBeenCalled();
    });

    it('throws if email already verified', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser({ emailVerified: true }));

      await expect(AuthService.resendVerificationEmail('user-1')).rejects.toThrow(
        'Email already verified'
      );
    });

    it('throws if user not found', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      await expect(AuthService.resendVerificationEmail('nonexistent')).rejects.toThrow(
        'User not found'
      );
    });
  });
});
