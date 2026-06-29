-- AlterTable: add anonymity and grouping fields to Donation
ALTER TABLE "Donation" ADD COLUMN "revealedAt" TIMESTAMP(3);
ALTER TABLE "Donation" ADD COLUMN "groupId" TEXT;
ALTER TABLE "Donation" ADD COLUMN "retentionPolicy" TEXT;

-- AlterEnum: add DONATION_IDENTITY_REVEALED to AuditAction
ALTER TYPE "AuditAction" ADD VALUE 'DONATION_IDENTITY_REVEALED';
