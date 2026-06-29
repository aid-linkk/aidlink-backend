## Step 1 — Repository understanding snapshot
- [x] Reviewed existing donation + confirm flow and campaign stats implementation.
- [x] Reviewed current Prisma schema and confirmed multiplier/matched-fund models exist.

## Step 2 — Prisma schema
- [x] Multiplier model present (MultiplierType, caps, date windows, milestoneId).
- [x] MatchedFund model present (donationId, campaignId, multiplierId, amounts).
- [ ] Ensure schema indexes & relations align with cap/stat queries.

## Step 3 — Multiplier service
- [x] MultiplierService present with validation + precedence evaluation.
- [ ] Tighten evaluation logic to use DB filtering (instead of JS fallback) and add milestone/date window correctness.
- [ ] Add unit tests for precedence/tie-break and validation.

## Step 4 — Donation processing changes
- [x] DonationService applies multipliers at confirmation and creates MatchedFund rows.
- [ ] Replace JS Number arithmetic with Decimal arithmetic + deterministic rounding.
- [ ] Enforce perDonationCap then remaining matchCap consumption with concurrency-safe cap consumption (row-lock or atomic update strategy).
- [ ] Store and return matched summary deterministically.
- [ ] Keep Campaign.currentAmount donor-only (existing behavior) and document.

## Step 5 — Management endpoints
- [ ] Add controller endpoints for campaign multiplier CRUD.
- [ ] Add routes and request validation (zod) for multiplier create/update.
- [ ] Enforce authorization: campaign owner or Role.ADMIN for CRUD; finance/admin only for matched-fund reconciliation.
- [ ] Ensure public list is allowed but management restricted.

## Step 6 — Reporting updates
- [ ] Update CampaignService.getCampaignStats() to include:
  - totalDonated
  - totalMatched
  - combinedRaised
  - matchBreakdown grouped by multiplierId (and matcher)
- [ ] Update controller and route response schemas.

## Step 7 — Tests
- [ ] Unit tests:
  - MultiplierService validation
  - evaluation precedence/tie-break
  - rounding rules
- [ ] Integration tests:
  - donation confirmation creates MatchedFund within caps
  - partial match when matchCap insufficient
  - multiplier disabled/expired ignored
- [ ] Concurrency test:
  - concurrent donations never exceed matchCap

## Step 8 — Docs
- [ ] Update docs/API.md with multiplier endpoints + stats fields.
- [ ] Add migration notes, rounding method, math definitions.
- [ ] Add reconciliation/export guidance.

## Step 9 — Migrations & rollout
- [ ] Create Prisma migration (after verifying schema changes are committed).
- [ ] Add feature flag FEATURE_MULTIPLIER gating multiplier application + endpoints.
- [ ] Staged rollout guidance (staging -> limited -> production) and rollback path.

