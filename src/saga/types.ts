/**
 * Core types for the AidLink saga orchestration pattern.
 *
 * Design decisions:
 * - Orchestration (not choreography): a central SagaOrchestrator drives all steps,
 *   making the flow easy to test and reason about.
 * - Steps are either transactional (run inside the caller's Prisma transaction)
 *   or async (fire-and-forget with optional compensation).
 * - Compensation executes in reverse order of completed steps.
 * - All state is persisted to SagaInstance / SagaStepExecution tables so that
 *   a crash can be detected and the saga resumed from the last durable checkpoint.
 */

import { Prisma, SagaStatus, SagaStepStatus } from '@prisma/client';

// ─── Step definition ─────────────────────────────────────────────────────────

/**
 * A single unit of work in a saga.
 *
 * @template TInput  The input fed to this step (output of the previous step, or
 *                   the saga's initial input for the first step).
 * @template TOutput The value returned by execute, stored in SagaStepExecution.output
 *                   and threaded as input to the next step.
 */
export interface SagaStep<TInput = unknown, TOutput = unknown> {
  /** Unique human-readable name used for logging and recovery. */
  name: string;

  /**
   * Execute the step's main logic.
   *
   * For transactional steps the orchestrator passes the active Prisma
   * transaction client so the work is atomic with other step writes.
   * For async steps tx is undefined.
   */
  execute: (input: TInput, tx?: Prisma.TransactionClient) => Promise<TOutput>;

  /**
   * Undo the effect of this step if a later step fails.
   * Compensation must be idempotent — it may be called multiple times
   * after a crash-and-recovery cycle.
   *
   * Optional: steps with no side effects (e.g. read-only checks) don't need
   * compensation.
   */
  compensate?: (output: TOutput, input: TInput) => Promise<void>;

  /**
   * When true the orchestrator passes the active Prisma transaction client to
   * execute().  The caller is responsible for starting/committing that
   * transaction; the orchestrator participates in it but does not own it.
   *
   * When false the step runs outside any transaction.  The saga state rows
   * (SagaInstance / SagaStepExecution) are always written in their own
   * independent transactions regardless of this flag.
   */
  isTransactional: boolean;

  /**
   * When true the orchestrator will NOT await the execute() promise — it fires
   * the step and continues immediately, recording a COMPLETED status
   * optimistically. Failures are logged but do not block the saga.
   *
   * Async steps may still have compensation functions (e.g. send a
   * "DONATION_CANCELLED" webhook to undo a previously dispatched
   * "DONATION_CONFIRMED" event).
   *
   * isAsync implies !isTransactional.
   */
  isAsync?: boolean;
}

// ─── Saga definition ─────────────────────────────────────────────────────────

/**
 * A named sequence of steps with optional lifecycle hooks.
 *
 * @template TInput  The initial input to the saga (serialised to
 *                   SagaInstance.input for recovery).
 * @template TOutput The final output produced after all steps succeed (stored
 *                   in SagaInstance.output).
 */
export interface SagaDefinition<TInput = unknown, TOutput = unknown> {
  /** Logical name persisted in SagaInstance.name. */
  name: string;

  /** Ordered list of steps.  Executed sequentially left-to-right. */
  steps: SagaStep<any, any>[];

  /**
   * Called after all steps complete successfully.
   * Errors here are logged but do not trigger compensation (the saga is
   * already in a COMPLETED state at this point).
   */
  onCompletion?: (result: TOutput, sagaId: string) => Promise<void>;

  /**
   * Called after all compensations finish (successfully or not).
   * Errors here are logged but not re-thrown.
   */
  onCompensation?: (error: Error, sagaId: string) => Promise<void>;

  /** Compensation timeout in milliseconds.  Default: 30 000 ms. */
  compensationTimeoutMs?: number;
}

// ─── Execution context ────────────────────────────────────────────────────────

/**
 * Context injected into the orchestrator for a single saga run.
 * Separating context from definition allows the same definition to be reused
 * with different Prisma transaction clients (e.g. in tests).
 */
export interface SagaContext {
  /**
   * Active Prisma transaction client for transactional steps.
   * If provided, all transactional steps run inside this transaction.
   * If absent, the orchestrator creates an internal transaction per
   * transactional step group.
   */
  tx?: Prisma.TransactionClient;
}

// ─── Saga result ─────────────────────────────────────────────────────────────

export type SagaResult<TOutput> =
  | { success: true; output: TOutput; sagaId: string }
  | { success: false; error: Error; sagaId: string };

// ─── Internal persistence types (mirror Prisma models) ───────────────────────

export interface PersistedSagaInstance {
  id: string;
  name: string;
  status: SagaStatus;
  currentStep: number;
  input: unknown;
  output: unknown;
  error: string | null;
  compensationTimeoutMs: number;
  createdAt: Date;
  updatedAt: Date;
  steps: PersistedSagaStepExecution[];
}

export interface PersistedSagaStepExecution {
  id: string;
  sagaId: string;
  stepName: string;
  stepIndex: number;
  status: SagaStepStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  executedAt: Date | null;
  completedAt: Date | null;
  compensatedAt: Date | null;
}

// ─── Observable saga metrics ──────────────────────────────────────────────────

export interface SagaMetrics {
  sagaId: string;
  sagaName: string;
  status: SagaStatus;
  totalSteps: number;
  completedSteps: number;
  failedStep?: string;
  durationMs?: number;
  compensationDurationMs?: number;
}
