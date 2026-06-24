# AidLink Backend API Documentation

## Base URL

```
Production: https://api.aidlink.org/api/v1
Development: http://localhost:3000/api/v1
```

## Authentication

Most endpoints require authentication using JWT tokens.

### Headers

```
Authorization: Bearer <access_token>
Content-Type: application/json
```

### Token Types

- **Access Token**: Short-lived (15 minutes), used for API requests
- **Refresh Token**: Long-lived (7 days), used to obtain new access tokens

## Response Format

### Success Response

```json
{
  "success": true,
  "data": { ... },
  "message": "Operation successful"
}
```

### Error Response

```json
{
  "success": false,
  "error": "Error message",
  "errors": {
    "field": "Validation error"
  }
}
```

### Pagination

```json
{
  "success": true,
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 100,
    "totalPages": 10
  }
}
```

## Endpoints

### Authentication

#### Register

```http
POST /auth/register
```

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "securepassword123",
  "username": "johndoe",
  "role": "DONOR"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "user_id",
      "email": "user@example.com",
      "username": "johndoe",
      "role": "DONOR"
    },
    "tokens": {
      "accessToken": "jwt_access_token",
      "refreshToken": "jwt_refresh_token"
    }
  }
}
```

#### Login

```http
POST /auth/login
```

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "securepassword123"
}
```

#### Wallet Authentication

```http
POST /auth/wallet
```

**Request Body:**
```json
{
  "walletAddress": "G...",
  "signature": "signature",
  "message": "authentication message"
}
```

#### Refresh Token

```http
POST /auth/refresh
```

**Request Body:**
```json
{
  "refreshToken": "jwt_refresh_token"
}
```

#### Logout

```http
POST /auth/logout
Authorization: Bearer <access_token>
```

#### Get Current User

```http
GET /auth/me
Authorization: Bearer <access_token>
```

### Campaigns

#### Create Campaign

```http
POST /campaigns
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "title": "Emergency Relief Fund",
  "description": "Providing emergency relief to affected communities",
  "imageUrl": "https://example.com/image.jpg",
  "targetAmount": 100000,
  "startDate": "2024-01-01T00:00:00Z",
  "endDate": "2024-03-31T23:59:59Z",
  "organizationId": "org_id"
}
```

#### Get Campaigns

```http
GET /campaigns?page=1&limit=10&status=ACTIVE&search=relief
Authorization: Bearer <access_token>
```

#### Get Campaign by ID

```http
GET /campaigns/:id
Authorization: Bearer <access_token>
```

#### Update Campaign

```http
PUT /campaigns/:id
Authorization: Bearer <access_token>
```

#### Delete Campaign

```http
DELETE /campaigns/:id
Authorization: Bearer <access_token>
```

#### Update Campaign Status

```http
PATCH /campaigns/:id/status
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "status": "ACTIVE"
}
```

#### Add Milestone

```http
POST /campaigns/:campaignId/milestones
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "title": "First Phase",
  "description": "Initial relief distribution",
  "targetAmount": 50000,
  "order": 1
}
```

#### Assign Beneficiary

```http
POST /campaigns/:campaignId/beneficiaries
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "beneficiaryId": "beneficiary_id",
  "assignedAmount": 1000,
  "priority": 1,
  "notes": "High priority case"
}
```

#### Get Campaign Statistics

```http
GET /campaigns/:id/stats
Authorization: Bearer <access_token>
```

### Milestone Verification

Milestones go through a structured verification workflow: organization submits evidence → verifier reviews → approved or rejected.

**Submission states:** `DRAFT` → `SUBMITTED` → `UNDER_REVIEW` → `APPROVED` / `REJECTED` / `REVISION_REQUESTED`

**Milestone verification states:** `PENDING_SUBMISSION` → `SUBMITTED` → `UNDER_REVIEW` → `VERIFIED` / `REJECTED`

#### Create Submission Draft

```http
POST /campaigns/:campaignId/milestones/:milestoneId/submissions
Authorization: Bearer <access_token>
```

Role: Campaign owner / organization. Creates a `DRAFT` submission. Only one active submission (SUBMITTED, UNDER_REVIEW, or APPROVED) can exist per milestone at a time.

