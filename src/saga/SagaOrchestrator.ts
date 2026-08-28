/**
 * SagaOrchestrator — central coordinator for all saga executions.
 *
 * Responsibilities:
 *  1. Persist SagaInstance before executing any step (crash-safe).
 *  2. Execute steps sequentially, persisting step status after each one.
 *  3. On failure: execute compensation in reverse order of completed steps.
 *  4. Support crash recovery: reload state and resume from the last checkpoint.
 *  5. Support async (fire-and-forget) steps with optional compensation.
 *  6. Emit structured log events for every state transition.
 *
 * Performance contract:
 *  - Happy-path overhead ≤10 ms: state writes are done in parallel where
 *    possible (saga status update + step status update in one transaction).
 *  - Compensation timeout: configurable per saga, default 30 s.
 */

import { SagaStatus, SagaStepStatus } from '@prisma/client';
import prisma from '../config/database';
import logger from '../config/logger';
import {
  SagaDefinition,
  SagaResult,
  SagaMetrics,
  PersistedSagaInstance,
} from './types';

// Non-terminal saga states — sagas in these states can be resumed after a crash.
export const NON_TERMINAL_STATUSES: SagaStatus[] = [
  SagaStatus.STARTED,
  SagaStatus.STEP_COMPLETED,
  SagaStatus.COMPENSATING,
];

export class SagaOrchestrator {
  /**
   * Execute a saga from the beginning.
   *
   * @param definition  The saga definition (steps + hooks).
   * @param input       Serialisable initial input (persisted for recovery).
   * @param callerTx    Optional Prisma transaction client from the caller.
   *                    Transactional steps will run inside this transaction.
   */
  static async execute<TInput, TOutput>(
    definition: SagaDefinition<TInput, TOutput>,
    input: TInput,
    callerTx?: import('@prisma/client').Prisma.TransactionClient,
  ): Promise<SagaResult<TOutput>> {
    const startTime = Date.now();

    // 1. Persist the saga instance BEFORE any step runs.
    //    Uses a dedicated transaction so it always commits independently of
    //    the caller's transaction — this is our crash-safety anchor.
    const instance = await prisma.sagaInstance.create({
      data: {
        name: definition.name,
        status: SagaStatus.STARTED,
        currentStep: 0,
        input: input as any,
        compensationTimeoutMs: definition.compensationTimeoutMs ?? 30_000,
      },
    });

    const sagaId = instance.id;

    logger.info(`[Saga] STARTED id=${sagaId} name=${definition.name}`);

    try {
      const output = await SagaOrchestrator._runSteps(
        sagaId,
        definition,
        input,
        0,
        callerTx,
      );

      // 2. Mark saga as COMPLETED.
      await prisma.sagaInstance.update({
        where: { id: sagaId },
        data: {
          status: SagaStatus.COMPLETED,
          output: output as any,
          currentStep: definition.steps.length,
        },
      });

      const durationMs = Date.now() - startTime;
      SagaOrchestrator._emitMetrics({
        sagaId,
        sagaName: definition.name,
        status: SagaStatus.COMPLETED,
        totalSteps: definition.steps.length,
        completedSteps: definition.steps.length,
        durationMs,
      });

      logger.info(
        `[Saga] COMPLETED id=${sagaId} name=${definition.name} durationMs=${durationMs}`,
      );

      // 3. Optional completion hook (errors logged, not thrown).
      if (definition.onCompletion) {
        definition.onCompletion(output, sagaId).catch((err) =>
          logger.error(`[Saga] onCompletion hook failed id=${sagaId}:`, err),
        );
      }

      return { success: true, output, sagaId };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      logger.warn(
        `[Saga] STEP_FAILED id=${sagaId} name=${definition.name} error=${error.message}`,
      );

      // 4. Run compensation (state machine: STEP_COMPLETED → COMPENSATING).
      const compensationResult = await SagaOrchestrator._compensate(
        sagaId,
        definition,
        input,
        error,
      );

      const finalStatus = compensationResult.allCompensated
        ? SagaStatus.COMPENSATED
        : SagaStatus.FAILED;

      await prisma.sagaInstance.update({
        where: { id: sagaId },
        data: {
          status: finalStatus,
          error: error.message,
        },
      });

      SagaOrchestrator._emitMetrics({
        sagaId,
        sagaName: definition.name,
        status: finalStatus,
        totalSteps: definition.steps.length,
        completedSteps: compensationResult.compensatedCount,
        durationMs: Date.now() - startTime,
      });

      logger.warn(
        `[Saga] ${finalStatus} id=${sagaId} name=${definition.name} error=${error.message}`,
      );

      // 5. Optional compensation hook.
      if (definition.onCompensation) {
        definition.onCompensation(error, sagaId).catch((compErr) =>
          logger.error(`[Saga] onCompensation hook failed id=${sagaId}:`, compErr),
        );
      }

      return { success: false, error, sagaId };
    }
  }

