/**
 * Integration tests for the email verification flow.
 *
 * Uses a stateful in-memory store (no live DB/Redis) to exercise the full
 * AuthService lifecycle: register → verify-email → login, expired tokens,
 * resend rate-limiting, and unverified-user restrictions.
 */
import { CryptoUtils } from '../../src/utils/crypto';
import { Role, UserStatus } from '@prisma/client';

// ─── In-memory store ────────────────────────────────────────────────────────
const store: { users: Map<string, any>; vLogs: any[]; sessions: Map<string, any> } = {
  users: new Map(),
  vLogs: [],
  sessions: new Map(),
};

let idSeq = 0;
const nextId = () => `user-${++idSeq}`;

// ─── Prisma fake ────────────────────────────────────────────────────────────
const prismaFake: any = {
  user: {
    findUnique: jest.fn(async ({ where }: any) => {
      if (where.email) return store.users.get(where.email) ?? null;
      if (where.verificationToken) {
        for (const u of store.users.values()) {
          if (u.verificationToken === where.verificationToken) return { ...u };
        }
        return null;
      }
      if (where.id) {
        for (const u of store.users.values()) {
          if (u.id === where.id) return { ...u };
        }
        return null;
      }
      return null;
    }),
    create: jest.fn(async ({ data }: any) => {
      const user = { id: nextId(), emailVerified: false, failedVerifyAttempts: 0, lastLogin: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      store.users.set(user.email, user);
      return { ...user };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      let user: any = null;
      for (const u of store.users.values()) {
        if (u.id === where.id || u.email === where.email) { user = u; break; }
      }
      if (!user) throw new Error('User not found in fake');
      // Handle increment
      for (const [k, v] of Object.entries<any>(data)) {
        if (v && typeof v === 'object' && 'increment' in v) {
          user[k] = (user[k] ?? 0) + v.increment;
        } else {
          user[k] = v;
        }
      }
      user.updatedAt = new Date();
      store.users.set(user.email, user);
      return { ...user };
    }),
  },
  verificationLog: {
    create: jest.fn(async ({ data }: any) => {
      const log = { id: `vlog-${store.vLogs.length + 1}`, createdAt: new Date(), ...data };
      store.vLogs.push(log);
      return log;
    }),
  },
  session: {
    create: jest.fn(async ({ data }: any) => {
      const s = { id: `sess-${store.sessions.size + 1}`, createdAt: new Date(), ...data };
      store.sessions.set(data.token, s);
      return s;
    }),
    findUnique: jest.fn(async ({ where }: any) => store.sessions.get(where.refreshToken) ?? null),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
};

// ─── Redis fake ─────────────────────────────────────────────────────────────
const redisCounters: Record<string, number> = {};
const redisFake = {
  incr: jest.fn(async (key: string) => {
    redisCounters[key] = (redisCounters[key] ?? 0) + 1;
    return redisCounters[key];
  }),
  expire: jest.fn().mockResolvedValue(1),
};

// ─── Email spy ──────────────────────────────────────────────────────────────
const sentEmails: { to: string; subject: string; html: string; text?: string }[] = [];
const notificationFake = {
  NotificationService: {
    sendEmail: jest.fn(async (to: string, subject: string, html: string, text?: string) => {
      sentEmails.push({ to, subject, html, text });
    }),
  },
};

// ─── Module mocks ────────────────────────────────────────────────────────────
jest.mock('../../src/config/database', () => prismaFake);
jest.mock('../../src/config/redis', () => ({ __esModule: true, default: redisFake }));
jest.mock('../../src/services/notification.service', () => notificationFake);
jest.mock('../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn() },
}));

import { AuthService } from '../../src/services/auth.service';
import { AppError } from '../../src/middleware/error';

// ─────────────────────────────────────────────────────────────────────────────

