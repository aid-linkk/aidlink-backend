import { AuthService } from './auth.service';
import { Role, UserStatus } from '@prisma/client';

jest.mock('../config/database', () => {
  const mock = {
    __esModule: true,
    default: {
      user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      session: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), deleteMany: jest.fn(), delete: jest.fn() },
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

describe('AuthService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('register', () => {
    const registerData = { email: 'new@example.com', password: 'Password123!', username: 'newuser', role: Role.DONOR };

    it('registers a new user successfully', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.user.create.mockResolvedValue(mockUser({ email: 'new@example.com', username: 'newuser' }));

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

      await expect(AuthService.register(registerData)).rejects.toThrow('User with this email already exists');
    });

    it('rejects duplicate username', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockUser());

      await expect(AuthService.register(registerData)).rejects.toThrow('Username already taken');
    });

    it('handles database error during user creation', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.user.create.mockRejectedValue(new Error('Database connection failed'));

      await expect(AuthService.register(registerData)).rejects.toThrow('Database connection failed');
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

      await expect(AuthService.login(credentials)).rejects.toThrow('Please use wallet authentication');
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

  describe('walletAuth', () => {
    const walletAddress = 'GABCDEF123456';

    it('authenticates existing wallet user', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser({ walletAddress }));
      prismaMock.user.update.mockResolvedValue(mockUser({ walletAddress }));
      prismaMock.session.create.mockResolvedValue(mockSession());

      const result = await AuthService.walletAuth(walletAddress, 'sig', 'msg');

      expect(result).toHaveProperty('tokens');
      expect(prismaMock.user.create).not.toHaveBeenCalled();
    });

    it('creates new user for unknown wallet', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.user.create.mockResolvedValue(mockUser({ walletAddress, email: `${walletAddress}@wallet.aidlink.org` }));
      prismaMock.user.update.mockResolvedValue(mockUser({ walletAddress }));
      prismaMock.session.create.mockResolvedValue(mockSession());

      const result = await AuthService.walletAuth(walletAddress, 'sig', 'msg');

      expect(result).toHaveProperty('tokens');
      expect(prismaMock.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ walletAddress }) })
      );
    });
  });

  describe('refreshToken', () => {
    it('refreshes tokens with valid refresh token', async () => {
      JWTUtils.verifyToken.mockReturnValue({ id: 'user-1', email: 'test@example.com', role: Role.DONOR });
      prismaMock.session.findUnique.mockResolvedValue(mockSession({ expiresAt: new Date(Date.now() + 3600000) }));
      prismaMock.session.update.mockResolvedValue(mockSession());

      const tokens = await AuthService.refreshToken('valid-refresh-token');

      expect(tokens.accessToken).toBe('access-token');
      expect(tokens.refreshToken).toBe('refresh-token');
    });

    it('rejects invalid refresh token', async () => {
      JWTUtils.verifyToken.mockImplementation(() => { throw new Error('Invalid token'); });

      await expect(AuthService.refreshToken('bad-token')).rejects.toThrow('Invalid refresh token');
    });

    it('rejects expired session', async () => {
      JWTUtils.verifyToken.mockReturnValue({ id: 'user-1', email: 'test@example.com', role: Role.DONOR });
      prismaMock.session.findUnique.mockResolvedValue(mockSession({ expiresAt: new Date(Date.now() - 3600000) }));

      await expect(AuthService.refreshToken('expired-token')).rejects.toThrow('Invalid refresh token');
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
});
