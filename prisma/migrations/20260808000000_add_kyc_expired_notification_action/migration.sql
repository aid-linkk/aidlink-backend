-- Add KYC_EXPIRED to NotificationType so beneficiaries/admins can be notified
-- when a KYC submission's validity window ends.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'KYC_EXPIRED';

-- Add KYC_EXPIRED to AuditAction so the expiration worker can write a
-- proper audit trail entry for each status transition it performs.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KYC_EXPIRED';