**Request Body:**
```json
{
  "description": "We distributed 300 food kits across 5 villages during March 2026.",
  "evidenceUrls": [
    "https://storage.aidlink.io/photo1.jpg",
    "https://storage.aidlink.io/report.pdf"
  ],
  "metricsData": {
    "beneficiariesReached": 300,
    "villagesCovered": 5
  },
  "submissionNotes": "Distribution was completed ahead of schedule."
}
```

**Response `201`:**
```json
{
  "success": true,
  "message": "Submission created",
  "data": {
    "id": "sub_id",
    "milestoneId": "milestone_id",
    "campaignId": "campaign_id",
    "organizationId": "org_id",
    "status": "DRAFT",
    "description": "...",
    "evidenceUrls": ["..."],
    "metricsData": {},
    "submittedAt": null,
    "createdAt": "2026-03-01T10:00:00Z"
  }
}
```

#### Update Submission

```http
PUT /campaigns/:campaignId/milestones/:milestoneId/submissions/:submissionId
Authorization: Bearer <access_token>
```

Only editable when status is `DRAFT` or `REVISION_REQUESTED`. All fields optional.

**Request Body:**
```json
{
  "description": "Updated description",
  "evidenceUrls": ["https://storage.aidlink.io/new-photo.jpg"],
  "metricsData": { "beneficiariesReached": 320 },
  "submissionNotes": "Added GPS coordinates"
}
```

#### Submit for Review

```http
POST /campaigns/:campaignId/milestones/:milestoneId/submissions/:submissionId/submit
Authorization: Bearer <access_token>
```

Transitions `DRAFT` → `SUBMITTED` (or `REVISION_REQUESTED` → `SUBMITTED` on resubmission). Notifies all verifiers and admins. Records history event.

**Response `200`:**
```json
{
  "success": true,
  "message": "Submission sent for review",
  "data": {
    "id": "sub_id",
    "status": "SUBMITTED",
    "submittedAt": "2026-03-01T12:00:00Z"
  }
}
```

#### Get Submission

```http
GET /campaigns/:campaignId/milestones/:milestoneId/submissions/:submissionId
Authorization: Bearer <access_token>
```

Campaign owner sees their own submission. Admins and verifiers can see any.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "id": "sub_id",
    "status": "UNDER_REVIEW",
    "description": "...",
    "evidenceUrls": ["..."],
    "metricsData": {},
    "submittedAt": "2026-03-01T12:00:00Z",
    "reviews": [...],
    "history": [
      { "event": "SUBMITTED", "actor": "user_id", "timestamp": "..." },
      { "event": "REVIEW_STARTED", "actor": "verifier_id", "timestamp": "..." }
    ]
  }
}
```

#### List Submissions for Milestone

```http
GET /campaigns/:campaignId/milestones/:milestoneId/submissions
Authorization: Bearer <access_token>
```

Returns all submissions for the milestone, ordered newest first. Each item includes the latest review and history entry.

#### Get Verification Report (Public)

```http
GET /campaigns/:campaignId/milestones/:milestoneId/verification-report
```

No authentication required. Returns the public-facing verification status, approved metrics, and verifier summary for a milestone.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "milestoneId": "milestone_id",
    "title": "Distribute 300 food kits",
    "verificationStatus": "VERIFIED",
    "approvedAt": "2026-03-05T09:00:00Z",
    "metricsApproved": { "beneficiariesReached": 300, "villagesCovered": 5 },
    "impactSummary": "300 beneficiaries confirmed via distribution records.",
    "verifierNotes": "Evidence well documented with GPS coordinates."
  }
}
```

#### Admin — List Submissions

```http
GET /admin/milestone-submissions?status=SUBMITTED&campaignId=...&startDate=...&endDate=...&page=1&limit=20
Authorization: Bearer <admin_or_verifier_token>
```

Role: `ADMIN` or `VERIFIER`. Returns paginated submissions filterable by status, campaign, and date range.

**Query params:**

| Param | Type | Description |
|---|---|---|
| `status` | string | Filter by `DRAFT`, `SUBMITTED`, `UNDER_REVIEW`, `APPROVED`, `REJECTED`, `REVISION_REQUESTED` |
| `campaignId` | string | Filter by campaign |
| `startDate` | ISO date | Filter by `submittedAt` >= date |
| `endDate` | ISO date | Filter by `submittedAt` <= date |
| `page` | number | Default `1` |
| `limit` | number | Default `20` |

