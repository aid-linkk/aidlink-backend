# TODO (Multipliers + Matched Funds)

## Phase 1 — API (multiplier CRUD)
- [ ] Add controller endpoints in `src/controllers/campaign.controller.ts`
- [ ] Add zod request validation + routes in `src/routes/campaign.routes.ts`
- [ ] Enforce authz: campaign owner OR Role.ADMIN for write operations
- [ ] Ensure public list allowed (if required by product rules)

## Phase 2 — Donation matching correctness
- [ ] Harden `src/services/donation.service.ts` multiplier math using Decimal
- [ ] Apply caps: perDonationCap first, then remaining matchCap
- [ ] Make matchCap consumption concurrency-safe
- [ ] Ensure MatchedFund totals returned match stored values

## Phase 3 — Reporting
- [ ] Update `src/services/campaign.service.ts#getCampaignStats()` to include totalMatched/combinedRaised/matchBreakdown
- [ ] Update controller response shape if needed

## Phase 4 — Feature flag
- [ ] Add `FEATURE_MULTIPLIER` gating for matching and endpoints

## Phase 5 — Tests
- [ ] Unit tests: precedence/tie-break + validation
- [ ] Integration tests: donation confirm -> MatchedFund, partial caps
- [ ] Concurrency test: never exceed matchCap under parallel donations

## Phase 6 — Docs + rollout
- [ ] Update `docs/API.md` with multiplier endpoints + stats fields
- [ ] Add migration notes + rounding method + rollback/rollout guidance
- [ ] Update `TODO_MULTIPLIER.md` progress

