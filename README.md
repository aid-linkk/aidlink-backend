# AidLink Backend

Production-grade backend for AidLink - a blockchain-powered humanitarian aid platform built on Soroban/Stellar.

## Tech Stack

- **Runtime**: Node.js 18+
- **Language**: TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL with Prisma ORM
- **Cache/Queue**: Redis with BullMQ
- **Real-time**: WebSockets (Socket.io)
- **Blockchain**: Soroban/Stellar
- **Containerization**: Docker & Docker Compose

## Core Systems

### 1. Authentication System
- JWT-based authentication
- Wallet-based authentication (Stellar/Soroban)
- Role-based access control (RBAC)
- Session management with Redis

### 2. Campaign Engine
- Campaign creation and management
- Real-time fund tracking
- Beneficiary assignment
- Distribution tracking and verification

### 3. Beneficiary Verification
- KYC workflow integration
- Fraud detection algorithms
- Verification queue with BullMQ
- Document verification
- Risk score calculation

### 4. Blockchain Indexer
- Soroban event listeners
- Transaction indexing
- Contract synchronization
- Real-time blockchain monitoring

### 5. Notification System
- Email notifications (Nodemailer)
- Real-time alerts (WebSockets)
- Push notification support
- Notification preferences

### 6. Analytics & Reporting
- Campaign analytics and performance metrics
- Donor analytics and donation trends
- Organization analytics
- Platform-wide statistics
- Custom report generation

### 7. Advanced Search
- Global search across all entities
- Campaign search with filtering
- Donation search with filtering
- Beneficiary search with filtering
- Date range and amount range filters
- Sorting and pagination

### 8. Admin Dashboard
- Platform statistics overview
- User management
- Audit log viewing
- System health monitoring
- Real-time activity tracking

## Project Structure

```
aidlink-backend/
├── src/
│   ├── config/           # Configuration files
│   ├── controllers/      # Route controllers
│   ├── services/         # Business logic
│   ├── middleware/       # Express middleware
│   ├── models/           # Data models
│   ├── routes/           # API routes
│   ├── utils/            # Utility functions
│   ├── types/            # TypeScript types
│   ├── workers/          # Background job workers
│   ├── websocket/        # WebSocket handlers
│   ├── blockchain/       # Blockchain integration
│   └── index.ts          # Application entry point
├── prisma/
│   ├── schema.prisma     # Database schema
│   └── seed.ts           # Database seeder
├── tests/
│   ├── unit/             # Unit tests
│   ├── integration/      # Integration tests
│   └── load/             # Load tests
├── docker/
│   └── Dockerfile
├── docs/                 # Documentation
└── .env.example          # Environment variables template
```

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Redis 7+
- Docker & Docker Compose (optional)

### Installation

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Generate Prisma client
npm run prisma:generate

# Run database migrations
npm run prisma:migrate

# Seed database (optional)
npm run prisma:seed
```

### Development

```bash
# Start development server
npm run dev

# Start with Docker
npm run docker:up
```

### Production

```bash
# Build the project
npm run build

# Start production server
npm start
```

## API Documentation

Interactive Swagger UI is served at **`/api-docs`** when the server is running.
The raw OpenAPI 3.x spec is available at `/openapi.yaml`.

### What's documented

| Section | Coverage |
|---|---|
| REST endpoints | 99 routes across 11 route groups |
| Request/response schemas | Full JSON schemas with examples |
| Error responses | Consistent error envelope on every endpoint |
| Authentication | Bearer JWT — all secured endpoints annotated |
| Rate limits | Documented per-endpoint in descriptions |
| Webhooks | 6 events with HMAC verification example |
| WebSocket events | 8 server-push events with payload examples |
| Blockchain formats | Stellar payment tx, Soroban contract call formats |

### Running the spec locally

```bash
# Start server (spec served at /openapi.yaml, UI at /api-docs)
npm run dev
```

### Validating the spec

```bash
# Lint openapi.yaml with Spectral (must pass before merging)
npm run docs:validate

