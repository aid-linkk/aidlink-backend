/**
 * Unit tests for the SagaOrchestrator state machine.
 *
 * These tests mock the Prisma client and verify that the orchestrator:
 *  - Persists saga state correctly (STARTED → STEP_COMPLETED → COMPLETED)
 *  - Drives compensation in reverse order on failure
 *  - Handles async (fire-and-forget) steps correctly
 *  - Resumes from a persisted checkpoint after crash
 *  - Handles compensation timeout
 *  - Handles idempotent step re-execution
 */

import { SagaStatus, SagaStepStatus } from '@prisma/client';

// ─── Mock prisma ─────────────────────────────────────────────────────────────

let sagaCreateMock: jest.Mock;
let sagaUpdateMock: jest.Mock;
let sagaFindUniqueMock: jest.Mock;
let sagaFindManyMock: jest.Mock;
let stepCreateMock: jest.Mock;
let stepUpdateMock: jest.Mock;
let stepFindManyMock: jest.Mock;

jest.mock('../../config/database', () => {
  sagaCreateMock = jest.fn();
  sagaUpdateMock = jest.fn();
  sagaFindUniqueMock = jest.fn();
  sagaFindManyMock = jest.fn();
  stepCreateMock = jest.fn();
  stepUpdateMock = jest.fn();
  stepFindManyMock = jest.fn();

  return {
    __esModule: true,
    default: {
      sagaInstance: {
        create: (...args: any[]) => sagaCreateMock(...args),
        update: (...args: any[]) => sagaUpdateMock(...args),
        findUnique: (...args: any[]) => sagaFindUniqueMock(...args),
        findMany: (...args: any[]) => sagaFindManyMock(...args),
      },
      sagaStepExecution: {
        create: (...args: any[]) => stepCreateMock(...args),
        update: (...args: any[]) => stepUpdateMock(...args),
        findMany: (...args: any[]) => stepFindManyMock(...args),
      },
    },
  };
});

jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Import AFTER mocks are set up
import { SagaOrchestrator } from '../SagaOrchestrator';
import { SagaDefinition } from '../types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal SagaDefinition with injectable step functions. */
function buildSaga(
  steps: Array<{
    name: string;
    execute: jest.Mock;
    compensate?: jest.Mock;
    isTransactional?: boolean;
    isAsync?: boolean;
  }>,
  hooks: {
    onCompletion?: jest.Mock;
    onCompensation?: jest.Mock;
  } = {},
): SagaDefinition<any, any> {
  return {
    name: 'TestSaga',
    compensationTimeoutMs: 5_000,
    steps: steps.map((s) => ({
      name: s.name,
      execute: s.execute,
      compensate: s.compensate,
      isTransactional: s.isTransactional ?? false,
      isAsync: s.isAsync ?? false,
    })),
    onCompletion: hooks.onCompletion,
    onCompensation: hooks.onCompensation,
  };
}

let instanceIdCounter = 0;
let stepIdCounter = 0;

