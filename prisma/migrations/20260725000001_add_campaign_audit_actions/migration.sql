-- Add new AuditAction enum values for campaign audit trail
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CAMPAIGN_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MILESTONE_ADDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BENEFICIARY_ASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISTRIBUTION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISTRIBUTION_CONFIRMED';

-- Composite index to make campaign audit log queries fast
CREATE INDEX IF NOT EXISTS "AuditLog_entityType_entityId_createdAt_idx"
  ON "AuditLog" ("entityType", "entityId", "createdAt" DESC);