# Build openapi.json from openapi.yaml (for tooling that requires JSON)
npm run docs:build
```

### Running doc smoke tests

```bash
npm test -- --testPathPattern=tests/docs.spec.ts
```

### Contributing to API docs

The canonical spec lives in **`openapi.yaml`** at the repo root. Do **not** edit
`/api/docs` swagger JSDoc comments for new endpoints — use `openapi.yaml` directly.

#### Checklist for every new endpoint

1. Add the path + HTTP method under `paths:` in `openapi.yaml`.
2. Set a unique `operationId` (camelCase, verb + noun, e.g. `createCampaign`).
3. Assign at least one `tags` entry.
4. Document `security: [{bearerAuth: []}]` if the route calls `authenticate`.
5. Add `requestBody` with a concrete `example`.
6. Document all success responses and common errors (401, 403, 404, 422, 429).
7. If the endpoint emits a WebSocket event or webhook, add/update the
   `x-websocket-events` or `x-webhooks` section.
8. Run `npm run docs:validate` and fix any Spectral errors before opening a PR.

#### Style conventions

- Keep descriptions concise — one sentence of purpose, one of auth, one of rate limit.
- Use `$ref: '#/components/schemas/ErrorResponse'` for all error responses.
- Amounts are `type: string` (decimal string) to preserve precision.
- Dates are `type: string, format: date-time` (ISO 8601).

### API Endpoints

#### Authentication (`/api/v1/auth`)
- `POST /register` - Register a new user
- `POST /login` - User login
- `POST /wallet-auth` - Wallet-based authentication
- `POST /refresh` - Refresh access token
- `POST /logout` - User logout
- `GET /profile` - Get user profile

#### Campaigns (`/api/v1/campaigns`)
- `POST /` - Create a new campaign
- `GET /` - Get all campaigns
- `GET /:id` - Get campaign by ID
- `PUT /:id` - Update campaign
- `DELETE /:id` - Delete campaign
- `PATCH /:id/status` - Update campaign status
- `POST /:id/milestones` - Add milestone to campaign

#### Beneficiaries (`/api/v1/beneficiaries`)
- `POST /` - Create a beneficiary profile
- `GET /` - Get all beneficiaries
- `GET /my-profile` - Get current user's beneficiary profile
- `GET /:id` - Get beneficiary by ID
- `PUT /:id` - Update beneficiary profile
- `PATCH /:id/status` - Update beneficiary status
- `POST /:id/risk-score` - Calculate risk score
- `POST /:id/kyc` - Submit KYC documents
- `PATCH /kyc/:submissionId/review` - Review KYC submission

#### Donations (`/api/v1/donations`)
- `POST /` - Create a new donation
- `GET /` - Get all donations
- `GET /my-donations` - Get current user's donations
- `GET /campaign/:campaignId` - Get donations for a campaign
- `GET /:id` - Get donation by ID
- `POST /:id/confirm` - Confirm donation with blockchain
- `POST /:id/refund` - Refund a donation

#### Distributions (`/api/v1/distributions`)
- `POST /` - Create a new distribution
- `GET /` - Get all distributions
- `GET /campaign/:campaignId` - Get distributions for a campaign
- `GET /beneficiary/:beneficiaryId` - Get distributions for a beneficiary
- `POST /:id/confirm` - Confirm distribution with blockchain
- `PATCH /:id/status` - Update distribution status
- `POST /:id/proof` - Add proof document

#### Notifications (`/api/v1/notifications`)
- `POST /` - Create a notification
- `GET /` - Get user notifications
- `GET /unread-count` - Get unread notification count
- `PATCH /:id/read` - Mark notification as read
- `PATCH /read-all` - Mark all notifications as read
- `DELETE /:id` - Delete notification
- `POST /donation` - Send donation notification
- `POST /campaign-update` - Send campaign update notification
- `POST /distribution` - Send distribution notification

#### Admin (`/api/v1/admin`)
- `GET /dashboard` - Get dashboard statistics
- `GET /activity` - Get recent activity
- `GET /users` - Get all users
- `PATCH /users/:id/status` - Update user status
- `PATCH /users/:id/role` - Update user role
- `GET /audit-logs` - Get audit logs
- `GET /health` - Get system health

#### Analytics (`/api/v1/analytics`)
- `GET /campaign/:campaignId` - Get campaign analytics
- `GET /donor` - Get donor analytics
- `GET /organization/:organizationId` - Get organization analytics
- `GET /platform` - Get platform analytics
- `POST /report/:reportType` - Generate a report

#### Search (`/api/v1/search`)
- `GET /campaigns` - Search campaigns
- `GET /donations` - Search donations
- `GET /beneficiaries` - Search beneficiaries
- `GET /global` - Global search
- `GET /advanced` - Advanced search with filters

## Testing

```bash
# Run all tests
npm test

# Run unit tests
npm run test:unit

# Run integration tests
npm run test:integration

# Run load tests
npm run test:load
```

## Docker Deployment

```bash
# Build Docker images
npm run docker:build

# Start all services
npm run docker:up

# View logs
npm run docker:logs

# Stop services
npm run docker:down
```

## Environment Variables

See `.env.example` for all required environment variables.

## Security Features

- Helmet.js for security headers
- CORS configuration
- Global rate limiting
- Per-endpoint rate limiting (donations, campaigns, search, analytics, distributions, notifications)
- Request validation with Zod
- JWT authentication
- Audit logging
- Request logging middleware
- Secure environment management
- WebSocket authentication

## Monitoring

- Health check endpoint at `/health`
- Structured logging with Winston
- Performance metrics
- Error tracking

## License

MIT
