import { Role, CampaignStatus } from '@prisma/client';
import {
  validateResourceId,
  authorizeCampaignJoin,
  authorizeOrganizationJoin,
  authorizeBeneficiaryJoin,
  invalidateCampaignAuthorizationCache,
  AuthorizationContext,
} from './authorization';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    campaign: { findUnique: jest.fn() },
    organization: { findUnique: jest.fn() },
    beneficiary: { findUnique: jest.fn() },
    beneficiaryAssignment: { findFirst: jest.fn() },
  },
}));

jest.mock('../config/redis', () => {
  const mockRedis = {
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    scanStream: jest.fn(),
  };
  return {
    __esModule: true,
    default: mockRedis,
  };
});

jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

const prismaMock = require('../config/database').default;
const redisMock = require('../config/redis').default;

describe('WebSocket Authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('validateResourceId', () => {
    it('accepts valid resource IDs', () => {
      expect(validateResourceId('valid-id-123')).toBe(true);
      expect(validateResourceId('campaign_abc')).toBe(true);
    });

    it('rejects empty strings', () => {
      expect(validateResourceId('')).toBe(false);
    });

    it('rejects overly large inputs (> 500 chars)', () => {
      const longId = 'a'.repeat(501);
      expect(validateResourceId(longId)).toBe(false);
    });

    it('rejects prototype pollution attempts', () => {
      expect(validateResourceId('__proto__')).toBe(false);
      expect(validateResourceId('constructor')).toBe(false);
      expect(validateResourceId('prototype')).toBe(false);
    });

    it('rejects non-string types', () => {
      expect(validateResourceId(null)).toBe(false);
      expect(validateResourceId(undefined)).toBe(false);
      expect(validateResourceId(123)).toBe(false);
      expect(validateResourceId({})).toBe(false);
      expect(validateResourceId([])).toBe(false);
    });
  });

  describe('authorizeCampaignJoin', () => {
    const donorContext: AuthorizationContext = {
      userId: 'user-donor',
      userRole: Role.DONOR,
    };

    const orgContext: AuthorizationContext = {
      userId: 'user-org',
      userRole: Role.ORGANIZATION,
    };

    const adminContext: AuthorizationContext = {
      userId: 'user-admin',
      userRole: Role.ADMIN,
    };

    const auditorContext: AuthorizationContext = {
      userId: 'user-auditor',
      userRole: Role.AUDITOR,
    };

    it('rejects invalid input', async () => {
      const result = await authorizeCampaignJoin(donorContext, '');
      expect(result).toEqual({ authorized: false, reason: 'invalid_input' });
      expect(prismaMock.campaign.findUnique).not.toHaveBeenCalled();
    });

    it('ADMIN can join any campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue({
        userId: 'other-user',
        status: CampaignStatus.DRAFT,
      });

      const result = await authorizeCampaignJoin(adminContext, 'campaign-1');
      expect(result).toEqual({ authorized: true });
      expect(prismaMock.campaign.findUnique).not.toHaveBeenCalled();
    });

    it('AUDITOR can join any campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue({
        userId: 'other-user',
        status: CampaignStatus.DRAFT,
      });

      const result = await authorizeCampaignJoin(auditorContext, 'campaign-1');
      expect(result).toEqual({ authorized: true });
      expect(prismaMock.campaign.findUnique).not.toHaveBeenCalled();
    });

    it('ORGANIZATION can join their own campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue({
        userId: 'user-org',
        status: CampaignStatus.DRAFT,
      });

      const result = await authorizeCampaignJoin(orgContext, 'campaign-1');
      expect(result).toEqual({ authorized: true });
      expect(prismaMock.campaign.findUnique).toHaveBeenCalledWith({
        where: { id: 'campaign-1' },
        select: { userId: true, status: true },
      });
    });

    it('ORGANIZATION cannot join another organization campaign', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue({
        userId: 'other-org',
        status: CampaignStatus.ACTIVE,
      });

      const result = await authorizeCampaignJoin(orgContext, 'campaign-1');
      expect(result).toEqual({ authorized: false, reason: 'forbidden' });
    });

    it('any user can join ACTIVE campaign (public read)', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue({
        userId: 'other-org',
        status: CampaignStatus.ACTIVE,
      });

      const result = await authorizeCampaignJoin(donorContext, 'campaign-1');
      expect(result).toEqual({ authorized: true });
    });

    it('any user can join COMPLETED campaign (public read)', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue({
        userId: 'other-org',
        status: CampaignStatus.COMPLETED,
      });

      const result = await authorizeCampaignJoin(donorContext, 'campaign-1');
      expect(result).toEqual({ authorized: true });
    });

    it('DONOR cannot join DRAFT campaign they do not own', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue({
        userId: 'other-org',
        status: CampaignStatus.DRAFT,
      });

      const result = await authorizeCampaignJoin(donorContext, 'campaign-1');
      expect(result).toEqual({ authorized: false, reason: 'forbidden' });
    });

    it('returns not_found when campaign does not exist', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue(null);

      const result = await authorizeCampaignJoin(donorContext, 'campaign-1');
      expect(result).toEqual({ authorized: false, reason: 'not_found' });
    });

    it('caches authorization results', async () => {
      prismaMock.campaign.findUnique.mockResolvedValue({
        userId: 'other-org',
        status: CampaignStatus.ACTIVE,
      });

      redisMock.get.mockResolvedValue(null);

      const result1 = await authorizeCampaignJoin(donorContext, 'campaign-1');
      expect(result1).toEqual({ authorized: true });
      expect(redisMock.setex).toHaveBeenCalledWith(
        'ws-auth:user-donor:campaign:campaign-1',
        30,
        '1'
      );

      // Second call should use cache
      redisMock.get.mockResolvedValue('1');
      const result2 = await authorizeCampaignJoin(donorContext, 'campaign-1');
      expect(result2).toEqual({ authorized: true });
      expect(prismaMock.campaign.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('authorizeOrganizationJoin', () => {
    const orgContext: AuthorizationContext = {
      userId: 'user-org',
      userRole: Role.ORGANIZATION,
    };

    const donorContext: AuthorizationContext = {
      userId: 'user-donor',
      userRole: Role.DONOR,
    };

    const adminContext: AuthorizationContext = {
      userId: 'user-admin',
      userRole: Role.ADMIN,
    };

    it('rejects invalid input', async () => {
      const result = await authorizeOrganizationJoin(donorContext, '');
      expect(result).toEqual({ authorized: false, reason: 'invalid_input' });
      expect(prismaMock.organization.findUnique).not.toHaveBeenCalled();
    });

    it('ADMIN can join any organization', async () => {
      const result = await authorizeOrganizationJoin(adminContext, 'org-1');
      expect(result).toEqual({ authorized: true });
      expect(prismaMock.organization.findUnique).not.toHaveBeenCalled();
    });

    it('AUDITOR can join any organization', async () => {
      const auditorContext: AuthorizationContext = {
        userId: 'user-auditor',
        userRole: Role.AUDITOR,
      };
      const result = await authorizeOrganizationJoin(auditorContext, 'org-1');
      expect(result).toEqual({ authorized: true });
      expect(prismaMock.organization.findUnique).not.toHaveBeenCalled();
    });

    it('user can join their own organization', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({
        userId: 'user-org',
      });

      const result = await authorizeOrganizationJoin(orgContext, 'org-1');
      expect(result).toEqual({ authorized: true });
      expect(prismaMock.organization.findUnique).toHaveBeenCalledWith({
        where: { id: 'org-1' },
        select: { userId: true },
      });
    });

    it('user cannot join another organization', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({
        userId: 'other-org',
      });

      const result = await authorizeOrganizationJoin(donorContext, 'org-1');
      expect(result).toEqual({ authorized: false, reason: 'forbidden' });
    });

    it('returns not_found when organization does not exist', async () => {
      prismaMock.organization.findUnique.mockResolvedValue(null);

      const result = await authorizeOrganizationJoin(donorContext, 'org-1');
      expect(result).toEqual({ authorized: false, reason: 'not_found' });
    });

    it('caches authorization results', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({
        userId: 'user-org',
      });

      redisMock.get.mockResolvedValue(null);

      const result1 = await authorizeOrganizationJoin(orgContext, 'org-1');
      expect(result1).toEqual({ authorized: true });
      expect(redisMock.setex).toHaveBeenCalledWith(
        'ws-auth:user-org:organization:org-1',
        30,
        '1'
      );

      // Second call should use cache
      redisMock.get.mockResolvedValue('1');
      const result2 = await authorizeOrganizationJoin(orgContext, 'org-1');
      expect(result2).toEqual({ authorized: true });
      expect(prismaMock.organization.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('authorizeBeneficiaryJoin', () => {
    const beneficiaryContext: AuthorizationContext = {
      userId: 'user-beneficiary',
      userRole: Role.BENEFICIARY,
    };

    const orgContext: AuthorizationContext = {
      userId: 'user-org',
      userRole: Role.ORGANIZATION,
    };

    const donorContext: AuthorizationContext = {
      userId: 'user-donor',
      userRole: Role.DONOR,
    };

    const verifierContext: AuthorizationContext = {
      userId: 'user-verifier',
      userRole: Role.VERIFIER,
    };

    const adminContext: AuthorizationContext = {
      userId: 'user-admin',
      userRole: Role.ADMIN,
    };

    it('rejects invalid input', async () => {
      const result = await authorizeBeneficiaryJoin(donorContext, '');
      expect(result).toEqual({ authorized: false, reason: 'invalid_input' });
      expect(prismaMock.beneficiary.findUnique).not.toHaveBeenCalled();
    });

    it('ADMIN can join any beneficiary room', async () => {
      const result = await authorizeBeneficiaryJoin(adminContext, 'beneficiary-1');
      expect(result).toEqual({ authorized: true });
      expect(prismaMock.beneficiary.findUnique).not.toHaveBeenCalled();
    });

    it('AUDITOR can join any beneficiary room', async () => {
      const auditorContext: AuthorizationContext = {
        userId: 'user-auditor',
        userRole: Role.AUDITOR,
      };
      const result = await authorizeBeneficiaryJoin(auditorContext, 'beneficiary-1');
      expect(result).toEqual({ authorized: true });
      expect(prismaMock.beneficiary.findUnique).not.toHaveBeenCalled();
    });

    it('VERIFIER can join any beneficiary room', async () => {
      const result = await authorizeBeneficiaryJoin(verifierContext, 'beneficiary-1');
      expect(result).toEqual({ authorized: true });
      expect(prismaMock.beneficiary.findUnique).not.toHaveBeenCalled();
    });

    it('beneficiary can join their own room', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue({
        userId: 'user-beneficiary',
      });

      const result = await authorizeBeneficiaryJoin(beneficiaryContext, 'beneficiary-1');
      expect(result).toEqual({ authorized: true });
      expect(prismaMock.beneficiary.findUnique).toHaveBeenCalledWith({
        where: { id: 'beneficiary-1' },
        select: { userId: true },
      });
    });

    it('ORGANIZATION can join beneficiary assigned to their campaign', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue({
        userId: 'other-beneficiary',
      });

      prismaMock.beneficiaryAssignment.findFirst.mockResolvedValue({
        id: 'assignment-1',
      });

      const result = await authorizeBeneficiaryJoin(orgContext, 'beneficiary-1');
      expect(result).toEqual({ authorized: true });
      expect(prismaMock.beneficiaryAssignment.findFirst).toHaveBeenCalledWith({
        where: {
          beneficiaryId: 'beneficiary-1',
          campaign: {
            userId: 'user-org',
          },
        },
      });
    });

    it('DONOR cannot join beneficiary room', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue({
        userId: 'other-beneficiary',
      });

      const result = await authorizeBeneficiaryJoin(donorContext, 'beneficiary-1');
      expect(result).toEqual({ authorized: false, reason: 'forbidden' });
      expect(prismaMock.beneficiaryAssignment.findFirst).not.toHaveBeenCalled();
    });

    it('ORGANIZATION cannot join beneficiary assigned to different org', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue({
        userId: 'other-beneficiary',
      });

      prismaMock.beneficiaryAssignment.findFirst.mockResolvedValue(null);

      const result = await authorizeBeneficiaryJoin(orgContext, 'beneficiary-1');
      expect(result).toEqual({ authorized: false, reason: 'forbidden' });
    });

    it('returns not_found when beneficiary does not exist', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(null);

      const result = await authorizeBeneficiaryJoin(donorContext, 'beneficiary-1');
      expect(result).toEqual({ authorized: false, reason: 'not_found' });
    });

    it('caches authorization results', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue({
        userId: 'user-beneficiary',
      });

      redisMock.get.mockResolvedValue(null);

      const result1 = await authorizeBeneficiaryJoin(beneficiaryContext, 'beneficiary-1');
      expect(result1).toEqual({ authorized: true });
      expect(redisMock.setex).toHaveBeenCalledWith(
        'ws-auth:user-beneficiary:beneficiary:beneficiary-1',
        30,
        '1'
      );

      // Second call should use cache
      redisMock.get.mockResolvedValue('1');
      const result2 = await authorizeBeneficiaryJoin(beneficiaryContext, 'beneficiary-1');
      expect(result2).toEqual({ authorized: true });
      expect(prismaMock.beneficiary.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('invalidateCampaignAuthorizationCache', () => {
    it('invalidates cache entries using scanStream', async () => {
      const mockStream = [['key1', 'key2', 'key3']];
      redisMock.scanStream.mockReturnValue(mockStream);

      await invalidateCampaignAuthorizationCache('campaign-1');

      expect(redisMock.scanStream).toHaveBeenCalledWith({
        match: 'ws-auth:*:campaign:campaign-1',
        count: 100,
      });
      expect(redisMock.del).toHaveBeenCalledWith('key1', 'key2', 'key3');
    });

    it('handles empty scan results', async () => {
      const mockStream = [[]];
      redisMock.scanStream.mockReturnValue(mockStream);

      await invalidateCampaignAuthorizationCache('campaign-1');

      expect(redisMock.del).not.toHaveBeenCalled();
    });

    it('handles Redis errors gracefully', async () => {
      redisMock.scanStream.mockImplementation(() => {
        throw new Error('Redis error');
      });

      await expect(invalidateCampaignAuthorizationCache('campaign-1')).resolves.not.toThrow();
    });
  });
});
