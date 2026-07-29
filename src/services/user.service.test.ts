import { UserService } from './user.service';
import { Role, ProfileVisibility } from '@prisma/client';

jest.mock('../config/database', () => {
  const mock = {
    __esModule: true,
    default: {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      organization: {
        findUnique: jest.fn(),
      },
      privacySettings: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
      session: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
    },
  };
  return mock;
});

jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('../utils/crypto', () => ({
  CryptoUtils: {
    comparePassword: jest.fn(),
    hashPassword: jest.fn(),
  },
}));

jest.mock('./auth.service', () => ({
  AuthService: {
    sanitizeUser: jest.fn((user: any) => {
      const { passwordHash: _passwordHash, verificationToken: _vt, verificationExpiry: _ve, ...rest } = user;
      return rest;
    }),
  },
}));

jest.mock('./beneficiary.service', () => ({
  BeneficiaryService: { getBeneficiaryByUserId: jest.fn() },
}));

jest.mock('./campaign.service', () => ({
  CampaignService: { getCampaigns: jest.fn() },
}));

jest.mock('./donation.service', () => ({
  DonationService: { getDonations: jest.fn() },
}));

const prismaMock = require('../config/database').default;
const { CryptoUtils } = require('../utils/crypto');
const { BeneficiaryService } = require('./beneficiary.service');
const { CampaignService } = require('./campaign.service');
const { DonationService } = require('./donation.service');

