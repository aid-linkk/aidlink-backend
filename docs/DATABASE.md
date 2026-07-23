# AidLink Backend Database Documentation

## Database Schema

The database is designed using PostgreSQL with Prisma ORM. The schema is normalized for performance and data integrity.

## Entity Relationship Diagram

```
┌─────────────┐       ┌──────────────┐       ┌─────────────┐
│    User     │───────│   Session    │       │ Organization│
└─────────────┘       └──────────────┘       └─────────────┘
       │                                           │
       │                                           │
       ▼                                           ▼
┌─────────────┐       ┌──────────────┐       ┌─────────────┐
│ Beneficiary │       │   Campaign   │───────│  Milestone  │
└─────────────┘       └──────────────┘       └─────────────┘
       │                   │
       │                   │
       ▼                   ▼
┌─────────────┐       ┌──────────────┐       ┌─────────────┐
│ KYCSubmission│      │   Donation   │       │ Distribution│
└─────────────┘       └──────────────┘       └─────────────┘
                            │
                            ▼
                   ┌──────────────┐
                   │BlockchainTx  │
                   └──────────────┘
```

## Tables

### User

Stores user account information and authentication data.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| email | String | User email (unique) |
| username | String | Username (unique, optional) |
| passwordHash | String | Hashed password |
| walletAddress | String | Stellar wallet address (unique, optional) |
| role | Enum | User role (ADMIN, ORGANIZATION, DONOR, BENEFICIARY, VERIFIER, AUDITOR) |
| status | Enum | Account status (ACTIVE, SUSPENDED, PENDING_VERIFICATION, REJECTED, DELETED) |
| emailVerified | Boolean | Email verification status |
| lastLogin | DateTime | Last login timestamp |
| createdAt | DateTime | Account creation timestamp |
| updatedAt | DateTime | Last update timestamp |

**Indexes:**
- email (unique)
- walletAddress (unique)
- role
- status

### Session

Stores user session information for JWT token management.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| userId | String | Foreign key to User |
| token | String | Access token (unique) |
| refreshToken | String | Refresh token (unique, optional) |
| userAgent | String | User agent string |
| ipAddress | String | IP address |
| expiresAt | DateTime | Token expiration |
| createdAt | DateTime | Session creation timestamp |

**Indexes:**
- userId
- token (unique)
- expiresAt

### Organization

Stores organization information for aid organizations.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| userId | String | Foreign key to User (unique) |
| name | String | Organization name |
| description | String | Organization description |
| website | String | Organization website |
| logo | String | Logo URL |
| registrationNumber | String | Official registration number |
| taxId | String | Tax identification number |
| status | Enum | Organization status (PENDING, APPROVED, SUSPENDED, REJECTED) |
| verifiedAt | DateTime | Verification timestamp |
| createdAt | DateTime | Creation timestamp |
| updatedAt | DateTime | Last update timestamp |

**Indexes:**
- userId (unique)
- status

### BankAccount

Stores organization bank account information.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| organizationId | String | Foreign key to Organization |
| bankName | String | Bank name |
| accountNumber | String | Account number |
| routingNumber | String | Routing number |
| accountType | String | Account type |
| isPrimary | Boolean | Primary account flag |
| createdAt | DateTime | Creation timestamp |
| updatedAt | DateTime | Last update timestamp |

**Indexes:**
- organizationId

### Campaign

Stores fundraising campaign information.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| organizationId | String | Foreign key to Organization |
| userId | String | Foreign key to User (campaign creator) |
| title | String | Campaign title |
| description | Text | Campaign description |
| imageUrl | String | Campaign image URL |
| targetAmount | Decimal | Target fundraising amount |
| currentAmount | Decimal | Current raised amount |
| startDate | DateTime | Campaign start date |
| endDate | DateTime | Campaign end date (optional) |
| status | Enum | Campaign status (DRAFT, ACTIVE, PAUSED, COMPLETED, CANCELLED) |
| blockchainTxHash | String | Blockchain transaction hash (unique, optional) |
| contractAddress | String | Smart contract address (optional) |
| createdAt | DateTime | Creation timestamp |
| updatedAt | DateTime | Last update timestamp |

**Indexes:**
- organizationId
- userId
- status
- startDate
- endDate

### Milestone

Stores campaign milestones for tracking progress.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| campaignId | String | Foreign key to Campaign |
| title | String | Milestone title |
| description | Text | Milestone description |
| targetAmount | Decimal | Target amount for milestone |
| achieved | Boolean | Achievement status |
| achievedAt | DateTime | Achievement timestamp |
| order | Int | Display order |
| createdAt | DateTime | Creation timestamp |
| updatedAt | DateTime | Last update timestamp |

**Indexes:**
- campaignId

### Donation

Stores donation transaction records.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| campaignId | String | Foreign key to Campaign |
| userId | String | Foreign key to User (donor, optional) |
| amount | Decimal | Donation amount |
| currency | String | Currency code (default: XLM) |
| status | Enum | Donation status (PENDING, CONFIRMED, FAILED, REFUNDED) |
| blockchainTxHash | String | Blockchain transaction hash (unique, optional) |
| fromWallet | String | Source wallet address |
| toWallet | String | Destination wallet address |
| memo | String | Transaction memo |
| isAnonymous | Boolean | Anonymous donation flag |
| donorMessage | Text | Donor message |
| createdAt | DateTime | Creation timestamp |
| updatedAt | DateTime | Last update timestamp |