#### Admin — Get Submission Detail

```http
GET /admin/milestone-submissions/:submissionId
Authorization: Bearer <admin_or_verifier_token>
```

Returns full submission with all reviews and complete history.

#### Admin — Submit Review

```http
POST /admin/milestone-submissions/:submissionId/reviews
Authorization: Bearer <admin_or_verifier_token>
```

Role: `ADMIN` or `VERIFIER`. Transitions submission to `UNDER_REVIEW` on first review, then to final state on decision. Notifies the organization and broadcasts WebSocket event.

**Request Body:**
```json
{
  "decision": "APPROVED",
  "verifierNotes": "All evidence reviewed and confirmed.",
  "metricsConfirmed": { "beneficiariesReached": 300 },
  "impactSummary": "300 beneficiaries confirmed via distribution records."
}
```

`decision` values: `APPROVED` | `REJECTED` | `REVISION_REQUESTED`

`reason` is required when decision is `REJECTED` or `REVISION_REQUESTED`.

**Request Body (rejection):**
```json
{
  "decision": "REJECTED",
  "reason": "Evidence does not match reported dates."
}
```

**Request Body (revision):**
```json
{
  "decision": "REVISION_REQUESTED",
  "reason": "Please provide GPS coordinates for each distribution point."
}
```

**Response `201`:**
```json
{
  "success": true,
  "message": "Review submitted",
  "data": {
    "id": "review_id",
    "submissionId": "sub_id",
    "verifierId": "verifier_id",
    "decision": "APPROVED",
    "impactSummary": "...",
    "metricsConfirmed": {},
    "reviewedAt": "2026-03-05T09:00:00Z"
  }
}
```

#### Admin — List Reviews for Submission

```http
GET /admin/milestone-submissions/:submissionId/reviews
Authorization: Bearer <admin_or_verifier_token>
```

Returns all reviews for a submission ordered newest first. Useful when multiple verifiers review the same submission.

#### Admin — Get Milestone Verification Status

```http
GET /admin/milestones/:milestoneId/verification-status
Authorization: Bearer <admin_or_verifier_token>
```

Returns current verification status, full submission history, and latest review for a milestone.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "id": "milestone_id",
    "title": "Distribute 300 food kits",
    "verificationStatus": "VERIFIED",
    "achieved": true,
    "achievedAt": "2026-03-05T09:00:00Z",
    "submissions": [
      {
        "id": "sub_id",
        "status": "APPROVED",
        "submittedAt": "...",
        "reviews": [...],
        "history": [
          { "event": "SUBMITTED", "actor": "user_id", "timestamp": "..." },
          { "event": "REVIEW_STARTED", "actor": "verifier_id", "timestamp": "..." },
          { "event": "APPROVED", "actor": "verifier_id", "timestamp": "..." }
        ]
      }
    ]
  }
}
```

#### WebSocket Events — Milestone Verification

```javascript
// Org receives when verifier makes a decision
socket.on('milestone:reviewed', (data) => {
  // data: { submissionId, milestoneId, decision }
});