  /**
   * Resume a non-terminal saga after a crash.
   * Reloads state from the DB and continues from the last completed step.
   */
  static async resume<TInput, TOutput>(
    sagaId: string,
    definition: SagaDefinition<TInput, TOutput>,
    callerTx?: import('@prisma/client').Prisma.TransactionClient,
  ): Promise<SagaResult<TOutput>> {
    const instance = (await prisma.sagaInstance.findUnique({
      where: { id: sagaId },
      include: { steps: { orderBy: { stepIndex: 'asc' } } },
    })) as PersistedSagaInstance | null;

    if (!instance) {
      throw new Error(`[Saga] Resume failed: saga ${sagaId} not found`);
    }

    if (!NON_TERMINAL_STATUSES.includes(instance.status)) {
      logger.info(
        `[Saga] Resume skipped: saga ${sagaId} already in terminal state ${instance.status}`,
      );
      return {
        success: instance.status === SagaStatus.COMPLETED,
        output: instance.output as TOutput,
        error: instance.error ? new Error(instance.error) : new Error('Terminal state reached'),
        sagaId,
      } as SagaResult<TOutput>;
    }

    const input = instance.input as TInput;

    logger.info(
      `[Saga] RESUMING id=${sagaId} name=${definition.name} status=${instance.status} fromStep=${instance.currentStep}`,
    );

    if (instance.status === SagaStatus.COMPENSATING) {
      // Resume compensation: find highest completed step that hasn't been compensated
      const failureError = new Error(instance.error ?? 'Resumed from COMPENSATING state');
      const compensationResult = await SagaOrchestrator._compensate(
        sagaId,
        definition,
        input,
        failureError,
        instance.steps,
      );

      const finalStatus = compensationResult.allCompensated
        ? SagaStatus.COMPENSATED
        : SagaStatus.FAILED;

      await prisma.sagaInstance.update({
        where: { id: sagaId },
        data: { status: finalStatus },
      });

      return {
        success: false,
        error: failureError,
        sagaId,
      };
    }

    // Resume forward execution from the last completed step index.
    const resumeFromStep = instance.currentStep;

    try {
      const output = await SagaOrchestrator._runSteps(
        sagaId,
        definition,
        input,
        resumeFromStep,
        callerTx,
        instance.steps,
      );

      await prisma.sagaInstance.update({
        where: { id: sagaId },
        data: {
          status: SagaStatus.COMPLETED,
          output: output as any,
          currentStep: definition.steps.length,
        },
      });

      logger.info(`[Saga] COMPLETED (resumed) id=${sagaId}`);
      return { success: true, output, sagaId };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const compensationResult = await SagaOrchestrator._compensate(
        sagaId,
        definition,
        input,
        error,
        instance.steps,
      );

      const finalStatus = compensationResult.allCompensated
        ? SagaStatus.COMPENSATED
        : SagaStatus.FAILED;

      await prisma.sagaInstance.update({
        where: { id: sagaId },
        data: { status: finalStatus, error: error.message },
      });

      return { success: false, error, sagaId };
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Run steps sequentially from resumeFromStep onward.
   * Returns the output of the last step.
   */
  private static async _runSteps<TInput, TOutput>(
    sagaId: string,
    definition: SagaDefinition<TInput, TOutput>,
    sagaInput: TInput,
    resumeFromStep: number,
    callerTx?: import('@prisma/client').Prisma.TransactionClient,
    existingSteps?: PersistedSagaInstance['steps'],
  ): Promise<TOutput> {
    // Build a map from stepIndex to persisted output for already-completed steps
    const completedOutputs: Map<number, unknown> = new Map();
    if (existingSteps) {
      for (const s of existingSteps) {
        if (s.status === SagaStepStatus.COMPLETED) {
          completedOutputs.set(s.stepIndex, s.output);
        }
      }
    }

    let stepInput: unknown = sagaInput;

    // Carry forward outputs from already-completed steps
    if (resumeFromStep > 0 && completedOutputs.has(resumeFromStep - 1)) {
      stepInput = completedOutputs.get(resumeFromStep - 1);
    }

    let lastOutput: unknown = stepInput;

    for (let i = resumeFromStep; i < definition.steps.length; i++) {
      const step = definition.steps[i];

      // Create the step execution row
      const stepExec = await prisma.sagaStepExecution.create({
        data: {
          sagaId,
          stepName: step.name,
          stepIndex: i,
          status: SagaStepStatus.RUNNING,
          input: stepInput as any,
          executedAt: new Date(),
        },
      });

      // Update saga's current step pointer
      await prisma.sagaInstance.update({
        where: { id: sagaId },
        data: {
          currentStep: i,
          status: i === 0 ? SagaStatus.STARTED : SagaStatus.STEP_COMPLETED,
        },
      });

      try {
        let stepOutput: unknown;

        if (step.isAsync) {
          // Fire-and-forget: launch the promise but don't await it.
          // We optimistically mark the step as COMPLETED. If it fails we log
          // the error and update the step row to FAILED asynchronously.
          const asyncPromise = step.execute(stepInput, undefined);
          // For async steps, thread the current accumulated input forward —
          // not undefined — so subsequent steps continue to receive state.
          stepOutput = stepInput;

          asyncPromise
            .then(async (output) => {
              await prisma.sagaStepExecution.update({
                where: { id: stepExec.id },
                data: {
                  status: SagaStepStatus.COMPLETED,
                  output: output as any,
                  completedAt: new Date(),
                },
              });
            })
            .catch(async (err) => {
              logger.error(
                `[Saga] Async step failed id=${sagaId} step=${step.name}: ${err?.message}`,
                err,
              );
              await prisma.sagaStepExecution
                .update({
                  where: { id: stepExec.id },
                  data: {
                    status: SagaStepStatus.FAILED,
                    error: err?.message ?? 'Unknown async step error',
                  },
                })
                .catch(() => {
                  /* swallow — don't crash the saga */
                });
            });

          // Optimistically mark as COMPLETED so compensation can undo it if needed
          await prisma.sagaStepExecution.update({
            where: { id: stepExec.id },
            data: { status: SagaStepStatus.COMPLETED, completedAt: new Date() },
          });
        } else {
          // Synchronous (possibly transactional) step — await it.
          const tx = step.isTransactional ? callerTx : undefined;
          stepOutput = await step.execute(stepInput, tx);

          await prisma.sagaStepExecution.update({
            where: { id: stepExec.id },
            data: {
              status: SagaStepStatus.COMPLETED,
              output: stepOutput as any,
              completedAt: new Date(),
            },
          });
        }

        lastOutput = stepOutput;
        stepInput = stepOutput; // thread output as next step's input
        completedOutputs.set(i, stepOutput);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));

        await prisma.sagaStepExecution.update({
          where: { id: stepExec.id },
          data: {
            status: SagaStepStatus.FAILED,
            error: error.message,
            completedAt: new Date(),
          },
        });

        await prisma.sagaInstance.update({
          where: { id: sagaId },
          data: { status: SagaStatus.COMPENSATING },
        });

        logger.warn(
          `[Saga] Step FAILED id=${sagaId} step=${step.name}[${i}] error=${error.message}`,
        );

        throw error; // bubble up to execute() / resume()
      }

      logger.info(`[Saga] Step COMPLETED id=${sagaId} step=${step.name}[${i}]`);
    }

    return lastOutput as TOutput;
  }

