-- CreateEnum
CREATE TYPE "SagaStatus" AS ENUM ('STARTED', 'STEP_COMPLETED', 'COMPENSATING', 'COMPLETED', 'COMPENSATED', 'FAILED');

-- CreateEnum
CREATE TYPE "SagaStepStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'COMPENSATING', 'COMPENSATED', 'COMPENSATION_FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "SagaInstance" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "SagaStatus" NOT NULL DEFAULT 'STARTED',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "compensationTimeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SagaInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SagaStepExecution" (
    "id" TEXT NOT NULL,
    "sagaId" TEXT NOT NULL,
    "stepName" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "status" "SagaStepStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "executedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "compensatedAt" TIMESTAMP(3),

    CONSTRAINT "SagaStepExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SagaInstance_name_idx" ON "SagaInstance"("name");

-- CreateIndex
CREATE INDEX "SagaInstance_status_idx" ON "SagaInstance"("status");

-- CreateIndex
CREATE INDEX "SagaInstance_createdAt_idx" ON "SagaInstance"("createdAt");

-- CreateIndex
CREATE INDEX "SagaInstance_status_createdAt_idx" ON "SagaInstance"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SagaStepExecution_sagaId_idx" ON "SagaStepExecution"("sagaId");

-- CreateIndex
CREATE INDEX "SagaStepExecution_sagaId_stepIndex_idx" ON "SagaStepExecution"("sagaId", "stepIndex");

-- CreateIndex
CREATE INDEX "SagaStepExecution_status_idx" ON "SagaStepExecution"("status");

-- CreateIndex
CREATE INDEX "SagaStepExecution_executedAt_idx" ON "SagaStepExecution"("executedAt");

-- AddForeignKey
ALTER TABLE "SagaStepExecution" ADD CONSTRAINT "SagaStepExecution_sagaId_fkey" FOREIGN KEY ("sagaId") REFERENCES "SagaInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
