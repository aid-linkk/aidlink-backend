-- Migration: add isotonicBreakpoints and calibrationType to FraudModelVersion
-- Generated for the online re-calibration pipeline (Platt MLE + isotonic regression fallback)

ALTER TABLE "FraudModelVersion"
  ADD COLUMN IF NOT EXISTS "calibrationType"      TEXT    NOT NULL DEFAULT 'platt',
  ADD COLUMN IF NOT EXISTS "isotonicBreakpoints"  JSONB   NULL;

-- Comment to aid future readers
COMMENT ON COLUMN "FraudModelVersion"."calibrationType" IS
  'Active calibration layer for this version: ''platt'' | ''isotonic''';

COMMENT ON COLUMN "FraudModelVersion"."isotonicBreakpoints" IS
  'Non-null when calibrationType = ''isotonic''. '
  'Array of { score: number, probability: number } breakpoints in ascending score order.';