describe('UserService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('getProfile', () => {
    it('throws AUTH_008 when the user does not exist', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      await expect(UserService.getProfile('missing')).rejects.toMatchObject({ errorCode: 'AUTH_008' });
    });

    it('includes the organization summary for ORGANIZATION users', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: Role.ORGANIZATION,
        email: 'org@example.com',
        passwordHash: 'hash',
      });
      prismaMock.organization.findUnique.mockResolvedValue({ id: 'org-1', name: 'Acme Aid' });

      const result = await UserService.getProfile('user-1');

      expect(result.organization).toEqual({ id: 'org-1', name: 'Acme Aid' });
      expect(result.passwordHash).toBeUndefined();
    });

    it('includes the beneficiary summary for BENEFICIARY users', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: 'user-2', role: Role.BENEFICIARY });
      BeneficiaryService.getBeneficiaryByUserId.mockResolvedValue({ id: 'ben-1', status: 'PENDING' });

      const result = await UserService.getProfile('user-2');

      expect(result.beneficiary).toEqual({ id: 'ben-1', status: 'PENDING' });
    });
  });

  describe('updateProfile', () => {
    it('throws USER_001 when the requested username is already taken by another account', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce({ id: 'user-1', username: 'old-name' }) // load current user
        .mockResolvedValueOnce({ id: 'user-2', username: 'taken' }); // username lookup

      await expect(UserService.updateProfile('user-1', { username: 'taken' })).rejects.toMatchObject({
        errorCode: 'USER_001',
      });
    });

    it('allows a user to "change" their username to the value it already is', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', username: 'same-name' });
      prismaMock.user.update.mockResolvedValue({ id: 'user-1', username: 'same-name' });

      const result = await UserService.updateProfile('user-1', { username: 'same-name' });

      expect(result.username).toBe('same-name');
      // No second findUnique lookup for a uniqueness check, since it's unchanged
      expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1);
    });

    it('updates the username when it is available', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({ id: 'user-1', username: 'old' }).mockResolvedValueOnce(null);
      prismaMock.user.update.mockResolvedValue({ id: 'user-1', username: 'new-name' });

      const result = await UserService.updateProfile('user-1', { username: 'new-name' });

      expect(result.username).toBe('new-name');
      expect(prismaMock.auditLog.create).toHaveBeenCalled();
    });
  });

  describe('getDonationHistory', () => {
    it('delegates to DonationService.getDonations, scoped to the requesting user', async () => {
      DonationService.getDonations.mockResolvedValue({ data: [], pagination: {} });

      await UserService.getDonationHistory(
        'user-1',
        Role.DONOR,
        { campaignId: 'camp-1' },
        { page: 1, limit: 10 }
      );

      expect(DonationService.getDonations).toHaveBeenCalledWith(
        { campaignId: 'camp-1', userId: 'user-1' },
        { page: 1, limit: 10 },
        'user-1',
        Role.DONOR
      );
    });
  });

  describe('getBeneficiaryApplication', () => {
    it('throws AUTH_008 when no beneficiary record exists', async () => {
      BeneficiaryService.getBeneficiaryByUserId.mockResolvedValue(null);
      await expect(UserService.getBeneficiaryApplication('user-1')).rejects.toMatchObject({
        errorCode: 'AUTH_008',
      });
    });

    it('returns the beneficiary record when it exists', async () => {
      BeneficiaryService.getBeneficiaryByUserId.mockResolvedValue({ id: 'ben-1', status: 'VERIFIED' });
      const result = await UserService.getBeneficiaryApplication('user-1');
      expect(result).toEqual({ id: 'ben-1', status: 'VERIFIED' });
    });
  });

  describe('getOrganizationCampaigns', () => {
    it('throws AUTH_008 when the user has no organization', async () => {
      prismaMock.organization.findUnique.mockResolvedValue(null);
      await expect(UserService.getOrganizationCampaigns('user-1', {})).rejects.toMatchObject({
        errorCode: 'AUTH_008',
      });
    });

    it('scopes CampaignService.getCampaigns to the organization id', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({ id: 'org-1' });
      CampaignService.getCampaigns.mockResolvedValue({ data: [], pagination: {} });

      await UserService.getOrganizationCampaigns('user-1', { page: 2 });

      expect(CampaignService.getCampaigns).toHaveBeenCalledWith({ organizationId: 'org-1' }, { page: 2 });
    });
  });

  describe('privacy settings', () => {
    it('returns defaults when no record exists yet', async () => {
      prismaMock.privacySettings.findUnique.mockResolvedValue(null);
      const result = await UserService.getPrivacySettings('user-1');
      expect(result).toEqual({
        profileVisibility: ProfileVisibility.PRIVATE,
        showDonationHistory: false,
        showRealName: false,
        defaultDonationAnonymous: false,
      });
    });

    it('merges partial updates onto existing settings and persists via upsert', async () => {
      prismaMock.privacySettings.findUnique.mockResolvedValue({
        id: 'ps-1',
        userId: 'user-1',
        profileVisibility: ProfileVisibility.PRIVATE,
        showDonationHistory: false,
        showRealName: false,
        defaultDonationAnonymous: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      prismaMock.privacySettings.upsert.mockResolvedValue({
        id: 'ps-1',
        userId: 'user-1',
        profileVisibility: ProfileVisibility.PUBLIC,
        showDonationHistory: true,
        showRealName: false,
        defaultDonationAnonymous: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await UserService.updatePrivacySettings('user-1', {
        profileVisibility: ProfileVisibility.PUBLIC,
        showDonationHistory: true,
      });

      expect(result.profileVisibility).toBe(ProfileVisibility.PUBLIC);
      expect(result.showDonationHistory).toBe(true);
      expect(prismaMock.privacySettings.upsert).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        create: {
          userId: 'user-1',
          profileVisibility: ProfileVisibility.PUBLIC,
          showDonationHistory: true,
          showRealName: false,
          defaultDonationAnonymous: false,
        },
        update: {
          profileVisibility: ProfileVisibility.PUBLIC,
          showDonationHistory: true,
          showRealName: false,
          defaultDonationAnonymous: false,
        },
      });
    });
  });

  describe('listSessions', () => {
    it('flags the session matching the current request token as isCurrent', async () => {
      prismaMock.session.findMany.mockResolvedValue([
        { id: 's-1', token: 'tok-current', userAgent: 'Chrome', ipAddress: '1.1.1.1', createdAt: new Date(), expiresAt: new Date() },
        { id: 's-2', token: 'tok-other', userAgent: 'Firefox', ipAddress: '2.2.2.2', createdAt: new Date(), expiresAt: new Date() },
      ]);

      const result = await UserService.listSessions('user-1', 'tok-current');

      expect(result.find((s: any) => s.id === 's-1')?.isCurrent).toBe(true);
      expect(result.find((s: any) => s.id === 's-2')?.isCurrent).toBe(false);
    });
  });

  describe('revokeSession', () => {
    it('throws USER_004 when the session does not belong to the requesting user', async () => {
      prismaMock.session.findUnique.mockResolvedValue({ id: 's-1', userId: 'someone-else' });
      await expect(UserService.revokeSession('user-1', 's-1')).rejects.toMatchObject({ errorCode: 'USER_004' });
    });

    it('throws USER_004 when the session does not exist', async () => {
      prismaMock.session.findUnique.mockResolvedValue(null);
      await expect(UserService.revokeSession('user-1', 'missing')).rejects.toMatchObject({ errorCode: 'USER_004' });
    });

    it('deletes the session when it belongs to the requesting user', async () => {
      prismaMock.session.findUnique.mockResolvedValue({ id: 's-1', userId: 'user-1' });
      await UserService.revokeSession('user-1', 's-1');
      expect(prismaMock.session.delete).toHaveBeenCalledWith({ where: { id: 's-1' } });
    });
  });

  describe('changePassword', () => {
    it('throws USER_003 when the account has no password set (wallet-only account)', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', passwordHash: null });
      await expect(UserService.changePassword('user-1', 'x', 'newpassword1')).rejects.toMatchObject({
        errorCode: 'USER_003',
      });
    });

    it('throws USER_002 when the current password is incorrect', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'hash' });
      CryptoUtils.comparePassword.mockResolvedValue(false);

      await expect(UserService.changePassword('user-1', 'wrong', 'newpassword1')).rejects.toMatchObject({
        errorCode: 'USER_002',
      });
    });

    it('hashes and stores the new password, then revokes all other sessions', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'old-hash' });
      CryptoUtils.comparePassword.mockResolvedValue(true);
      CryptoUtils.hashPassword.mockResolvedValue('new-hash');

      await UserService.changePassword('user-1', 'correct-current', 'newpassword1', 'tok-current');

      expect(prismaMock.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { passwordHash: 'new-hash' },
      });
      expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', token: { not: 'tok-current' } },
      });
    });

    it('revokes all sessions (no exclusion) when no current token is known', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'old-hash' });
      CryptoUtils.comparePassword.mockResolvedValue(true);
      CryptoUtils.hashPassword.mockResolvedValue('new-hash');

      await UserService.changePassword('user-1', 'correct-current', 'newpassword1');

      expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    });
  });
});
