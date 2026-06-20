import { Response, NextFunction } from 'express';
import { OrganizationService } from '../services/organization.service';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import { OrganizationStatus, OrganizationVerificationStatus } from '@prisma/client';

export class OrganizationController {
  private static actor(req: AuthRequest) {
    if (!req.user) {
      throw new AppError('Authentication required', 401);
    }
    return { id: req.user.id, role: req.user.role };
  }

  static async createOrganization(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const organization = await OrganizationService.createOrganization(
        req.body,
        OrganizationController.actor(req)
      );
      res.status(201).json({ success: true, data: organization, message: 'Organization created successfully' });
    } catch (error) {
      next(error);
    }
  }

  static async getOrganizations(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await OrganizationService.listOrganizations(
        {
          status: req.query.status as OrganizationStatus | undefined,
          verificationStatus: req.query.verificationStatus as OrganizationVerificationStatus | undefined,
          country: req.query.country as string | undefined,
          search: req.query.search as string | undefined,
        },
        {
          page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
          limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
          sortOrder: (req.query.sortOrder as 'asc' | 'desc') || 'desc',
        },
        OrganizationController.actor(req)
      );
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  static async getOrganizationById(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const organization = await OrganizationService.getOrganizationById(
        req.params.id,
        OrganizationController.actor(req)
      );
      res.status(200).json({ success: true, data: organization });
    } catch (error) {
      next(error);
    }
  }

  static async updateOrganization(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const organization = await OrganizationService.updateOrganization(
        req.params.id,
        req.body,
        OrganizationController.actor(req)
      );
      res.status(200).json({ success: true, data: organization, message: 'Organization updated successfully' });
    } catch (error) {
      next(error);
    }
  }

  static async deleteOrganization(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const organization = await OrganizationService.deleteOrganization(
        req.params.id,
        OrganizationController.actor(req)
      );
      res.status(200).json({ success: true, data: organization, message: 'Organization archived successfully' });
    } catch (error) {
      next(error);
    }
  }

  static async addBankAccount(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const bankAccount = await OrganizationService.addBankAccount(
        req.params.id,
        req.body,
        OrganizationController.actor(req)
      );
      res.status(201).json({ success: true, data: bankAccount, message: 'Bank account added successfully' });
    } catch (error) {
      next(error);
    }
  }

  static async listBankAccounts(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const bankAccounts = await OrganizationService.listBankAccounts(
        req.params.id,
        OrganizationController.actor(req)
      );
      res.status(200).json({ success: true, data: bankAccounts });
    } catch (error) {
      next(error);
    }
  }

  static async getBankAccount(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const bankAccount = await OrganizationService.getBankAccount(
        req.params.id,
        req.params.accountId,
        OrganizationController.actor(req)
      );
      res.status(200).json({ success: true, data: bankAccount });
    } catch (error) {
      next(error);
    }
  }

  static async updateBankAccount(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const bankAccount = await OrganizationService.updateBankAccount(
        req.params.id,
        req.params.accountId,
        req.body,
        OrganizationController.actor(req)
      );
      res.status(200).json({ success: true, data: bankAccount, message: 'Bank account updated successfully' });
    } catch (error) {
      next(error);
    }
  }

  static async deleteBankAccount(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const bankAccount = await OrganizationService.deleteBankAccount(
        req.params.id,
        req.params.accountId,
        OrganizationController.actor(req)
      );
      res.status(200).json({ success: true, data: bankAccount, message: 'Bank account archived successfully' });
    } catch (error) {
      next(error);
    }
  }

  static async verifyBankAccount(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const bankAccount = await OrganizationService.requestBankAccountVerification(
        req.params.id,
        req.params.accountId,
        OrganizationController.actor(req)
      );
      res.status(200).json({ success: true, data: bankAccount, message: 'Bank account verification requested' });
    } catch (error) {
      next(error);
    }
  }

  static async submitVerification(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const organization = await OrganizationService.submitVerification(
        req.params.id,
        OrganizationController.actor(req),
        req.body
      );
      res.status(201).json({ success: true, data: organization, message: 'Verification submitted successfully' });
    } catch (error) {
      next(error);
    }
  }

  static async getVerification(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const verification = await OrganizationService.getVerification(
        req.params.id,
        OrganizationController.actor(req)
      );
      res.status(200).json({ success: true, data: verification });
    } catch (error) {
      next(error);
    }
  }

  static async approveVerification(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const organization = await OrganizationService.approveVerification(
        req.params.id,
        OrganizationController.actor(req),
        req.body.notes
      );
      res.status(200).json({ success: true, data: organization, message: 'Organization verification approved' });
    } catch (error) {
      next(error);
    }
  }

  static async rejectVerification(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const organization = await OrganizationService.rejectVerification(
        req.params.id,
        OrganizationController.actor(req),
        req.body.reason
      );
      res.status(200).json({ success: true, data: organization, message: 'Organization verification rejected' });
    } catch (error) {
      next(error);
    }
  }

  static async requestMoreInfo(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const organization = await OrganizationService.requestMoreInfo(
        req.params.id,
        OrganizationController.actor(req),
        req.body.reason
      );
      res.status(200).json({ success: true, data: organization, message: 'Additional information requested' });
    } catch (error) {
      next(error);
    }
  }
}
