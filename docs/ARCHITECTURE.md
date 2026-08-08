# AidLink Backend Architecture

## Overview

AidLink Backend is a production-grade, scalable backend system powering the AidLink humanitarian aid platform. It's built on modern technologies with a focus on security, performance, and blockchain integration.

## Technology Stack

- **Runtime**: Node.js 18+
- **Language**: TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL with Prisma ORM
- **Cache/Queue**: Redis with BullMQ
- **Real-time**: WebSockets (Socket.io)
- **Blockchain**: Soroban/Stellar
- **Containerization**: Docker & Docker Compose

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Client Layer                         │
│                    (Frontend, Mobile Apps)                    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           │ HTTPS / WebSocket
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      API Gateway Layer                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Express    │  │   Rate Limit │  │   Security   │      │
│  │   Server     │  │   Middleware │  │   Middleware │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Auth Service│  │Campaign Svc  │  │Beneficiary   │      │
│  └──────────────┘  └──────────────┘  │   Service    │      │
│  ┌──────────────┐  ┌──────────────┐  └──────────────┘      │
│  │ Donation Svc │  │Distribution  │  ┌──────────────┐      │
│  └──────────────┘  │   Service    │  │Notification  │      │
│  ┌──────────────┐  └──────────────┘  │   Service    │      │
│  │Blockchain Idx│                      └──────────────┘      │
│  └──────────────┘                                           │
└──────────────────────────┬──────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
           ▼               ▼               ▼
┌──────────────────┐ ┌──────────────┐ ┌──────────────┐
│   PostgreSQL    │ │    Redis     │ │   BullMQ     │
│   (Prisma)      │ │   (Cache)    │ │   (Queues)   │
└──────────────────┘ └──────────────┘ └──────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    External Services                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Soroban    │  │   Email      │  │   KYC        │      │
│  │   Network    │  │   Service    │  │   Provider   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

## Core Systems

### 1. Authentication System

**Components:**
- JWT-based authentication
- Wallet-based authentication (Stellar/Soroban)
- Role-based access control (RBAC)
- Session management with Redis

**Flow:**
```
Client → Login Request → Auth Service → Validate Credentials → Generate JWT → Store Session → Return Token
```

### 2. Campaign Engine

**Components:**
- Campaign creation and management
- Real-time fund tracking
- Beneficiary assignment
- Distribution tracking
- Milestone management

**Flow:**
```
Organization → Create Campaign → Assign Beneficiaries → Receive Donations → Track Funds → Distribute to Beneficiaries
```

### 3. Beneficiary Verification

**Components:**
- KYC workflow integration
- Fraud detection algorithms
- Verification queue with BullMQ
- Risk scoring system
- Automated KYC expiration (see below)

**Flow:**
```
Beneficiary → Submit KYC → Queue for Review → Risk Assessment → Manual/Auto Review → Approve/Reject
```

**KYC expiration automation:**

`KYCSubmission.expiresAt` is enforced by a repeatable BullMQ job registered
via `scheduleKYCExpirationJob()` in `src/workers/kyc.worker.ts` (started at
app boot in `src/index.ts`, alongside the other background workers). On the
configured interval it:

1. Scans `KYCSubmission` rows with `status = APPROVED` and `expiresAt <= now`
   (`BeneficiaryService.expireKYCSubmissions`, keyset-paginated).
2. Transitions each eligible row to `EXPIRED` inside a transaction that
   re-checks status/expiresAt immediately before writing (closes the race
   window between the scan and the write, so concurrent/repeated runs never
   double-process the same submission or send duplicate notifications), sets
   `reviewedAt` + `reviewNotes`, resets the linked `Beneficiary` to `PENDING`,
   and writes a `KYC_EXPIRED` audit log entry.
