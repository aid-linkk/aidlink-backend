## Description

Extends backend test coverage by adding Jest unit test suites for five core services that previously had no test coverage. All external dependencies (Prisma, JWT, crypto, nodemailer, BullMQ, logger, config) are fully mocked, keeping tests fast and deterministic. Every service achieves **≥92% statement coverage** — well above the 50% target.

## Changes

### New test files

| File | Coverage | Tests |
|---|---|---|
| `src/services/auth.service.test.ts` | 98.59% | 24 tests |
| `src/services/beneficiary.service.test.ts` | 92.59% | 30 tests |
| `src/services/distribution.service.test.ts` | 100% | 22 tests |
| `src/services/notification.service.test.ts` | 100% | 40 tests |

### Extended test file

| File | Coverage | New Tests |
|---|---|---|
| `src/services/campaign.service.test.ts` | 92.71% | +15 tests (createCampaign, getCampaigns, getCampaignById, updateCampaignStatus) |

### Tested scenarios by service

**auth.service.ts** — register (success, duplicate email, duplicate username, DB error), login (valid, invalid email, wrong password, missing passwordHash, suspended, deleted, lastLogin update), walletAuth (existing user, new user creation), refreshToken (valid, invalid/expired, expired session), logout, logoutAll, getUserById

**beneficiary.service.ts** — createBeneficiary, getBeneficiaries (pagination, filters, search, empty), getBeneficiaryById, updateBeneficiary (owner, admin, unauthorized, not-found), updateBeneficiaryStatus (admin, verifier, permission check, verifiedAt setting), calculateRiskScore (baseline, KYC rejections, family size, not-found), submitKYC (valid, non-owner, duplicate active), reviewKYC (approve/verify, reject, expire/reset, unauthorized, not-found), getBeneficiaryByUserId

**campaign.service.ts** — createCampaign (success, missing org, unauthorized), getCampaigns (pagination, status filter, empty), getCampaignById (relations + moderation view, not-found), updateCampaignStatus (owner, admin, suspension endpoint blocked, suspended-campaign blocked, not-found). Preserves all existing updateCampaign, deleteCampaign, getCampaignStats, addMilestone, assignBeneficiary tests.

**distribution.service.ts** — createDistribution (success, missing campaign, missing beneficiary, unassigned, unauthorized, admin override), confirmDistribution (success, already-completed, not-found), getDistributions (pagination, campaignId/beneficiaryId filters, defaults), updateDistributionStatus (IN_PROGRESS/COMPLETED, unauthorized, not-found, distributedBy), addProofDocument

**notification.service.ts** — createNotification, sendEmail (success, SMTP failure), sendNotificationEmail (full flow, skip-if-no-user, skip-if-unverified), getUserNotifications (user filter, status filter, limit), markAsRead, markAllAsRead, deleteNotification, getUnreadCount, plus all 18 template notification methods (donation received, campaign update, distribution sent, KYC approved/rejected, 6 organization templates, 2 bank templates, campaign suspended with/without options, campaign reinstated, appeal resolved approved/denied, donor fraud suspension)

### Dependencies mocked

- Prisma (all model methods across campaign, user, session, beneficiary, KYCSubmission, notification, distribution, organization, beneficiaryAssignment, milestone, donation)
- JWTUtils (generateAccessToken, generateRefreshToken, verifyToken)
- CryptoUtils (hashPassword, comparePassword)
- Nodemailer (createTransport, sendMail)
- BullMQ Queue (add)
- Winston logger
- Application config
- ModerationService (for getCampaignById)

## Testing

```bash
npm test              # 13 suites, 311 tests, all passing
npm run test:coverage # verifies per-file coverage
```

All tests follow existing patterns in `jest.config.js`, co-located with source files under `src/services/`.

closes #93
