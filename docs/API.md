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

## Webhooks

Admin users can register HTTPS webhook endpoints for external integrations.

### Supported Events

- `donation.confirmed`
- `distribution.completed`
- `campaign.milestone_reached`
- `kyc.status_changed`

### Admin Endpoints

All webhook management endpoints require an admin bearer token.

```http
GET    /api/v1/admin/webhooks
POST   /api/v1/admin/webhooks
GET    /api/v1/admin/webhooks/:id
PUT    /api/v1/admin/webhooks/:id
DELETE /api/v1/admin/webhooks/:id
POST   /api/v1/admin/webhooks/:id/test
GET    /api/v1/admin/webhooks/:id/events
GET    /api/v1/admin/webhooks/events
GET    /api/v1/admin/webhooks/events/:eventId
```

Create payload:

```json
{
  "name": "Partner CRM",
  "url": "https://partner.example.com/aidlink/webhooks",
  "events": ["donation.confirmed", "distribution.completed"],
  "secret": "minimum-16-character-secret",
  "active": true,
  "description": "CRM integration",
  "deliverTestPayload": true
}
```

`DELETE /admin/webhooks/:id` disables the webhook so it stops receiving future deliveries while preserving delivery history.

### Payload Format

Webhook deliveries send JSON with this shape:

```json
{
  "id": "event-uuid",
  "type": "donation.confirmed",
  "timestamp": "2026-06-21T00:00:00.000Z",
  "resource": {
    "type": "donation",
    "id": "donation-id"
  },
  "data": {
    "donationId": "donation-id",
    "campaignId": "campaign-id"
  }
}
```

### Signature Verification

Each delivery includes:

```http
X-AidLink-Event: donation.confirmed
X-Hub-Signature-256: sha256=<hex-hmac>
```

To verify a delivery, compute `HMAC-SHA256` over the exact raw JSON request body with the webhook secret, encode the digest as lowercase hex, prefix it with `sha256=`, and compare it to `X-Hub-Signature-256` using a constant-time comparison.

### Delivery And Retries

Successful 2xx responses mark an event as `SENT`. Network errors, timeouts, and transient HTTP responses such as 408, 429, and 5xx remain `PENDING` until the next exponential-backoff retry or until `WEBHOOK_MAX_ATTEMPTS` is reached. Permanent 4xx responses are marked `FAILED` by default. Delivery attempts, response codes, response bodies, headers, retry counts, and errors are stored for admin inspection.

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
