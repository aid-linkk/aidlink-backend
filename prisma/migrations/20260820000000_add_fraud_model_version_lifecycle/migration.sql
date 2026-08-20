-- FraudModelVersion lifecycle management (issue #197):
-- feature schema versioning, shadow (A/B) scoring, and atomic version promotion.

-- Feature schema versioning: labels/versions from different feature computations must
-- not be mixed when fitting Platt parameters. Existing rows default to schema version 1.
ALTER TABLE "FraudModelVersion" ADD COLUMN "featureSchemaVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "FraudLabel" ADD COLUMN "featureSchemaVersion" INTEGER NOT NULL DEFAULT 1;

-- CANDIDATE -> ACTIVE -> DEPRECATED lifecycle marker. true while a version is being
-- scored on live traffic (shadow mode) but not yet used for decisions.
ALTER TABLE "FraudModelVersion" ADD COLUMN "shadowMode" BOOLEAN NOT NULL DEFAULT false;

-- Calibrated probability from a shadow (candidate) version, recorded for A/B comparison.
-- Nullable and never read by existing queries that don't explicitly select it.
ALTER TABLE "KYCSubmission" ADD COLUMN "shadowScore" DOUBLE PRECISION;

CREATE INDEX "FraudModelVersion_shadowMode_idx" ON "FraudModelVersion"("shadowMode");
CREATE INDEX "FraudLabel_featureSchemaVersion_idx" ON "FraudLabel"("featureSchemaVersion");

-- Enforce "at most one active FraudModelVersion" at the database level. Prisma's schema
-- DSL cannot express a partial index, so this is raw SQL and has no `@@index` counterpart
-- in schema.prisma.
CREATE UNIQUE INDEX "fraud_model_single_active_idx" ON "FraudModelVersion" ("isActive") WHERE "isActive" = true;
