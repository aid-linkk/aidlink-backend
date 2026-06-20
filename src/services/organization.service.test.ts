import { OrganizationService } from './organization.service';
import {
  BankAccountVerificationStatus,
  OrganizationStatus,
  OrganizationVerificationStatus,
  Role,
} from '@prisma/client';

jest.mock('../config/database', () => {
  const mock: any = {
    __esModule: true,
    default: {
      organization: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      bankAccount: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      organizationVerificationEvent: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(),
    },
  };
  mock.default.$transaction.mockImplementation(async (cb: any) =>
    typeof cb === 'function' ? cb(mock.default) : Promise.all(cb)
  );
  return mock;
});

jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('./notification.service', () => ({
  NotificationService: {
    sendOrganizationProfileUpdatedNotification: jest.fn().mockResolvedValue(undefined),
    sendOrganizationVerificationSubmittedNotification: jest.fn().mockResolvedValue(undefined),
    sendOrganizationVerificationApprovedNotification: jest.fn().mockResolvedValue(undefined),
    sendOrganizationVerificationRejectedNotification: jest.fn().mockResolvedValue(undefined),
    sendOrganizationVerificationInfoRequestedNotification: jest.fn().mockResolvedValue(undefined),
    sendBankAccountAddedNotification: jest.fn().mockResolvedValue(undefined),
    sendBankAccountReviewRequiredNotification: jest.fn().mockResolvedValue(undefined),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const prismaMock = require('../config/database').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NotificationService } = require('./notification.service');

const owner = { id: 'user-1', role: Role.ORGANIZATION };
const admin = { id: 'admin-1', role: Role.ADMIN };

const baseOrganization = (overrides: any = {}) => ({
  id: 'org-1',
  userId: 'user-1',
  name: 'Aid Org',
  email: 'org@example.com',
  country: 'US',
  registrationNumber: 'REG-1',
  status: OrganizationStatus.PENDING,
  verificationStatus: OrganizationVerificationStatus.UNVERIFIED,
  deletedAt: null,
  user: { id: 'user-1', email: 'owner@example.com' },
  ...overrides,
});

const bankAccountInput = {
  accountHolderName: 'Aid Org',
  accountNumber: '123456789',
  routingCode: '021000021',
  bankName: 'Community Bank',
  currency: 'USD',
};

describe('OrganizationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (cb: any) =>
      typeof cb === 'function' ? cb(prismaMock) : Promise.all(cb)
    );
  });

  it('creates an organization profile for the authenticated owner', async () => {
    prismaMock.organization.findFirst.mockResolvedValue(null);
    prismaMock.organization.create.mockResolvedValue(baseOrganization());

    const organization = await OrganizationService.createOrganization(
      {
        name: 'Aid Org',
        email: 'org@example.com',
        country: 'US',
        registrationNumber: 'REG-1',
        representativeContact: { name: 'Rep' },
      },
      owner
    );

    expect(organization.id).toBe('org-1');
    expect(prismaMock.organization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          verificationStatus: OrganizationVerificationStatus.UNVERIFIED,
        }),
      })
    );
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
  });

  it('rejects unrelated users from managing another organization', async () => {
    prismaMock.organization.findFirst.mockResolvedValue(baseOrganization());

    await expect(
      OrganizationService.updateOrganization('org-1', { name: 'New Name' }, { id: 'stranger', role: Role.DONOR })
    ).rejects.toThrow('You do not have permission');

    expect(prismaMock.organization.update).not.toHaveBeenCalled();
  });

  it('updates organization profiles and sends a notification', async () => {
    prismaMock.organization.findFirst.mockResolvedValue(baseOrganization());
    prismaMock.organization.update.mockResolvedValue(baseOrganization({ name: 'New Name' }));

    const result = await OrganizationService.updateOrganization('org-1', { name: 'New Name' }, owner);

    expect(result.name).toBe('New Name');
    expect(NotificationService.sendOrganizationProfileUpdatedNotification).toHaveBeenCalledWith(
      'user-1',
      'New Name'
    );
  });

  it('adds and archives bank accounts for organization owners', async () => {
    prismaMock.organization.findFirst.mockResolvedValue(baseOrganization());
    prismaMock.bankAccount.create.mockResolvedValue({ id: 'ba-1', ...bankAccountInput });
    prismaMock.bankAccount.findFirst.mockResolvedValue({ id: 'ba-1', organizationId: 'org-1' });
    prismaMock.bankAccount.update.mockResolvedValue({
      id: 'ba-1',
      archivedAt: new Date(),
      verificationStatus: BankAccountVerificationStatus.ARCHIVED,
    });

    const created = await OrganizationService.addBankAccount('org-1', bankAccountInput, owner);
    expect(created.id).toBe('ba-1');
    expect(NotificationService.sendBankAccountAddedNotification).toHaveBeenCalled();

    const archived = await OrganizationService.deleteBankAccount('org-1', 'ba-1', owner);
    expect(archived.verificationStatus).toBe(BankAccountVerificationStatus.ARCHIVED);
  });

  it('submits verification packages and records verification history', async () => {
    prismaMock.organization.findFirst.mockResolvedValue(baseOrganization());
    prismaMock.organization.update.mockResolvedValue(
      baseOrganization({ verificationStatus: OrganizationVerificationStatus.PENDING_VERIFICATION })
    );

    const result = await OrganizationService.submitVerification('org-1', owner, {
      registrationDocs: ['https://example.com/reg.pdf'],
      taxId: 'TAX-1',
      representativeId: 'https://example.com/id.pdf',
      bankVerificationInfo: { bankAccountId: 'ba-1' },
      notes: 'ready',
    });

    expect(result.verificationStatus).toBe(OrganizationVerificationStatus.PENDING_VERIFICATION);
    expect(prismaMock.organizationVerificationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org-1',
          status: OrganizationVerificationStatus.PENDING_VERIFICATION,
        }),
      })
    );
    expect(NotificationService.sendOrganizationVerificationSubmittedNotification).toHaveBeenCalled();
  });

  it('allows admins to approve verification and updates organization status', async () => {
    prismaMock.organization.findFirst.mockResolvedValue(
      baseOrganization({ verificationStatus: OrganizationVerificationStatus.PENDING_VERIFICATION })
    );
    prismaMock.organization.update.mockResolvedValue(
      baseOrganization({
        status: OrganizationStatus.APPROVED,
        verificationStatus: OrganizationVerificationStatus.VERIFIED,
      })
    );

    const result = await OrganizationService.approveVerification('org-1', admin, 'approved');

    expect(result.status).toBe(OrganizationStatus.APPROVED);
    expect(result.verificationStatus).toBe(OrganizationVerificationStatus.VERIFIED);
    expect(prismaMock.organizationVerificationEvent.create).toHaveBeenCalled();
    expect(NotificationService.sendOrganizationVerificationApprovedNotification).toHaveBeenCalledWith(
      'user-1',
      'Aid Org'
    );
  });

  it('prevents non-admins from reviewing verification', async () => {
    await expect(
      OrganizationService.rejectVerification('org-1', owner, 'missing docs')
    ).rejects.toThrow('Admin access required');

    expect(prismaMock.organization.update).not.toHaveBeenCalled();
  });
});