**Indexes:**
- campaignId
- userId
- status
- blockchainTxHash (unique)
- createdAt

### Beneficiary

Stores beneficiary information for aid recipients.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| userId | String | Foreign key to User (unique) |
| firstName | String | First name |
| lastName | String | Last name |
| dateOfBirth | DateTime | Date of birth |
| gender | String | Gender |
| nationality | String | Nationality |
| idDocumentType | String | ID document type |
| idDocumentNumber | String | ID document number |
| phoneNumber | String | Phone number |
| address | Text | Physical address |
| city | String | City |
| country | String | Country |
| coordinates | String | GPS coordinates (JSON) |
| familySize | Int | Family size |
| needsAssessment | Text | Needs assessment |
| status | Enum | Beneficiary status (PENDING, VERIFIED, REJECTED, SUSPENDED, ACTIVE) |
| verifiedAt | DateTime | Verification timestamp |
| verifiedBy | String | Verifier user ID |
| riskScore | Int | Risk score (0-100) |
| createdAt | DateTime | Creation timestamp |
| updatedAt | DateTime | Last update timestamp |

**Indexes:**
- userId (unique)
- status
- country
- city
- riskScore

### BeneficiaryAssignment

Stores beneficiary-to-campaign assignments.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| campaignId | String | Foreign key to Campaign |
| beneficiaryId | String | Foreign key to Beneficiary |
| assignedAmount | Decimal | Assigned amount |
| allocatedAmount | Decimal | Allocated amount |
| priority | Int | Priority level |
| notes | Text | Assignment notes |
| assignedAt | DateTime | Assignment timestamp |
| assignedBy | String | Assigner user ID |

**Indexes:**
- campaignId_beneficiaryId (unique)
- campaignId
- beneficiaryId

### Distribution

Stores fund distribution records to beneficiaries.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| campaignId | String | Foreign key to Campaign |
| beneficiaryId | String | Foreign key to Beneficiary |
| amount | Decimal | Distribution amount |
| currency | String | Currency code (default: XLM) |
| method | Enum | Distribution method (CASH, BANK_TRANSFER, MOBILE_MONEY, CRYPTO, VOUCHER, IN_KIND) |
| status | Enum | Distribution status (PENDING, IN_PROGRESS, COMPLETED, FAILED, CANCELLED) |
| blockchainTxHash | String | Blockchain transaction hash (unique, optional) |
| transactionRef | String | Transaction reference |
| proofDocumentUrl | String | Proof document URL |
| notes | Text | Distribution notes |
| distributedAt | DateTime | Distribution timestamp |
| distributedBy | String | Distributor user ID |
| createdAt | DateTime | Creation timestamp |
| updatedAt | DateTime | Last update timestamp |

**Indexes:**
- campaignId
- beneficiaryId
- status
- distributedAt

### KYCSubmission

Stores KYC verification submissions.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| userId | String | Foreign key to User |
| beneficiaryId | String | Foreign key to Beneficiary (optional) |
| submissionType | Enum | Submission type (INDIVIDUAL, ORGANIZATION) |
| status | Enum | KYC status (PENDING, UNDER_REVIEW, APPROVED, REJECTED, EXPIRED) |
| documentType | String | Document type |
| documentUrl | String | Document URL |
| selfieUrl | String | Selfie photo URL (optional) |
| additionalDocs | Json | Additional documents (JSON) |
| reviewNotes | Text | Review notes |
| reviewedBy | String | Reviewer user ID |
| reviewedAt | DateTime | Review timestamp |
| expiresAt | DateTime | Expiration timestamp |
| fraudScore | Int | Fraud score (0-100) |
| createdAt | DateTime | Creation timestamp |
| updatedAt | DateTime | Last update timestamp |

**Indexes:**
- userId
- beneficiaryId
- status
- createdAt

### Notification

Stores user notifications.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| userId | String | Foreign key to User |
| type | Enum | Notification type (DONATION_RECEIVED, CAMPAIGN_UPDATE, DISTRIBUTION_SENT, KYC_APPROVED, KYC_REJECTED, SYSTEM_ALERT, SECURITY_ALERT) |
| title | String | Notification title |
| message | Text | Notification message |
| status | Enum | Notification status (UNREAD, READ, ARCHIVED) |
| metadata | Json | Additional metadata (JSON) |
| sentVia | String[] | Delivery channels |
| readAt | DateTime | Read timestamp |
| createdAt | DateTime | Creation timestamp |

**Indexes:**
- userId
- status
- type
- createdAt

### BlockchainTransaction

