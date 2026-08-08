-- Support the new /search/assignments endpoint: filtering/sorting by
-- assignedAt (date range + sort) and priority (range filter) on
-- BeneficiaryAssignment previously had no index, so these would have been
-- full-table scans as the table grows. campaignId/beneficiaryId were
-- already indexed.
CREATE INDEX IF NOT EXISTS "BeneficiaryAssignment_assignedAt_idx" ON "BeneficiaryAssignment" ("assignedAt");
CREATE INDEX IF NOT EXISTS "BeneficiaryAssignment_priority_idx" ON "BeneficiaryAssignment" ("priority");
