import { Router } from 'express';
import { OrganizationController } from '../controllers/organization.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validation';
import {
  bankAccountSchema,
  bankAccountUpdateSchema,
  organizationSchema,
  organizationUpdateSchema,
  organizationVerificationSchema,
} from '../utils/validation';

const router = Router();

router.use(authenticate);

router.post('/', validate(organizationSchema), OrganizationController.createOrganization);
router.get('/', OrganizationController.getOrganizations);
router.get('/:id', OrganizationController.getOrganizationById);
router.put('/:id', validate(organizationUpdateSchema), OrganizationController.updateOrganization);
router.delete('/:id', OrganizationController.deleteOrganization);

router.post('/:id/bank-accounts', validate(bankAccountSchema), OrganizationController.addBankAccount);
router.get('/:id/bank-accounts', OrganizationController.listBankAccounts);
router.get('/:id/bank-accounts/:accountId', OrganizationController.getBankAccount);
router.put('/:id/bank-accounts/:accountId', validate(bankAccountUpdateSchema), OrganizationController.updateBankAccount);
router.delete('/:id/bank-accounts/:accountId', OrganizationController.deleteBankAccount);
router.post('/:id/bank-accounts/:accountId/verify', OrganizationController.verifyBankAccount);

router.post('/:id/verification', validate(organizationVerificationSchema), OrganizationController.submitVerification);
router.get('/:id/verification', OrganizationController.getVerification);

export default router;