Stores indexed blockchain transactions.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| txHash | String | Transaction hash (unique) |
| type | Enum | Transaction type (DONATION, DISTRIBUTION, CONTRACT_DEPLOYMENT, CONTRACT_CALL, FEE_PAYMENT) |
| fromAddress | String | Source address |
| toAddress | String | Destination address |
| amount | Decimal | Transaction amount |
| currency | String | Currency code |
| contractAddress | String | Contract address |
| functionName | String | Function name |
| parameters | Json | Function parameters (JSON) |
| status | String | Transaction status |
| blockNumber | BigInt | Block number |
| timestamp | DateTime | Transaction timestamp |
| indexed | Boolean | Indexed flag |
| createdAt | DateTime | Creation timestamp |
| updatedAt | DateTime | Last update timestamp |

**Indexes:**
- txHash (unique)
- type
- status
- indexed
- blockNumber

### ContractEvent

Stores smart contract events.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| txHash | String | Transaction hash |
| contractAddress | String | Contract address |
| eventName | String | Event name |
| parameters | Json | Event parameters (JSON) |
| blockNumber | BigInt | Block number |
| timestamp | DateTime | Event timestamp |
| processed | Boolean | Processed flag |
| createdAt | DateTime | Creation timestamp |

**Indexes:**
- txHash
- contractAddress
- eventName
- processed

### AuditLog

Stores system audit trail.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| userId | String | Foreign key to User (optional) |
| action | Enum | Audit action (USER_CREATED, USER_UPDATED, USER_DELETED, LOGIN, LOGOUT, CAMPAIGN_CREATED, CAMPAIGN_UPDATED, CAMPAIGN_DELETED, DONATION_MADE, DISTRIBUTION_SENT, KYC_SUBMITTED, KYC_APPROVED, KYC_REJECTED, ROLE_CHANGED, SETTINGS_UPDATED) |
| entityType | String | Entity type |
| entityId | String | Entity ID (optional) |
| changes | Json | Changes made (JSON) |
| ipAddress | String | IP address |
| userAgent | String | User agent |
| metadata | Json | Additional metadata (JSON) |
| createdAt | DateTime | Creation timestamp |

**Indexes:**
- userId
- action
- entityType
- entityId
- createdAt

### QueueJob

Stores background job information.

| Column | Type | Description |
|--------|------|-------------|
| id | String (CUID) | Primary key |
| type | Enum | Job type (EMAIL_NOTIFICATION, BLOCKCHAIN_INDEXING, KYC_VERIFICATION, DISTRIBUTION_PROCESSING, REPORT_GENERATION, CACHE_INVALIDATION) |
| status | Enum | Job status (PENDING, PROCESSING, COMPLETED, FAILED, RETRYING) |
| payload | Json | Job payload (JSON) |
| result | Json | Job result (JSON, optional) |
| error | String | Error message (optional) |
| priority | Int | Job priority |
| attempts | Int | Attempt count |
| maxAttempts | Int | Maximum attempts |
| startedAt | DateTime | Start timestamp |
| completedAt | DateTime | Completion timestamp |
| createdAt | DateTime | Creation timestamp |
| updatedAt | DateTime | Last update timestamp |

**Indexes:**
- type
- status
- priority
- createdAt

## Database Migrations

### Running Migrations

```bash
# Development
npm run prisma:migrate

# Production
npx prisma migrate deploy
```

### Creating a Migration

```bash
npx prisma migrate dev --name migration_name
```

### Resetting Database (Development Only)

```bash
npx prisma migrate reset
```

## Seed Data

### Running Seed

```bash
npm run prisma:seed
```

## Performance Optimization

### Indexes

All frequently queried columns are indexed for performance. Review and add indexes as needed based on query patterns.

### Connection Pooling

The pool is auto-sized at startup from CPU count and the configured server
connection budget, and the resulting parameters (`connection_limit`,
`pool_timeout`, `connect_timeout`) are appended to `DATABASE_URL`. Any parameter
already present in the URL is preserved, so an explicit setting still wins:

```env
DATABASE_URL="postgresql://user:password@host:5432/db?schema=public&connection_limit=10"
```

Pool state, query latency percentiles and slow queries are exposed via
`GET /health/db` and `GET /api/v1/admin/database/metrics`.

See [DATABASE_POOLING.md](./DATABASE_POOLING.md) for the sizing formula, the
timeout model, every tuning variable, and how to profile connection behaviour
with `npm run db:profile`.

### Query Optimization

- Use `select` to limit returned fields
- Use `include` for relations instead of separate queries
- Use pagination for large result sets
- Avoid N+1 queries with proper includes

## Backup Strategy

### Automated Backups

```bash
# Daily backup script
pg_dump -U aidlink aidlink > backup_$(date +%Y%m%d).sql
```

### Restore from Backup

```bash
psql -U aidlink aidlink < backup_20240101.sql
```

## Monitoring

### Slow Query Log

Enable slow query logging in PostgreSQL:

```sql
ALTER SYSTEM SET log_min_duration_statement = 1000;
```

### Query Analysis

Use Prisma's query logging in development:

```typescript
const prisma = new PrismaClient({
  log: ['query', 'error', 'warn'],
});
```

## Security

### Data Encryption

- Passwords hashed with bcrypt
- Sensitive fields encrypted at rest
- SSL/TLS for database connections

### Access Control

- Database user with least privileges
- Row-level security for multi-tenant
- Audit logging for all changes