describe('Email Verification – Integration', () => {
  beforeEach(() => {
    store.users.clear();
    store.vLogs.length = 0;
    store.sessions.clear();
    sentEmails.length = 0;
    Object.keys(redisCounters).forEach((k) => delete redisCounters[k]);
    jest.clearAllMocks();
  });

  // ─── Full happy path ───────────────────────────────────────────────────────
  describe('Full registration → verify → login flow', () => {
    it('registers user with emailVerified=false and sends verification email', async () => {
      const result = await AuthService.register({ email: 'alice@example.com', password: 'pass123!!' });

      expect(result.userId).toBeDefined();
      expect(result.message).toMatch(/verify/i);

      const user = store.users.get('alice@example.com')!;
      expect(user.emailVerified).toBe(false);
      expect(user.verificationToken).toMatch(/^[a-f0-9]{64}$/); // stored as SHA-256 hash

      // Email is sent asynchronously
      await new Promise((r) => setImmediate(r));
      expect(sentEmails).toHaveLength(1);
      expect(sentEmails[0].to).toBe('alice@example.com');
      expect(sentEmails[0].subject).toMatch(/verify/i);
    });

    it('extracts the plaintext token from email and verifies it', async () => {
      await AuthService.register({ email: 'alice@example.com', password: 'pass123!!' });
      await new Promise((r) => setImmediate(r));

      const emailHtml = sentEmails[0].html;
      const tokenMatch = emailHtml.match(/token=([A-Za-z0-9_-]+)/);
      expect(tokenMatch).toBeTruthy();
      const plaintextToken = tokenMatch![1];

      await AuthService.verifyEmail(plaintextToken);

      const user = store.users.get('alice@example.com')!;
      expect(user.emailVerified).toBe(true);
      expect(user.verificationToken).toBeNull();
      expect(user.verificationExpiry).toBeNull();
    });

    it('allows login after verification and rejects before', async () => {
      await AuthService.register({ email: 'alice@example.com', password: 'pass123!!' });

      // Login before verification should fail
      await expect(
        AuthService.login({ email: 'alice@example.com', password: 'pass123!!' })
      ).rejects.toThrow(expect.objectContaining({ statusCode: 403 }));

      // Verify
      await new Promise((r) => setImmediate(r));
      const emailHtml = sentEmails[0].html;
      const token = emailHtml.match(/token=([A-Za-z0-9_-]+)/)![1];
      await AuthService.verifyEmail(token);

      // Update status in fake store manually (service sets ACTIVE on verify)
      const user = store.users.get('alice@example.com')!;
      expect(user.emailVerified).toBe(true);

      // Login after verification should succeed
      const loginResult = await AuthService.login({ email: 'alice@example.com', password: 'pass123!!' });
      expect(loginResult.tokens.accessToken).toBeDefined();
    });

    it('creates a VerificationLog entry with action=SENT on register', async () => {
      await AuthService.register({ email: 'alice@example.com', password: 'pass123!!' });

      expect(store.vLogs.some((l) => l.action === 'SENT')).toBe(true);
    });

    it('creates a VerificationLog entry with action=VERIFIED on verification', async () => {
      await AuthService.register({ email: 'alice@example.com', password: 'pass123!!' });
      await new Promise((r) => setImmediate(r));

      const token = sentEmails[0].html.match(/token=([A-Za-z0-9_-]+)/)![1];
      await AuthService.verifyEmail(token);

      expect(store.vLogs.some((l) => l.action === 'VERIFIED')).toBe(true);
    });
  });

  // ─── Expired token ─────────────────────────────────────────────────────────
  describe('Expired token handling', () => {
    it('returns 400 for expired token and suggests resend', async () => {
      // Manually create a user with past expiry
      const tokenHash = CryptoUtils.sha256('old-token');
      const user = {
        id: nextId(),
        email: 'bob@example.com',
        username: 'bob',
        passwordHash: await CryptoUtils.hashPassword('pass123!!'),
        role: Role.DONOR,
        status: UserStatus.PENDING_VERIFICATION,
        emailVerified: false,
        verificationToken: tokenHash,
        verificationExpiry: new Date(Date.now() - 1000), // 1 second ago
        failedVerifyAttempts: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      store.users.set(user.email, user);

      prismaFake.verificationLog.create.mockClear();

      await expect(AuthService.verifyEmail('old-token')).rejects.toThrow(
        expect.objectContaining({ statusCode: 400 })
      );

      // Failed attempts incremented
      expect(store.users.get('bob@example.com')!.failedVerifyAttempts).toBe(1);
      // Log entry with EXPIRED
      expect(store.vLogs.some((l) => l.action === 'EXPIRED')).toBe(true);
    });

    it('allows resend after expiry and new token replaces old', async () => {
      await AuthService.register({ email: 'bob@example.com', password: 'pass123!!' });
      redisFake.incr.mockResolvedValueOnce(1);

      // Expire the token
      const user = store.users.get('bob@example.com')!;
      user.verificationExpiry = new Date(Date.now() - 1000);

      sentEmails.length = 0;
      await AuthService.resendVerificationEmail('bob@example.com');
      await new Promise((r) => setImmediate(r));

      expect(sentEmails).toHaveLength(1);

      const newTokenHash = store.users.get('bob@example.com')!.verificationToken;
      expect(newTokenHash).toMatch(/^[a-f0-9]{64}$/);

      // Old token should no longer work (hash changed); new token works
      const newToken = sentEmails[0].html.match(/token=([A-Za-z0-9_-]+)/)![1];
      await AuthService.verifyEmail(newToken);
      expect(store.users.get('bob@example.com')!.emailVerified).toBe(true);
    });
  });

  // ─── Resend rate limiting ──────────────────────────────────────────────────
  describe('Resend rate limiting', () => {
    it('allows up to RESEND_RATE_LIMIT (3) resends per hour', async () => {
      await AuthService.register({ email: 'carol@example.com', password: 'pass123!!' });

      redisFake.incr
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3);

      for (let i = 0; i < 3; i++) {
        await expect(
          AuthService.resendVerificationEmail('carol@example.com')
        ).resolves.toBeDefined();
      }
    });

    it('throws 429 on the 4th resend attempt', async () => {
      await AuthService.register({ email: 'carol@example.com', password: 'pass123!!' });

      redisFake.incr.mockResolvedValue(4); // over limit

      await expect(
        AuthService.resendVerificationEmail('carol@example.com')
      ).rejects.toThrow(expect.objectContaining({ statusCode: 429 }));
    });
  });

  // ─── Security ─────────────────────────────────────────────────────────────
  describe('Security properties', () => {
    it('token is not exposed in any API response', async () => {
      const result = await AuthService.register({ email: 'dave@example.com', password: 'pass123!!' });
      const user = store.users.get('dave@example.com')!;
      const storedHash = user.verificationToken;

      expect(JSON.stringify(result)).not.toContain(storedHash);
    });

    it('reusing a token after verification returns gracefully (already verified)', async () => {
      await AuthService.register({ email: 'eve@example.com', password: 'pass123!!' });
      await new Promise((r) => setImmediate(r));

      const token = sentEmails[0].html.match(/token=([A-Za-z0-9_-]+)/)![1];
      await AuthService.verifyEmail(token);

      // Try the same token again — user is verified, token is cleared
      // findUnique by verificationToken will return null now
      await expect(AuthService.verifyEmail(token)).rejects.toThrow(AppError);
    });

    it('different resend generates different token (old token invalidated)', async () => {
      await AuthService.register({ email: 'frank@example.com', password: 'pass123!!' });
      const firstHash = store.users.get('frank@example.com')!.verificationToken;

      redisFake.incr.mockResolvedValueOnce(1);
      await AuthService.resendVerificationEmail('frank@example.com');
      const secondHash = store.users.get('frank@example.com')!.verificationToken;

      expect(firstHash).not.toBe(secondHash);
    });
  });

  // ─── Email delivery content ───────────────────────────────────────────────
  describe('Email delivery', () => {
    it('email contains the verification link with token', async () => {
      await AuthService.register({ email: 'grace@example.com', password: 'pass123!!' });
      await new Promise((r) => setImmediate(r));

      expect(sentEmails[0].html).toMatch(/verify-email\?token=/);
      expect(sentEmails[0].text).toMatch(/verify-email\?token=/);
    });

    it('email is sent on resend with fresh link', async () => {
      await AuthService.register({ email: 'henry@example.com', password: 'pass123!!' });
      sentEmails.length = 0;

      redisFake.incr.mockResolvedValueOnce(1);
      await AuthService.resendVerificationEmail('henry@example.com');
      await new Promise((r) => setImmediate(r));

      expect(sentEmails).toHaveLength(1);
      expect(sentEmails[0].to).toBe('henry@example.com');
    });

    it('email is NOT sent for already-verified user on resend', async () => {
      store.users.set('verified@example.com', {
        id: nextId(),
        email: 'verified@example.com',
        emailVerified: true,
        failedVerifyAttempts: 0,
        verificationToken: null,
        verificationExpiry: null,
      });

      await AuthService.resendVerificationEmail('verified@example.com');
      await new Promise((r) => setImmediate(r));

      expect(sentEmails).toHaveLength(0);
    });
  });
});