3. Dispatches a `KYC_STATUS_CHANGED` webhook event.
4. Sends a `KYC_EXPIRED` notification (in-app + email, subject to the
   beneficiary's notification/email preferences) telling the beneficiary
   their verification expired and linking to the resubmission flow.
5. Optionally alerts active `VERIFIER`/`ADMIN` users when a high-risk
   submission (`fraudScore` at or above a configurable threshold) expires.

Only `APPROVED` submissions with a defined `expiresAt` are ever matched —
`PENDING`, `UNDER_REVIEW`, `REJECTED`, and already-`EXPIRED` rows are left
untouched, so the scan is safe to run on any interval without reprocessing.

Configurable via environment variables (see `src/config/index.ts`,
`kycExpiration`):

| Variable | Default | Purpose |
|---|---|---|
| `KYC_EXPIRATION_ENABLED` | `true` | Feature flag; `false` disables the scheduled scan entirely |
| `KYC_EXPIRATION_CRON` | `0 * * * *` (hourly) | Cron pattern for the scan interval |
| `KYC_EXPIRATION_BATCH_SIZE` | `100` | Rows processed per keyset-pagination batch |
| `KYC_EXPIRATION_NOTIFY_ADMINS` | `true` | Whether high-risk expirations alert reviewers/admins |
| `KYC_EXPIRATION_HIGH_RISK_THRESHOLD` | `50` | Minimum `fraudScore` that triggers the admin alert |

### 4. Blockchain Indexer

**Components:**
- Soroban event listeners
- Transaction indexing
- Contract synchronization
- Real-time blockchain monitoring

**Flow:**
```
Soroban Network → Event Listener → Index Transaction → Store in DB → Trigger Notifications
```

### 5. Notification System

**Components:**
- Email notifications (Nodemailer)
- Real-time alerts (WebSockets)
- Push notification support
- Notification preferences

**Flow:**
```
Event → Create Notification → Queue Email Job → Send Email → WebSocket Update → Mark as Read
```

## Database Schema

### Key Entities

- **Users**: User accounts with roles and authentication
- **Organizations**: Aid organizations managing campaigns
- **Campaigns**: Fundraising campaigns with milestones
- **Donations**: Transaction records for contributions
- **Beneficiaries**: Aid recipients with verification status
- **Distributions**: Fund transfers to beneficiaries
- **KYCSubmissions**: Verification documents and status
- **BlockchainTransactions**: Indexed blockchain transactions
- **ContractEvents**: Smart contract events
- **Notifications**: User notifications
- **AuditLogs**: System audit trail

### Relationships

```
User (1) ──< Session (N)
User (1) ──< Organization (1)
User (1) ──< Beneficiary (1)
User (1) ──< Donation (N)
User (1) ──< Campaign (N)
Organization (1) ──< Campaign (N)
Campaign (1) ──< Donation (N)
Campaign (1) ──< BeneficiaryAssignment (N)
Campaign (1) ──< Distribution (N)
Beneficiary (1) ──< BeneficiaryAssignment (N)
Beneficiary (1) ──< Distribution (N)
Beneficiary (1) ──< KYCSubmission (N)
```

## API Design

### RESTful Endpoints

- **Authentication**: `/api/v1/auth/*`
- **Campaigns**: `/api/v1/campaigns/*`
- **Donations**: `/api/v1/donations/*`
- **Beneficiaries**: `/api/v1/beneficiaries/*`
- **Distributions**: `/api/v1/distributions/*`
- **Notifications**: `/api/v1/notifications/*`

### API Versioning

All endpoints are versioned using the `/api/v1/` prefix to support future API evolution without breaking changes.

### Documentation

Interactive API documentation is available at `/api/docs` using Swagger/OpenAPI.

## Security Architecture

### Security Layers

1. **Transport Layer**: HTTPS/TLS encryption
2. **Application Layer**: Helmet.js security headers
3. **Authentication**: JWT with short-lived access tokens
4. **Authorization**: Role-based access control
5. **Rate Limiting**: Request throttling per endpoint
6. **Input Validation**: Zod schema validation
7. **Audit Logging**: All actions logged for compliance

### Data Protection

- Passwords hashed with bcrypt
- Sensitive data encrypted at rest
- PII stored securely with access controls
- Regular security audits

## Scalability Architecture

### Horizontal Scaling

- Stateless API servers
- Redis for shared session storage
- Database connection pooling
- Load balancer ready

### Background Processing

- BullMQ for job queues
- Separate worker processes
- Redis-backed job persistence
- Automatic retry mechanism

### Caching Strategy

- Redis for session caching
- Query result caching
- API response caching
- Cache invalidation on updates

## Deployment Architecture

### Docker Compose (Development)

```
┌─────────────────────────────────────┐
│         Docker Network              │
│  ┌──────────┐  ┌──────────┐       │
│  │  API     │  │  Redis   │       │
│  │  Server  │  │          │       │
│  └──────────┘  └──────────┘       │
│  ┌──────────┐  ┌──────────┐       │
│  │  Email   │  │  KYC     │       │
│  │  Worker  │  │  Worker  │       │
│  └──────────┘  └──────────┘       │
│  ┌──────────┐  ┌──────────┐       │
│  │ Blockchain│  │  Postgres│      │
│  │  Worker   │  │          │      │
│  └──────────┘  └──────────┘       │
└─────────────────────────────────────┘
```

### Production Deployment

- Container orchestration (Kubernetes recommended)
- Managed PostgreSQL (AWS RDS, Google Cloud SQL)
- Managed Redis (AWS ElastiCache, Google Cloud Memorystore)
- CDN for static assets
- Load balancer with SSL termination
- Monitoring and alerting (Prometheus, Grafana)

## Monitoring & Observability

### Logging

- Structured logging with Winston
- Log levels: error, warn, info, debug
- Log aggregation in production
- Sensitive data redaction

### Health Checks

- `/health` endpoint for liveness
- Database connectivity checks
- Redis connectivity checks
- Worker process monitoring

### Metrics

- Request/response times
- Error rates
- Queue lengths
- Database query performance
- Blockchain sync status

## Development Workflow

### Local Development

```bash
# Install dependencies
npm install

# Setup environment
cp .env.example .env

# Run database migrations
npm run prisma:migrate

# Start development server
npm run dev
```

### Testing

```bash
# Run all tests
npm test

# Run integration tests
npm run test:integration

# Run load tests
npm run test:load
```

### Code Quality

```bash
# Lint code
npm run lint

# Format code
npm run format
```

## CI/CD Pipeline

### GitHub Actions

1. **Test Stage**: Run unit and integration tests
2. **Build Stage**: Build Docker image
3. **Push Stage**: Push to Docker registry
4. **Deploy Stage**: Deploy to production

### Branch Strategy

- `main`: Production branch
- `develop`: Development branch
- Feature branches: `feature/*`
- Hotfix branches: `hotfix/*`

## Performance Optimization

### Database

- Indexed queries
- Connection pooling
- Query optimization
- Read replicas for scaling

### API

- Response compression
- Pagination
- Field selection
- Caching headers

### Caching

- Redis for hot data
- CDN for static content
- Browser caching
- Edge caching

## Disaster Recovery

### Backup Strategy

- Daily database backups
- Point-in-time recovery
- Backup encryption
- Off-site backup storage

### High Availability

- Multi-region deployment
- Database failover
- Redis clustering
- Load balancer redundancy

## Compliance

### Data Protection

- GDPR compliance
- Data retention policies
- Right to be forgotten
- Data portability

### Audit Trail

- All user actions logged
- Immutable audit logs
- Regular audit reviews
- Compliance reporting