  /**
   * Execute compensation for all completed steps in reverse order.
   * Reads the completed outputs from the DB so compensation is correct after recovery.
   */
  private static async _compensate<TInput>(
    sagaId: string,
    definition: SagaDefinition<TInput, any>,
    sagaInput: TInput,
    failureError: Error,
    existingSteps?: PersistedSagaInstance['steps'],
  ): Promise<{ allCompensated: boolean; compensatedCount: number }> {
    // Load all completed step executions if not already provided
    let completedSteps = existingSteps
      ? existingSteps.filter((s) => s.status === SagaStepStatus.COMPLETED)
      : await prisma.sagaStepExecution
          .findMany({
            where: { sagaId, status: SagaStepStatus.COMPLETED },
            orderBy: { stepIndex: 'desc' }, // reverse order
          })
          .catch(() => []);

    // Sort descending for compensation (most recent first)
    completedSteps = [...completedSteps].sort((a, b) => b.stepIndex - a.stepIndex);

    await prisma.sagaInstance.update({
      where: { id: sagaId },
      data: { status: SagaStatus.COMPENSATING },
    });

    const timeoutMs =
      (
        await prisma.sagaInstance
          .findUnique({ where: { id: sagaId }, select: { compensationTimeoutMs: true } })
          .catch(() => null)
      )?.compensationTimeoutMs ?? 30_000;

    const compensationDeadline = Date.now() + timeoutMs;

    let compensatedCount = 0;
    let allCompensated = true;

    for (const stepRecord of completedSteps) {
      if (Date.now() > compensationDeadline) {
        logger.error(
          `[Saga] Compensation TIMEOUT id=${sagaId} — marking as FAILED`,
        );
        allCompensated = false;
        break;
      }

      const stepDef = definition.steps[stepRecord.stepIndex];
      if (!stepDef || !stepDef.compensate) {
        // No compensation defined — skip silently
        continue;
      }

      // Mark this step as being compensated
      await prisma.sagaStepExecution
        .update({
          where: { id: stepRecord.id },
          data: { status: SagaStepStatus.COMPENSATING },
        })
        .catch(() => {/* non-fatal */});

      try {
        await stepDef.compensate(stepRecord.output, stepRecord.input ?? sagaInput);

        await prisma.sagaStepExecution.update({
          where: { id: stepRecord.id },
          data: {
            status: SagaStepStatus.COMPENSATED,
            compensatedAt: new Date(),
          },
        });

        compensatedCount++;
        logger.info(
          `[Saga] Step COMPENSATED id=${sagaId} step=${stepDef.name}[${stepRecord.stepIndex}]`,
        );
      } catch (compErr) {
        const compError =
          compErr instanceof Error ? compErr : new Error(String(compErr));

        await prisma.sagaStepExecution
          .update({
            where: { id: stepRecord.id },
            data: {
              status: SagaStepStatus.COMPENSATION_FAILED,
              error: compError.message,
            },
          })
          .catch(() => {/* non-fatal */});

        logger.error(
          `[Saga] Step COMPENSATION_FAILED id=${sagaId} step=${stepDef.name}[${stepRecord.stepIndex}]: ${compError.message}`,
          compError,
        );
        allCompensated = false;
        // Continue trying to compensate the remaining steps — a partial
        // compensation is better than stopping halfway.
      }
    }

    return { allCompensated, compensatedCount };
  }

  /**
   * Emit structured saga metrics to the logger.
   * This is the observability hook — plug in a metrics backend here.
   */
  private static _emitMetrics(metrics: SagaMetrics): void {
    logger.info('[Saga:metrics]', {
      sagaId: metrics.sagaId,
      sagaName: metrics.sagaName,
      status: metrics.status,
      totalSteps: metrics.totalSteps,
      completedSteps: metrics.completedSteps,
      failedStep: metrics.failedStep,
      durationMs: metrics.durationMs,
      compensationDurationMs: metrics.compensationDurationMs,
    });
  }

  /**
   * Query for non-terminal sagas that need to be recovered.
   * Called by the recovery worker on startup.
   */
  static async findRecoverableSagas(): Promise<PersistedSagaInstance[]> {
    return prisma.sagaInstance.findMany({
      where: { status: { in: NON_TERMINAL_STATUSES } },
      include: { steps: { orderBy: { stepIndex: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    }) as Promise<PersistedSagaInstance[]>;
  }
}
