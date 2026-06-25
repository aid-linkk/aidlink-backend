import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { PledgeService } from '../services/pledge.service';
import { createPledgeController } from '../controllers/pledge.controller';

/**
 * @notice Creates pledge router with injected dependencies
 */
export function createPledgeRouter(prisma: PrismaClient): Router {
  const router = Router();
  const pledgeService = new PledgeService(prisma);
  const controller = createPledgeController(pledgeService);

  // Donor endpoints
  router.post('/', controller.createPledge);
  router.get('/', controller.listPledges);
  router.get('/:id', controller.getPledge);
  router.post('/:id/cancel', controller.cancelPledge);

  return router;
}

/**
 * @notice Creates admin pledge router
 */
export function createAdminPledgeRouter(prisma: PrismaClient): Router {
  const router = Router();
  const pledgeService = new PledgeService(prisma);
  const controller = createPledgeController(pledgeService);

  router.get('/', controller.adminListPledges);
  router.post('/:id/pause', controller.adminPausePledge);
  router.get('/:id/attempts', controller.adminListAttempts);

  return router;
}