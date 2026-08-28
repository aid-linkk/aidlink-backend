/**
 * Saga Recovery Worker
 *
 * On startup (and optionally on a periodic interval), queries for non-terminal
 * saga instances (STARTED | STEP_COMPLETED | COMPENSATING) and resumes them.
 *
 * This handles the crash-recovery scenario where:
 *  - The process died mid-saga.
 *  - A transactional step committed but the process crashed before the next step.
 *  - An async step was queued but the process crashed before the step record
 *    was updated to COMPLETED.
 *
 * Recovery strategy per saga name:
 *  - DonationConfirmationSaga  → resume with donationConfirmationSaga definition
 *  - DistributionConfirmationSaga → resume with distributionConfirmationSaga definition
 *  - CampaignSettlementSaga    → resume with campaignSettlementSaga definition
 *
 * Sagas older than MAX_SAGA_AGE_MS that are still non-terminal are considered
 * permanently stuck and are marked FAILED without compensation to avoid
 * re-running very old operations.
 */

import logger from '../config/logger';
import prisma from '../config/database';
import { SagaStatus } from '@prisma/client';
import { SagaOrchestrator, NON_TERMINAL_STATUSES } from '../saga/SagaOrchestrator';
import { SagaDefinition } from '../saga/types';
import { donationConfirmationSaga } from '../saga/sagas/donationConfirmation.saga';
import { distributionConfirmationSaga } from '../saga/sagas/distributionConfirmation.saga';
import { campaignSettlementSaga } from '../saga/sagas/campaignSettlement.saga';

// Sagas that have been non-terminal for longer than this are considered stuck.
const MAX_SAGA_AGE_MS = 24 * 60 * 60_000; // 24 hours

// Periodic check interval for long-running processes
const PERIODIC_INTERVAL_MS = 5 * 60_000; // 5 minutes

const SAGA_REGISTRY: Record<string, SagaDefinition<any, any>> = {
  DonationConfirmationSaga: donationConfirmationSaga,
  DistributionConfirmationSaga: distributionConfirmationSaga,
  CampaignSettlementSaga: campaignSettlementSaga,
};

let recoveryTimer: NodeJS.Timeout | null = null;

/**
 * Run the recovery sweep once.
 * Finds all non-terminal sagas and resumes or expires them.
 */
export async function runSagaRecoverySweep(): Promise<void> {
  logger.info('[SagaRecovery] Starting sweep...');

  const recoverableSagas = await SagaOrchestrator.findRecoverableSagas();

  if (recoverableSagas.length === 0) {
    logger.info('[SagaRecovery] No non-terminal sagas found.');
    return;
  }

  logger.info(`[SagaRecovery] Found ${recoverableSagas.length} non-terminal saga(s).`);

  const now = Date.now();

  for (const instance of recoverableSagas) {
    const sagaAge = now - instance.createdAt.getTime();

    if (sagaAge > MAX_SAGA_AGE_MS) {
      logger.warn(
        `[SagaRecovery] Saga ${instance.id} (${instance.name}) is ${Math.round(sagaAge / 60_000)}m old — marking FAILED (stuck)`,
      );
      await prisma.sagaInstance
        .update({
          where: { id: instance.id },
          data: {
            status: SagaStatus.FAILED,
            error: `Saga exceeded max age (${MAX_SAGA_AGE_MS}ms) without reaching a terminal state`,
          },
        })
        .catch((err) =>
          logger.error(`[SagaRecovery] Failed to mark saga ${instance.id} as FAILED:`, err),
        );
      continue;
    }

    const definition = SAGA_REGISTRY[instance.name];
    if (!definition) {
      logger.warn(
        `[SagaRecovery] Unknown saga name '${instance.name}' for id=${instance.id} — skipping`,
      );
      continue;
    }

    logger.info(
      `[SagaRecovery] Resuming saga id=${instance.id} name=${instance.name} status=${instance.status} currentStep=${instance.currentStep}`,
    );

    try {
      const result = await SagaOrchestrator.resume(instance.id, definition);
      if (result.success) {
        logger.info(`[SagaRecovery] Saga ${instance.id} resumed to COMPLETED`);
      } else {
        logger.warn(
          `[SagaRecovery] Saga ${instance.id} resumed to COMPENSATED/FAILED: ${result.error.message}`,
        );
      }
    } catch (err) {
      logger.error(`[SagaRecovery] Unhandled error resuming saga ${instance.id}:`, err);
    }
  }

  logger.info('[SagaRecovery] Sweep complete.');
}

/**
 * Start the saga recovery worker.
 *
 * Runs once immediately on startup, then on a periodic interval.
 * Call this from src/index.ts after all services are initialised.
 */
export function startSagaRecoveryWorker(): void {
  // Run immediately on startup (best-effort — don't crash the server)
  runSagaRecoverySweep().catch((err) =>
    logger.error('[SagaRecovery] Startup sweep failed:', err),
  );

  // Schedule periodic sweeps to catch sagas that get stuck after startup
  recoveryTimer = setInterval(() => {
    runSagaRecoverySweep().catch((err) =>
      logger.error('[SagaRecovery] Periodic sweep failed:', err),
    );
  }, PERIODIC_INTERVAL_MS);

  logger.info(
    `[SagaRecovery] Worker started (startup sweep + periodic interval: ${PERIODIC_INTERVAL_MS / 60_000}m)`,
  );
}

/**
 * Stop the saga recovery worker (used during graceful shutdown).
 */
export function stopSagaRecoveryWorker(): void {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
    logger.info('[SagaRecovery] Worker stopped.');
  }
}
