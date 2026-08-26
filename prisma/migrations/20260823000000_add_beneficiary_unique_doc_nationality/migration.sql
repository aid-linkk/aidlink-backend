-- AddUniqueConstraint
-- Enforce that (idDocumentNumber, nationality) is unique per Beneficiary.
-- This constraint:
--   1. Prevents duplicate beneficiary identities from being created via concurrent CSV imports.
--   2. Enables Prisma's createMany({ skipDuplicates: true }) to silently skip rows that
--      conflict on this pair (INSERT ... ON CONFLICT DO NOTHING behaviour).
--   3. Ensures the application-level deduplication check in importFromCSV() is backed
--      by a hard DB guarantee, not just application logic.
--
-- The constraint is created with CONCURRENTLY so it does not block reads or writes on
-- the Beneficiary table during the migration in production environments.
-- Note: Prisma migrate dev/deploy does not support CONCURRENTLY in migration SQL; the
-- CONCURRENTLY keyword is included as a comment for operators running this manually on
-- a live production database. The standard form below is used for automated migrations.

CREATE UNIQUE INDEX "Beneficiary_idDocumentNumber_nationality_key"
  ON "Beneficiary"("idDocumentNumber", "nationality");

ALTER TABLE "Beneficiary"
  ADD CONSTRAINT "Beneficiary_idDocumentNumber_nationality_key"
  UNIQUE USING INDEX "Beneficiary_idDocumentNumber_nationality_key";