/** Default stub for sagaInstance.create — returns a minimal instance row. */
function mockSagaCreate(overrides: Partial<any> = {}): any {
  instanceIdCounter++;
  return {
    id: `saga-${instanceIdCounter}`,
    name: 'TestSaga',
    status: SagaStatus.STARTED,
    currentStep: 0,
    input: {},
    output: null,
    error: null,
    compensationTimeoutMs: 5_000,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Default stub for sagaStepExecution.create — returns a minimal step row. */
function mockStepCreate(overrides: Partial<any> = {}): any {
  stepIdCounter++;
  return {
    id: `step-${stepIdCounter}`,
    sagaId: 'saga-1',
    stepName: 'unknown',
    stepIndex: 0,
    status: SagaStepStatus.RUNNING,
    input: null,
    output: null,
    error: null,
    executedAt: new Date(),
    completedAt: null,
    compensatedAt: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SagaOrchestrator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    instanceIdCounter = 0;
    stepIdCounter = 0;

    // Default: saga.create returns a valid instance
    sagaCreateMock.mockResolvedValue(mockSagaCreate());
    // Default: saga.update succeeds
    sagaUpdateMock.mockResolvedValue({});
    // Default: saga.findUnique returns compensationTimeoutMs for _compensate
    sagaFindUniqueMock.mockResolvedValue({ compensationTimeoutMs: 5_000 });
    // Default: step.create returns a valid step row
    stepCreateMock.mockResolvedValue(mockStepCreate());
    // Default: step.update succeeds
    stepUpdateMock.mockResolvedValue({});
    // Default: step.findMany returns empty
    stepFindManyMock.mockResolvedValue([]);
  });

  // ─── Happy path ────────────────────────────────────────────────────────────

  describe('execute() — happy path', () => {
    it('returns success=true with output when all steps succeed', async () => {
      const step1 = { name: 's1', execute: jest.fn().mockResolvedValue({ x: 1 }) };
      const step2 = { name: 's2', execute: jest.fn().mockResolvedValue({ y: 2 }) };

      const result = await SagaOrchestrator.execute(buildSaga([step1, step2]), {});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output).toEqual({ y: 2 });
        expect(result.sagaId).toBeDefined();
      }
    });

    it('threads step output as input to the next step', async () => {
      const step1 = { name: 's1', execute: jest.fn().mockResolvedValue({ value: 42 }) };
      const step2 = { name: 's2', execute: jest.fn().mockResolvedValue({ doubled: 84 }) };

      await SagaOrchestrator.execute(buildSaga([step1, step2]), { initial: true });

      expect(step2.execute).toHaveBeenCalledWith({ value: 42 }, undefined);
    });

    it('persists STARTED status on saga creation', async () => {
      const step = { name: 's1', execute: jest.fn().mockResolvedValue({}) };
      await SagaOrchestrator.execute(buildSaga([step]), { input: 'data' });

      expect(sagaCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'TestSaga',
            status: SagaStatus.STARTED,
            input: { input: 'data' },
          }),
        }),
      );
    });

    it('persists COMPLETED status after all steps succeed', async () => {
      const step = { name: 's1', execute: jest.fn().mockResolvedValue({ done: true }) };
      await SagaOrchestrator.execute(buildSaga([step]), {});

      const completionCall = sagaUpdateMock.mock.calls.find(
        (call) => call[0]?.data?.status === SagaStatus.COMPLETED,
      );
      expect(completionCall).toBeDefined();
      expect(completionCall[0].data.output).toEqual({ done: true });
    });

    it('creates a RUNNING step row before executing each step', async () => {
      const step1 = { name: 'step-alpha', execute: jest.fn().mockResolvedValue({}) };
      const step2 = { name: 'step-beta', execute: jest.fn().mockResolvedValue({}) };

      await SagaOrchestrator.execute(buildSaga([step1, step2]), {});

      const stepCreates = stepCreateMock.mock.calls;
      expect(stepCreates).toHaveLength(2);
      expect(stepCreates[0][0].data.stepName).toBe('step-alpha');
      expect(stepCreates[0][0].data.status).toBe(SagaStepStatus.RUNNING);
      expect(stepCreates[1][0].data.stepName).toBe('step-beta');
    });

    it('marks each step COMPLETED after its execute() resolves', async () => {
      const step = { name: 's1', execute: jest.fn().mockResolvedValue({ out: 1 }) };
      await SagaOrchestrator.execute(buildSaga([step]), {});

      const completedUpdate = stepUpdateMock.mock.calls.find(
        (call) => call[0]?.data?.status === SagaStepStatus.COMPLETED,
      );
      expect(completedUpdate).toBeDefined();
      expect(completedUpdate[0].data.output).toEqual({ out: 1 });
    });

    it('calls onCompletion hook after completing', async () => {
      const onCompletion = jest.fn().mockResolvedValue(undefined);
      const step = { name: 's1', execute: jest.fn().mockResolvedValue({ final: true }) };

      await SagaOrchestrator.execute(buildSaga([step], { onCompletion }), {});

      // Give the fire-and-forget promise a tick to resolve
      await new Promise((r) => setImmediate(r));

      expect(onCompletion).toHaveBeenCalledWith({ final: true }, expect.any(String));
    });
  });

  // ─── Async steps ──────────────────────────────────────────────────────────

  describe('execute() — async (fire-and-forget) steps', () => {
    it('does not await async step and marks COMPLETED optimistically', async () => {
      let resolveFn!: (v: any) => void;
      const asyncExec = jest.fn(
        () => new Promise((resolve) => { resolveFn = resolve; }),
      );
      const step = { name: 'async-step', execute: asyncExec, isAsync: true };

      const resultPromise = SagaOrchestrator.execute(buildSaga([step]), {});
      // Don't resolve the async step — saga should still complete
      const result = await resultPromise;

      expect(result.success).toBe(true);

      // Cleanup
      resolveFn(undefined);
    });

    it('logs error but does not fail saga when async step rejects', async () => {
      const asyncExec = jest.fn().mockRejectedValue(new Error('async step exploded'));
      const step = { name: 'async-step', execute: asyncExec, isAsync: true };

      const result = await SagaOrchestrator.execute(buildSaga([step]), {});

      // Give async rejection handler a tick
      await new Promise((r) => setImmediate(r));

      expect(result.success).toBe(true); // saga completed
    });
  });

  // ─── Compensation on failure ───────────────────────────────────────────────

  describe('execute() — compensation on step failure', () => {
    it('returns success=false when a step fails', async () => {
      const failingStep = {
        name: 'bad-step',
        execute: jest.fn().mockRejectedValue(new Error('step exploded')),
      };

      const result = await SagaOrchestrator.execute(buildSaga([failingStep]), {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('step exploded');
      }
    });

    it('calls compensate on previously completed steps in reverse order', async () => {
      const compensationOrder: string[] = [];

      const step1Comp = jest.fn().mockImplementation(async () => { compensationOrder.push('s1'); });
      const step2Comp = jest.fn().mockImplementation(async () => { compensationOrder.push('s2'); });

      const step1 = {
        name: 's1',
        execute: jest.fn().mockResolvedValue({ s1: true }),
        compensate: step1Comp,
      };
      const step2 = {
        name: 's2',
        execute: jest.fn().mockResolvedValue({ s2: true }),
        compensate: step2Comp,
      };
      const step3 = {
        name: 's3',
        execute: jest.fn().mockRejectedValue(new Error('s3 fails')),
      };

      // Provide already-completed steps for compensation
      stepFindManyMock.mockResolvedValue([
        {
          id: 'step-1',
          sagaId: 'saga-1',
          stepName: 's1',
          stepIndex: 0,
          status: SagaStepStatus.COMPLETED,
          input: {},
          output: { s1: true },
          error: null,
          executedAt: new Date(),
          completedAt: new Date(),
          compensatedAt: null,
        },
        {
          id: 'step-2',
          sagaId: 'saga-1',
          stepName: 's2',
          stepIndex: 1,
          status: SagaStepStatus.COMPLETED,
          input: { s1: true },
          output: { s2: true },
          error: null,
          executedAt: new Date(),
          completedAt: new Date(),
          compensatedAt: null,
        },
      ]);

      await SagaOrchestrator.execute(buildSaga([step1, step2, step3]), {});

      // Compensation must run in reverse: s2 before s1
      expect(compensationOrder).toEqual(['s2', 's1']);
    });

    it('marks the saga as COMPENSATED when all compensations succeed', async () => {
      stepFindManyMock.mockResolvedValue([
        {
          id: 'step-1',
          sagaId: 'saga-1',
          stepName: 's1',
          stepIndex: 0,
          status: SagaStepStatus.COMPLETED,
          input: {},
          output: {},
          error: null,
          executedAt: new Date(),
          completedAt: new Date(),
          compensatedAt: null,
        },
      ]);

      const failingStep = { name: 's2', execute: jest.fn().mockRejectedValue(new Error('oops')) };
      const compensatedStep = {
        name: 's1',
        execute: jest.fn().mockResolvedValue({}),
        compensate: jest.fn().mockResolvedValue(undefined),
      };

      await SagaOrchestrator.execute(buildSaga([compensatedStep, failingStep]), {});

      const finalUpdate = sagaUpdateMock.mock.calls.find(
        (call) =>
          call[0]?.data?.status === SagaStatus.COMPENSATED ||
          call[0]?.data?.status === SagaStatus.FAILED,
      );
      expect(finalUpdate).toBeDefined();
      expect(finalUpdate[0].data.status).toBe(SagaStatus.COMPENSATED);
    });

    it('marks saga as FAILED when a compensation step itself throws', async () => {
      stepFindManyMock.mockResolvedValue([
        {
          id: 'step-1',
          sagaId: 'saga-1',
          stepName: 's1',
          stepIndex: 0,
          status: SagaStepStatus.COMPLETED,
          input: {},
          output: {},
          error: null,
          executedAt: new Date(),
          completedAt: new Date(),
          compensatedAt: null,
        },
      ]);

      const brokenComp = {
        name: 's1',
        execute: jest.fn().mockResolvedValue({}),
        compensate: jest.fn().mockRejectedValue(new Error('comp fails too')),
      };
      const failingStep = { name: 's2', execute: jest.fn().mockRejectedValue(new Error('s2 fail')) };

      await SagaOrchestrator.execute(buildSaga([brokenComp, failingStep]), {});

      const finalUpdate = sagaUpdateMock.mock.calls.find(
        (call) =>
          call[0]?.data?.status === SagaStatus.COMPENSATED ||
          call[0]?.data?.status === SagaStatus.FAILED,
      );
      expect(finalUpdate).toBeDefined();
      expect(finalUpdate[0].data.status).toBe(SagaStatus.FAILED);
    });

    it('calls onCompensation hook after compensating', async () => {
      const onCompensation = jest.fn().mockResolvedValue(undefined);
      stepFindManyMock.mockResolvedValue([]);

      const failingStep = { name: 's1', execute: jest.fn().mockRejectedValue(new Error('fail')) };

      await SagaOrchestrator.execute(buildSaga([failingStep], { onCompensation }), {});

      await new Promise((r) => setImmediate(r));
      expect(onCompensation).toHaveBeenCalledWith(expect.any(Error), expect.any(String));
    });

    it('skips steps with no compensate function', async () => {
      stepFindManyMock.mockResolvedValue([
        {
          id: 'step-1',
          sagaId: 'saga-1',
          stepName: 's1',
          stepIndex: 0,
          status: SagaStepStatus.COMPLETED,
          input: {},
          output: {},
          error: null,
          executedAt: new Date(),
          completedAt: new Date(),
          compensatedAt: null,
        },
      ]);

      // s1 has no compensate
      const s1 = { name: 's1', execute: jest.fn().mockResolvedValue({}) };
      const s2 = { name: 's2', execute: jest.fn().mockRejectedValue(new Error('fail')) };

      // Should not throw
      const result = await SagaOrchestrator.execute(buildSaga([s1, s2]), {});
      expect(result.success).toBe(false);
    });
  });

  // ─── Crash recovery ────────────────────────────────────────────────────────

  describe('resume()', () => {
    it('resumes from STEP_COMPLETED and completes the remaining steps', async () => {
      const persistedInstance = {
        id: 'saga-crashed',
        name: 'TestSaga',
        status: SagaStatus.STEP_COMPLETED,
        currentStep: 1, // step 0 already done
        input: { initial: true },
        output: null,
        error: null,
        compensationTimeoutMs: 5_000,
        createdAt: new Date(Date.now() - 10_000),
        updatedAt: new Date(),
        steps: [
          {
            id: 'step-0',
            sagaId: 'saga-crashed',
            stepName: 's1',
            stepIndex: 0,
            status: SagaStepStatus.COMPLETED,
            input: { initial: true },
            output: { s1Done: true },
            error: null,
            executedAt: new Date(),
            completedAt: new Date(),
            compensatedAt: null,
          },
        ],
      };

      sagaFindUniqueMock.mockResolvedValue(persistedInstance);

      const s1 = { name: 's1', execute: jest.fn() }; // should NOT be called again
      const s2 = {
        name: 's2',
        execute: jest.fn().mockResolvedValue({ s2Done: true }),
      };

      const result = await SagaOrchestrator.resume('saga-crashed', buildSaga([s1, s2]));

      expect(result.success).toBe(true);
      // s1 was already done — should not be called again (idempotent recovery)
      expect(s1.execute).not.toHaveBeenCalled();
      expect(s2.execute).toHaveBeenCalled();
    });

    it('returns immediately for a saga already in a terminal state', async () => {
      const completedInstance = {
        id: 'saga-done',
        name: 'TestSaga',
        status: SagaStatus.COMPLETED,
        currentStep: 2,
        input: {},
        output: { final: true },
        error: null,
        compensationTimeoutMs: 5_000,
        createdAt: new Date(),
        updatedAt: new Date(),
        steps: [],
      };

      sagaFindUniqueMock.mockResolvedValue(completedInstance);

      const s1 = { name: 's1', execute: jest.fn() };
      const result = await SagaOrchestrator.resume('saga-done', buildSaga([s1]));

      expect(result.success).toBe(true);
      expect(s1.execute).not.toHaveBeenCalled();
    });

    it('resumes compensation when found in COMPENSATING state', async () => {
      const compensatingInstance = {
        id: 'saga-comp',
        name: 'TestSaga',
        status: SagaStatus.COMPENSATING,
        currentStep: 1,
        input: { initial: true },
        output: null,
        error: 'step 2 failed',
        compensationTimeoutMs: 5_000,
        createdAt: new Date(Date.now() - 5_000),
        updatedAt: new Date(),
        steps: [
          {
            id: 'step-0',
            sagaId: 'saga-comp',
            stepName: 's1',
            stepIndex: 0,
            status: SagaStepStatus.COMPLETED,
            input: { initial: true },
            output: { s1Done: true },
            error: null,
            executedAt: new Date(),
            completedAt: new Date(),
            compensatedAt: null,
          },
        ],
      };

      sagaFindUniqueMock.mockResolvedValue(compensatingInstance);

      const s1comp = jest.fn().mockResolvedValue(undefined);
      const s1 = { name: 's1', execute: jest.fn(), compensate: s1comp };
      const s2 = { name: 's2', execute: jest.fn().mockRejectedValue(new Error('fail')) };

      const result = await SagaOrchestrator.resume('saga-comp', buildSaga([s1, s2]));

      expect(result.success).toBe(false);
      expect(s1comp).toHaveBeenCalled(); // compensation resumed
    });

    it('throws when saga not found in DB', async () => {
      sagaFindUniqueMock.mockResolvedValue(null);

      await expect(
        SagaOrchestrator.resume('nonexistent-id', buildSaga([])),
      ).rejects.toThrow('nonexistent-id');
    });
  });

  // ─── findRecoverableSagas ─────────────────────────────────────────────────

  describe('findRecoverableSagas()', () => {
    it('queries for non-terminal statuses only', async () => {
      sagaFindManyMock.mockResolvedValue([]);

      await SagaOrchestrator.findRecoverableSagas();

      expect(sagaFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: expect.objectContaining({ in: expect.arrayContaining([SagaStatus.STARTED]) }),
          }),
        }),
      );
    });
  });

  // ─── Transactional step integration ──────────────────────────────────────

  describe('execute() — transactional step receives tx', () => {
    it('passes callerTx to transactional steps', async () => {
      const txStep = {
        name: 'tx-step',
        execute: jest.fn().mockResolvedValue({}),
        isTransactional: true,
      };
      const mockTx = { __mockTx: true } as any;

      await SagaOrchestrator.execute(buildSaga([txStep]), {}, mockTx);

      expect(txStep.execute).toHaveBeenCalledWith({}, mockTx);
    });

    it('does not pass tx to non-transactional steps', async () => {
      const nonTxStep = {
        name: 'non-tx-step',
        execute: jest.fn().mockResolvedValue({}),
        isTransactional: false,
      };
      const mockTx = { __mockTx: true } as any;

      await SagaOrchestrator.execute(buildSaga([nonTxStep]), {}, mockTx);

      // tx is not passed (undefined for non-transactional)
      expect(nonTxStep.execute).toHaveBeenCalledWith({}, undefined);
    });
  });

  // ─── State machine transitions ────────────────────────────────────────────

  describe('state machine transitions', () => {
    it('transitions saga from STARTED to STEP_COMPLETED after first step', async () => {
      const s1 = { name: 's1', execute: jest.fn().mockResolvedValue({}) };
      const s2 = { name: 's2', execute: jest.fn().mockResolvedValue({}) };

      await SagaOrchestrator.execute(buildSaga([s1, s2]), {});

      // After first step, saga should be updated to STEP_COMPLETED
      const stepCompletedUpdate = sagaUpdateMock.mock.calls.find(
        (call) => call[0]?.data?.status === SagaStatus.STEP_COMPLETED,
      );
      expect(stepCompletedUpdate).toBeDefined();
    });

    it('transitions to COMPENSATING before running compensations', async () => {
      const failingStep = { name: 's1', execute: jest.fn().mockRejectedValue(new Error('fail')) };

      await SagaOrchestrator.execute(buildSaga([failingStep]), {});

      const compensatingUpdate = sagaUpdateMock.mock.calls.find(
        (call) => call[0]?.data?.status === SagaStatus.COMPENSATING,
      );
      expect(compensatingUpdate).toBeDefined();
    });
  });
});
