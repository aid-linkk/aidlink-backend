import prisma from '../config/database';
import {
  AuditAction,
  BankAccountVerificationStatus,
  OrganizationStatus,
  OrganizationVerificationStatus,
  Role,
} from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { NotificationService } from './notification.service';

export interface Actor {
  id: string;
  role: Role;
}

export interface OrganizationInput {
  userId?: string;
  name: string;
  email: string;
  country: string;
  registrationNumber: string;
  representativeContact: any;
  website?: string;
  description?: string;
  address?: any;
  taxId?: string;
  legalDocuments?: any;
  supportingMetadata?: any;
}

export interface BankAccountInput {
  accountHolderName: string;
  accountNumber: string;
  routingCode: string;
  iban?: string;
  bankName: string;
  currency: string;
  branchCode?: string;
  country?: string;
  accountType?: string;
  isPrimary?: boolean;
  metadata?: any;
}

export class OrganizationService {
  private static isAdmin(actor: Actor): boolean {
    return actor.role === Role.ADMIN;
  }

  private static async assertOrganizationAccess(
    organizationId: string,
    actor: Actor
  ): Promise<any> {
    const organization = await prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      include: { user: { select: { id: true, email: true } } },
    });

    if (!organization) {
      throw new AppError('Organization not found', 404);
    }

    if (!this.isAdmin(actor) && organization.userId !== actor.id) {
      throw new AppError('You do not have permission to manage this organization', 403);
    }

    return organization;
  }

  private static async writeAudit(
    action: AuditAction,
    entityType: string,
    entityId: string,
    actorId?: string,
    changes?: any
  ): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: { userId: actorId, action, entityType, entityId, changes },
      });
    } catch (error) {
      logger.error('Failed to write organization audit log:', error);
    }
  }

  private static async notify(
    fn: () => Promise<void>,
    context: string
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      logger.error(`Failed to send organization notification (${context}):`, error);
    }
  }

  static async createOrganization(input: OrganizationInput, actor: Actor): Promise<any> {
    const ownerId = this.isAdmin(actor) && input.userId ? input.userId : actor.id;

    const existing = await prisma.organization.findFirst({
      where: { userId: ownerId, deletedAt: null },
    });
    if (existing) {
      throw new AppError('User already has an organization profile', 409);
    }

    const organization = await prisma.organization.create({
      data: {
        userId: ownerId,
        name: input.name.trim(),
        email: input.email,
        country: input.country,
        registrationNumber: input.registrationNumber,
        representativeContact: input.representativeContact,
        website: input.website,
        description: input.description,
        address: input.address,
        taxId: input.taxId,
        legalDocuments: input.legalDocuments,
        supportingMetadata: input.supportingMetadata,
        status: OrganizationStatus.PENDING,
        verificationStatus: OrganizationVerificationStatus.UNVERIFIED,
      },
    });

    await this.writeAudit(
      AuditAction.ORGANIZATION_CREATED,
      'Organization',
      organization.id,
      actor.id,
      { ownerId }
    );

    return organization;
  }

  static async listOrganizations(
    filters: { status?: OrganizationStatus; verificationStatus?: OrganizationVerificationStatus; country?: string; search?: string },
    pagination: { page?: number; limit?: number; sortOrder?: 'asc' | 'desc' },
    actor: Actor
  ): Promise<any> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;
    const skip = (page - 1) * limit;
    const where: any = { deletedAt: null };

    if (!this.isAdmin(actor)) where.userId = actor.id;
    if (filters.status) where.status = filters.status;
    if (filters.verificationStatus) where.verificationStatus = filters.verificationStatus;
    if (filters.country) where.country = filters.country;
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
        { registrationNumber: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const [organizations, total] = await Promise.all([
      prisma.organization.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: pagination.sortOrder ?? 'desc' },
        include: {
          bankAccounts: { where: { archivedAt: null }, select: { id: true, bankName: true, currency: true, verificationStatus: true, isPrimary: true } },
        },
      }),
      prisma.organization.count({ where }),
    ]);

    return {
      data: organizations,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  static async getOrganizationById(id: string, actor: Actor): Promise<any> {
    await this.assertOrganizationAccess(id, actor);

    return prisma.organization.findFirst({
      where: { id, deletedAt: null },
      include: {
        bankAccounts: { where: { archivedAt: null } },
        verificationEvents: { orderBy: { createdAt: 'desc' } },
      },
    });
  }

  static async updateOrganization(
    id: string,
    input: Partial<OrganizationInput>,
    actor: Actor
  ): Promise<any> {
    await this.assertOrganizationAccess(id, actor);

    const organization = await prisma.organization.update({
      where: { id },
      data: {
        name: input.name?.trim(),
        email: input.email,
        country: input.country,
        registrationNumber: input.registrationNumber,
        representativeContact: input.representativeContact,
        website: input.website,
        description: input.description,
        address: input.address,
        taxId: input.taxId,
        legalDocuments: input.legalDocuments,
        supportingMetadata: input.supportingMetadata,
      },
    });

    await this.writeAudit(AuditAction.ORGANIZATION_UPDATED, 'Organization', id, actor.id, input);
    await this.notify(
      () => NotificationService.sendOrganizationProfileUpdatedNotification(organization.userId, organization.name),
      'profile-updated'
    );

    return organization;
  }

  static async deleteOrganization(id: string, actor: Actor): Promise<any> {
    await this.assertOrganizationAccess(id, actor);

    const organization = await prisma.organization.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: OrganizationStatus.SUSPENDED,
        verificationStatus: OrganizationVerificationStatus.SUSPENDED,
      },
    });

    await this.writeAudit(AuditAction.ORGANIZATION_DELETED, 'Organization', id, actor.id);
    return organization;
  }

  static async addBankAccount(
    organizationId: string,
    input: BankAccountInput,
    actor: Actor
  ): Promise<any> {
    const organization = await this.assertOrganizationAccess(organizationId, actor);

    const bankAccount = await prisma.bankAccount.create({
      data: {
        organizationId,
        accountHolderName: input.accountHolderName,
        accountNumber: input.accountNumber,
        routingNumber: input.routingCode,
        routingCode: input.routingCode,
        iban: input.iban,
        bankName: input.bankName,
        currency: input.currency,
        branchCode: input.branchCode,
        country: input.country,
        accountType: input.accountType ?? 'CHECKING',
        isPrimary: input.isPrimary ?? false,
        metadata: input.metadata,
      },
    });

    await this.writeAudit(AuditAction.BANK_ACCOUNT_CREATED, 'BankAccount', bankAccount.id, actor.id, {
      organizationId,
    });
    await this.notify(
      () => NotificationService.sendBankAccountAddedNotification(organization.userId, organization.name, input.bankName),
      'bank-account-added'
    );

    return bankAccount;
  }

  static async listBankAccounts(organizationId: string, actor: Actor): Promise<any[]> {
    await this.assertOrganizationAccess(organizationId, actor);
    return prisma.bankAccount.findMany({
      where: { organizationId, archivedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async getBankAccount(
    organizationId: string,
    accountId: string,
    actor: Actor
  ): Promise<any> {
    await this.assertOrganizationAccess(organizationId, actor);

    const bankAccount = await prisma.bankAccount.findFirst({
      where: { id: accountId, organizationId, archivedAt: null },
    });
    if (!bankAccount) {
      throw new AppError('Bank account not found', 404);
    }
    return bankAccount;
  }

  static async updateBankAccount(
    organizationId: string,
    accountId: string,
    input: Partial<BankAccountInput>,
    actor: Actor
  ): Promise<any> {
    await this.getBankAccount(organizationId, accountId, actor);

    const bankAccount = await prisma.bankAccount.update({
      where: { id: accountId },
      data: {
        accountHolderName: input.accountHolderName,
        accountNumber: input.accountNumber,
        routingNumber: input.routingCode,
        routingCode: input.routingCode,
        iban: input.iban,
        bankName: input.bankName,
        currency: input.currency,
        branchCode: input.branchCode,
        country: input.country,
        accountType: input.accountType,
        isPrimary: input.isPrimary,
        metadata: input.metadata,
        verificationStatus: BankAccountVerificationStatus.UNVERIFIED,
        verifiedAt: null,
      },
    });

    await this.writeAudit(AuditAction.BANK_ACCOUNT_UPDATED, 'BankAccount', accountId, actor.id, {
      organizationId,
    });
    return bankAccount;
  }

  static async deleteBankAccount(
    organizationId: string,
    accountId: string,
    actor: Actor
  ): Promise<any> {
    await this.getBankAccount(organizationId, accountId, actor);

    const bankAccount = await prisma.bankAccount.update({
      where: { id: accountId },
      data: {
        archivedAt: new Date(),
        verificationStatus: BankAccountVerificationStatus.ARCHIVED,
      },
    });

    await this.writeAudit(AuditAction.BANK_ACCOUNT_DELETED, 'BankAccount', accountId, actor.id, {
      organizationId,
    });
    return bankAccount;
  }

  static async requestBankAccountVerification(
    organizationId: string,
    accountId: string,
    actor: Actor
  ): Promise<any> {
    const organization = await this.assertOrganizationAccess(organizationId, actor);
    await this.getBankAccount(organizationId, accountId, actor);

    const bankAccount = await prisma.bankAccount.update({
      where: { id: accountId },
      data: { verificationStatus: BankAccountVerificationStatus.PENDING_VERIFICATION },
    });

    await this.writeAudit(
      AuditAction.BANK_ACCOUNT_VERIFICATION_REQUESTED,
      'BankAccount',
      accountId,
      actor.id,
      { organizationId }
    );
    await this.notify(
      () => NotificationService.sendBankAccountReviewRequiredNotification(organization.userId, organization.name),
      'bank-account-review'
    );

    return bankAccount;
  }

  static async submitVerification(
    organizationId: string,
    actor: Actor,
    payload: { registrationDocs: string[]; taxId: string; representativeId: string; bankVerificationInfo: any; notes?: string }
  ): Promise<any> {
    await this.assertOrganizationAccess(organizationId, actor);

    const updated = await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.update({
        where: { id: organizationId },
        data: {
          taxId: payload.taxId,
          verificationStatus: OrganizationVerificationStatus.PENDING_VERIFICATION,
          verificationRequestedAt: new Date(),
          verificationNotes: payload.notes,
          legalDocuments: { registrationDocs: payload.registrationDocs, representativeId: payload.representativeId },
          supportingMetadata: { bankVerificationInfo: payload.bankVerificationInfo },
        },
      });

      await tx.organizationVerificationEvent.create({
        data: {
          organizationId,
          actorId: actor.id,
          status: OrganizationVerificationStatus.PENDING_VERIFICATION,
          reason: payload.notes,
          evidence: {
            registrationDocs: payload.registrationDocs,
            representativeId: payload.representativeId,
            bankVerificationInfo: payload.bankVerificationInfo,
          },
        },
      });

      return organization;
    });

    await this.writeAudit(
      AuditAction.ORGANIZATION_VERIFICATION_SUBMITTED,
      'Organization',
      organizationId,
      actor.id
    );
    await this.notify(
      () => NotificationService.sendOrganizationVerificationSubmittedNotification(updated.userId, updated.name),
      'verification-submitted'
    );

    return updated;
  }

  static async getVerification(organizationId: string, actor: Actor): Promise<any> {
    const organization = await this.assertOrganizationAccess(organizationId, actor);
    const history = await prisma.organizationVerificationEvent.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      organizationId,
      status: organization.verificationStatus,
      verificationRequestedAt: organization.verificationRequestedAt,
      verifiedAt: organization.verifiedAt,
      verificationNotes: organization.verificationNotes,
      history,
    };
  }

  static async approveVerification(
    organizationId: string,
    admin: Actor,
    notes?: string
  ): Promise<any> {
    this.requireAdmin(admin);
    return this.reviewVerification(
      organizationId,
      admin,
      OrganizationVerificationStatus.VERIFIED,
      OrganizationStatus.APPROVED,
      AuditAction.ORGANIZATION_VERIFICATION_APPROVED,
      notes
    );
  }

  static async rejectVerification(
    organizationId: string,
    admin: Actor,
    reason: string
  ): Promise<any> {
    this.requireAdmin(admin);
    return this.reviewVerification(
      organizationId,
      admin,
      OrganizationVerificationStatus.REJECTED,
      OrganizationStatus.REJECTED,
      AuditAction.ORGANIZATION_VERIFICATION_REJECTED,
      reason
    );
  }

  static async requestMoreInfo(
    organizationId: string,
    admin: Actor,
    reason: string
  ): Promise<any> {
    this.requireAdmin(admin);
    return this.reviewVerification(
      organizationId,
      admin,
      OrganizationVerificationStatus.MORE_INFO_REQUESTED,
      OrganizationStatus.PENDING,
      AuditAction.ORGANIZATION_VERIFICATION_INFO_REQUESTED,
      reason
    );
  }

  private static requireAdmin(actor: Actor): void {
    if (!this.isAdmin(actor)) {
      throw new AppError('Admin access required', 403);
    }
  }

  private static async reviewVerification(
    organizationId: string,
    admin: Actor,
    verificationStatus: OrganizationVerificationStatus,
    status: OrganizationStatus,
    auditAction: AuditAction,
    reason?: string
  ): Promise<any> {
    this.requireAdmin(admin);

    const organization = await prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
    });
    if (!organization) {
      throw new AppError('Organization not found', 404);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const reviewed = await tx.organization.update({
        where: { id: organizationId },
        data: {
          status,
          verificationStatus,
          verifiedAt: verificationStatus === OrganizationVerificationStatus.VERIFIED ? new Date() : null,
          verificationNotes: reason,
        },
      });

      await tx.organizationVerificationEvent.create({
        data: {
          organizationId,
          actorId: admin.id,
          status: verificationStatus,
          reason,
        },
      });

      return reviewed;
    });

    await this.writeAudit(auditAction, 'Organization', organizationId, admin.id, {
      status,
      verificationStatus,
      reason,
    });

    if (verificationStatus === OrganizationVerificationStatus.VERIFIED) {
      await this.notify(
        () => NotificationService.sendOrganizationVerificationApprovedNotification(updated.userId, updated.name),
        'verification-approved'
      );
    } else if (verificationStatus === OrganizationVerificationStatus.REJECTED) {
      await this.notify(
        () => NotificationService.sendOrganizationVerificationRejectedNotification(updated.userId, updated.name, reason ?? 'Not specified'),
        'verification-rejected'
      );
    } else {
      await this.notify(
        () => NotificationService.sendOrganizationVerificationInfoRequestedNotification(updated.userId, updated.name, reason ?? 'Additional information required'),
        'verification-more-info'
      );
    }

    return updated;
  }
}
