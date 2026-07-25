-- CreateEnum
CREATE TYPE "BatchJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'PARTIAL', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "BatchJobType" AS ENUM ('BENEFICIARY_IMPORT', 'BENEFICIARY_STATUS_UPDATE', 'KYC_BULK_SUBMIT', 'DISTRIBUTION_BATCH_CREATE', 'BULK_NOTIFICATION');

-- CreateTable
CREATE TABLE "BatchJob" (
    "id" TEXT NOT NULL,
    "type" "BatchJobType" NOT NULL,
    "status" "BatchJobStatus" NOT NULL DEFAULT 'PENDING',
    "createdBy" TEXT NOT NULL,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "processedItems" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "metadata" JSONB,
    "rollbackData" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BatchJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BatchJob_createdBy_idx" ON "BatchJob"("createdBy");
CREATE INDEX "BatchJob_type_idx" ON "BatchJob"("type");
CREATE INDEX "BatchJob_status_idx" ON "BatchJob"("status");
CREATE INDEX "BatchJob_createdAt_idx" ON "BatchJob"("createdAt");