// All campaign subscribers receive when org submits
socket.on('milestone:submitted', (data) => {
  // data: { submissionId, milestoneId, campaignId }
});
```

#### Get Trending Campaigns

```http
GET /campaigns/trending?period=last24h&sortBy=trendScore&limit=10
Authorization: Bearer <access_token>
```

Returns top campaigns by donation velocity, donor growth, or impact.

#### Get Campaign Impact Metrics

```http
GET /campaigns/:id/impact-metrics
Authorization: Bearer <access_token>
```

Returns comprehensive impact metrics: total donations, donor growth, distributions, beneficiaries reached, conversion rates.

#### Get Campaign Historical Statistics

```http
GET /campaigns/:id/statistics/historical?granularity=hourly&startDate=2024-01-01&endDate=2024-01-31
Authorization: Bearer <access_token>
```

Returns monthly or hourly rollup data for trend charts.

### Organizations

#### Create Organization

```http
POST /organizations
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "name": "Relief Partners",
  "email": "ops@relief.example",
  "country": "US",
  "registrationNumber": "REG-123",
  "representativeContact": {
    "name": "Taylor Reed",
    "email": "taylor@relief.example",
    "phone": "+15555550123"
  },
  "website": "https://relief.example",
  "description": "Regional aid organization",
  "address": {
    "line1": "10 Main St",
    "city": "New York",
    "country": "US"
  },
  "taxId": "TAX-123"
}
```

#### List Organizations

```http
GET /organizations?page=1&limit=20&verificationStatus=PENDING_VERIFICATION&country=US&search=relief
Authorization: Bearer <access_token>
```

Admins can list all organizations. Non-admin users receive only their own organization profiles.

#### Get Organization

```http
GET /organizations/:id
Authorization: Bearer <access_token>
```

The response includes organization profile fields, `verificationStatus`, `verificationRequestedAt`, `verifiedAt`, `verificationNotes`, active bank accounts, and verification history.

#### Update Organization

```http
PUT /organizations/:id
Authorization: Bearer <access_token>
```

Owners and admins can update profile, address, contact, legal document, and supporting metadata fields.

#### Archive Organization

```http
DELETE /organizations/:id
Authorization: Bearer <access_token>
```

Archives the organization by setting `deletedAt`, `status=SUSPENDED`, and `verificationStatus=SUSPENDED`.

#### Bank Accounts

```http
POST /organizations/:id/bank-accounts
GET /organizations/:id/bank-accounts
GET /organizations/:id/bank-accounts/:accountId
PUT /organizations/:id/bank-accounts/:accountId
DELETE /organizations/:id/bank-accounts/:accountId
POST /organizations/:id/bank-accounts/:accountId/verify
Authorization: Bearer <access_token>
```

**Create Request Body:**
```json
{
  "accountHolderName": "Relief Partners",
  "accountNumber": "123456789",
  "routingCode": "021000021",
  "iban": "US00EXAMPLE123456789",
  "bankName": "Community Bank",
  "currency": "USD",
  "branchCode": "001",
  "country": "US",
  "accountType": "CHECKING",
  "isPrimary": true
}
```

Deleting a bank account archives it. Verification requests move the account to `PENDING_VERIFICATION`.

#### Organization Verification

```http
POST /organizations/:id/verification
GET /organizations/:id/verification
Authorization: Bearer <access_token>
```

**Submit Request Body:**
```json
{
  "registrationDocs": ["https://files.example/registration.pdf"],
  "taxId": "TAX-123",
  "representativeId": "https://files.example/representative-id.pdf",
  "bankVerificationInfo": {
    "bankAccountId": "bank-account-id",
    "statementUrl": "https://files.example/statement.pdf"
  },
  "notes": "All required documents attached"
}
```

Submission moves the organization to `PENDING_VERIFICATION` and writes a verification history event.

#### Admin Organization Verification

```http
POST /admin/organizations/:id/verification/approve
POST /admin/organizations/:id/verification/reject
POST /admin/organizations/:id/verification/request-more-info
Authorization: Bearer <admin_access_token>
```

Approve accepts optional `{ "notes": "approved" }`. Reject and request-more-info require `{ "reason": "explanation" }`. Review actions update organization status, verification status, verification notes, history, audit logs, and notification hooks.

### Donations

#### Create Donation

```http
POST /donations
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "campaignId": "campaign_id",
  "amount": 100,
  "currency": "XLM",
  "isAnonymous": false,
  "donorMessage": "Hope this helps!"
}
```

#### Get Donations

```http
GET /donations?campaignId=campaign_id&page=1&limit=10
Authorization: Bearer <access_token>
```

#### Confirm Donation

```http
POST /donations/:id/confirm
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "txHash": "blockchain_transaction_hash"
}
```

#### Refund Donation

```http
POST /donations/:id/refund
Authorization: Bearer <access_token>
```

### Beneficiaries

#### Create Beneficiary Profile

```http
POST /beneficiaries
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "dateOfBirth": "1990-01-01",
  "gender": "Male",
  "nationality": "Kenyan",
  "idDocumentType": "National ID",
  "idDocumentNumber": "ID12345678",
  "phoneNumber": "+254700000000",
  "address": "123 Test Street, Nairobi",
  "city": "Nairobi",
  "country": "Kenya",
  "familySize": 4,
  "needsAssessment": "Emergency food assistance"
}
```

#### Get Beneficiaries

```http
GET /beneficiaries?status=VERIFIED&country=Kenya&page=1&limit=10
Authorization: Bearer <access_token>
```

#### Get Beneficiary by ID

```http
GET /beneficiaries/:id
Authorization: Bearer <access_token>
```

#### Update Beneficiary

```http
PUT /beneficiaries/:id
Authorization: Bearer <access_token>
```

#### Update Beneficiary Status

```http
PATCH /beneficiaries/:id/status
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "status": "VERIFIED"
}
```

#### Submit KYC

```http
POST /beneficiaries/:id/kyc
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "submissionType": "INDIVIDUAL",
  "documentType": "PASSPORT",
  "documentUrl": "https://storage.example.com/document.pdf",
  "selfieUrl": "https://storage.example.com/selfie.jpg"
}
```

#### Review KYC

```http
POST /kyc/:submissionId/review
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "status": "APPROVED",
  "reviewNotes": "Documents verified successfully"
}
```

### Analytics

#### Get Aggregated Campaign Analytics (Admin)

```http
GET /analytics/campaigns?page=1&limit=10&status=ACTIVE&sortBy=createdAt&sortOrder=desc
Authorization: Bearer <admin_access_token>
```

Returns aggregated campaign metrics from rollup tables for admin dashboards.

#### Get Campaign Analytics

```http
GET /analytics/campaign/:campaignId
Authorization: Bearer <access_token>
```

### Distributions

#### Create Distribution

```http
POST /distributions
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "campaignId": "campaign_id",
  "beneficiaryId": "beneficiary_id",
  "amount": 500,
  "currency": "XLM",
  "method": "CRYPTO",
  "notes": "Emergency distribution"
}
```

#### Get Distributions

```http
GET /distributions?campaignId=campaign_id&page=1&limit=10
Authorization: Bearer <access_token>
```

#### Update Distribution Status

```http
PATCH /distributions/:id/status
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "status": "COMPLETED"
}
```

#### Add Proof Document

```http
POST /distributions/:id/proof
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "proofDocumentUrl": "https://storage.example.com/proof.pdf"
}
```

### Notifications

#### Get User Notifications

```http
GET /notifications?status=UNREAD&limit=20
Authorization: Bearer <access_token>
```

#### Mark as Read

```http
POST /notifications/:id/read
Authorization: Bearer <access_token>
```

#### Mark All as Read

```http
POST /notifications/read-all
Authorization: Bearer <access_token>
```

#### Delete Notification

```http
DELETE /notifications/:id
Authorization: Bearer <access_token>
```

#### Get Unread Count

```http
GET /notifications/unread-count
Authorization: Bearer <access_token>
```

## Error Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not Found |
| 409 | Conflict |
| 422 | Validation Error |
| 429 | Too Many Requests |
| 500 | Internal Server Error |

## Rate Limiting

- **General API**: 100 requests per 15 minutes
- **Authentication**: 5 requests per 15 minutes
- **Strict Endpoints**: 10 requests per minute

Rate limit headers are included in responses:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640995200
```

## WebSocket Events

### Connection

```javascript
const socket = io('wss://api.aidlink.org', {
  auth: {
    token: 'your_jwt_token'
  }
});
```

### Events

#### Join Campaign Room

```javascript
socket.emit('join_campaign', 'campaign_id');
```

#### Leave Campaign Room

```javascript
socket.emit('leave_campaign', 'campaign_id');
```

#### Receive Updates

```javascript
socket.on('donation_received', (data) => {
  console.log('New donation:', data);
});

socket.on('campaign_update', (data) => {
  console.log('Campaign updated:', data);
});

socket.on('distribution_sent', (data) => {
  console.log('Distribution sent:', data);
});
```

## Interactive Documentation

Interactive API documentation with Swagger UI is available at:

```
https://api.aidlink.org/api/docs
```

## SDKs

Official SDKs are available for:

- JavaScript/TypeScript
- Python
- Go
- Java

See the [SDK documentation](https://docs.aidlink.org/sdks) for more details.
