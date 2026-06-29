# API Reference

Base URL: `/api/v1`

All endpoints require authentication unless stated otherwise.

## Search (`/api/v1/search`)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/campaigns` | Search campaigns with filtering, pagination and sorting |
| GET | `/donations` | Search donations with filtering, pagination and sorting |
| GET | `/beneficiaries` | Search beneficiaries with filtering, pagination, sorting and facets |
| GET | `/global` | Global search across all entities |
| GET | `/advanced` | Advanced search with entity-type filtering |

### `GET /search/beneficiaries`

**Access:** Private — `ADMIN` and `VERIFIER` roles only (returns beneficiary PII).
Other authenticated roles receive `403 Insufficient permissions`.

Search beneficiaries with advanced filtering, pagination, sorting, and faceted
aggregation. Results, the total count, and all facet aggregates are computed in a
single database transaction so the facets always reflect a consistent snapshot.

Facets use **drill-down semantics**: each facet is counted with its *own* active
filter removed, so the UI can show alternative values to pivot to (e.g. after
filtering `country=KE`, the `countries` facet still lists other countries). As a
result, a facet's counts sum to the total only when that dimension is unfiltered.

#### Query parameters

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `q` | string | – | Free-text match on first name, last name, ID document number, phone number, and needs assessment |
| `country` | string | – | Filter by country |
| `city` | string | – | Filter by city |
| `needsCategory` | string | – | Filter by needs category |
| `verificationStatus` | enum | – | One of `PENDING`, `VERIFIED`, `REJECTED`, `SUSPENDED`, `ACTIVE` |
| `riskScoreMin` | int | – | Minimum risk score (inclusive) |
| `riskScoreMax` | int | – | Maximum risk score (inclusive) |
| `ageMin` | int | – | Minimum age in years (derived from date of birth) |
| `ageMax` | int | – | Maximum age in years (derived from date of birth) |
| `familySizeMin` | int | – | Minimum family size (inclusive) |
| `familySizeMax` | int | – | Maximum family size (inclusive) |
| `page` | int | `1` | Page number (min `1`) |
| `limit` | int | `20` | Page size (min `1`, max `100`) |
| `sortBy` | enum | `createdAt` | One of `relevance`, `createdAt`, `updatedAt`, `riskScore`, `age`, `familySize` |
| `sortOrder` | enum | `desc` | `asc` or `desc` |

Notes:
- `age` sorting is applied against `dateOfBirth` and inverted internally so that
  `sortOrder=desc` returns the oldest beneficiaries first.
- `relevance` currently falls back to recency (`createdAt`); there is no
  full-text relevance score yet.
- Range parameters are validated such that the `*Min` value must be less than or
  equal to the matching `*Max` value.

#### Response

```json
{
  "success": true,
  "data": [ /* Beneficiary[] */ ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 0,
    "totalPages": 0
  },
  "facets": {
    "countries": [{ "value": "KE", "count": 5 }],
    "cities": [{ "value": "Nairobi", "count": 3 }],
    "needsCategories": [{ "value": "FOOD", "count": 2 }],
    "verificationStatuses": [{ "value": "VERIFIED", "count": 4 }],
    "riskScoreRanges": [
      { "range": "0-25", "count": 0 },
      { "range": "26-50", "count": 0 },
      { "range": "51-75", "count": 0 },
      { "range": "76+", "count": 0 }
    ],
    "ageRanges": [
      { "range": "0-17", "count": 0 },
      { "range": "18-25", "count": 0 },
      { "range": "26-35", "count": 0 },
      { "range": "36-50", "count": 0 },
      { "range": "51-65", "count": 0 },
      { "range": "66+", "count": 0 }
    ],
    "familySizeRanges": [
      { "range": "1", "count": 0 },
      { "range": "2-3", "count": 0 },
      { "range": "4-5", "count": 0 },
      { "range": "6+", "count": 0 }
    ]
  }
}
```

#### Example

```
GET /api/v1/search/beneficiaries?country=KE&needsCategory=FOOD&ageMin=18&ageMax=40&riskScoreMin=50&sortBy=riskScore&sortOrder=desc&page=1&limit=20
```

#### Errors

| Status | Condition |
| --- | --- |
| `400` | Invalid search parameters (e.g. `ageMin` greater than `ageMax`, out-of-range values) |
| `401` | Missing or invalid authentication |
| `403` | Authenticated but not an `ADMIN`/`VERIFIER` |
| `429` | Rate limit exceeded |

#### Indexing / migration note

Beneficiary search relies on database indexes declared in `prisma/schema.prisma`:

- B-tree indexes on `country`, `city`, `riskScore`, `familySize`, `dateOfBirth`,
  `needsCategory`, plus composite `[country, city]` and `[status, country]`.
- GIN **trigram** indexes (`gin_trgm_ops`) on `firstName`, `lastName`,
  `idDocumentNumber`, `phoneNumber` so the `q` free-text search (`ILIKE '%term%'`)
  is index-backed instead of doing a sequential scan. These require the
  PostgreSQL `pg_trgm` extension, declared via the `postgresqlExtensions` preview
  feature.

Apply with a migration before deploying:

```bash
npx prisma migrate dev --name beneficiary_search_indexes
# (the generated migration includes CREATE EXTENSION IF NOT EXISTS pg_trgm)
```


---

# AidLink API — Tax Receipts

Tax receipts provide donors with an official PDF record of confirmed donations,
including tax-deduction information that varies by region. Receipts are generated
automatically when a donation is confirmed, stored in the configured storage
backend, emailed to the donor, and available for download via the API.

All routes are prefixed with `/api/v1`. All endpoints require a Bearer JWT
(`Authorization: Bearer <token>`).

---

## Lifecycle

1. A donation transitions to `CONFIRMED` (via `POST /donations/:id/confirm`).
2. If receipts are enabled and the donation is tied to a donor account, a
   `GENERATE_RECEIPT` job is enqueued (best-effort; never blocks confirmation).
3. The worker renders a branded PDF, stores it, creates an immutable
   `TaxReceipt` record, and enqueues a `SEND_RECEIPT_EMAIL` job.
4. The donor receives the receipt by email (with the PDF attached) and can
   download it any time from the API.

Generation is **idempotent** — the unique `donationId` constraint guarantees a
single receipt per donation even under concurrent generation.

---

## Donor endpoints

### `GET /donations/:donationId/receipt`

Downloads the receipt PDF.

- **Access:** the donor who owns the donation, the owning organization, or an
  `ADMIN` / `AUDITOR`.
- **Rate limit:** 20 requests/minute.
- **Response:** `200 OK`, `Content-Type: application/pdf`,
  `Content-Disposition: attachment; filename="RCPT-2026-XXXXX.pdf"`.
- Supports a single byte-range request (`Range: bytes=0-1023` → `206 Partial Content`).

| Status | Meaning |
| ------ | ------- |
| 200 / 206 | PDF returned (full / partial) |
| 401 | Not authenticated |
| 403 | Authenticated but not permitted to access this receipt |
| 404 | Receipt not yet generated for this donation |
| 410 | Receipt file is no longer available in storage |
| 416 | Requested range not satisfiable |

### `GET /donations/:donationId/receipt/status`

Lightweight status for portal polling.

- **Access:** same as above.
- **Response:** `200 OK`

```json
{
  "success": true,
  "data": {
    "generated": true,
    "generatedAt": "2026-06-21T10:00:00.000Z",
    "emailSent": true,
    "emailSentAt": "2026-06-21T10:00:05.000Z",
    "emailDeliveryStatus": "SENT",
    "receiptNumber": "RCPT-2026-1A2B3C4D5E",
    "fileUrl": "https://.../signed-url"
  }
}
```

When no receipt exists yet: `{ "generated": false, "emailSent": false }`.

---

## Admin endpoints

Mounted under `/api/v1/admin/receipts`.

### `GET /admin/receipts`

List receipts. **Access:** `ADMIN`, `AUDITOR`.

Query filters: `organizationId`, `donationId`, `donorId`, `emailStatus`
(`PENDING|SENT|BOUNCED|FAILED`), `dateFrom`, `dateTo`, `page`, `limit`
(max 100). Returns a paginated list with `pagination` metadata.

### `GET /admin/receipts/:receiptId`

Full receipt details + donor/organization summary. **Access:** `ADMIN`, `AUDITOR`.

### `POST /admin/receipts/generate-batch`

Starts an asynchronous batch generation job for confirmed donations that do not
yet have a receipt. **Access:** `ADMIN`.

Body (at least one filter required):

```json
{
  "organizationId": "org_123",
  "campaignId": "cmp_123",
  "donationIds": ["don_1", "don_2"],
  "dateRange": { "from": "2026-01-01", "to": "2026-06-30" },
  "region": "US"
}
```

Response `202 Accepted`:

```json
{ "success": true, "data": { "jobId": "job_123", "status": "PENDING", "totalMatched": 42 } }
```

### `GET /admin/receipts/batch-jobs/:jobId`

Batch job status/progress. **Access:** `ADMIN`, `AUDITOR`.

```json
{
  "success": true,
  "data": {
    "id": "job_123",
    "status": "PROCESSING",
    "progress": 75,
    "totalCount": 42,
    "generatedCount": 30,
    "failedCount": 1,
    "organizationId": "org_123",
    "createdAt": "2026-06-21T10:00:00.000Z",
    "completedAt": null
  }
}
```

### `POST /admin/receipts/:receiptId/resend-email`

Resends the receipt email to the donor. **Access:** `ADMIN`.

```json
{ "success": true, "data": { "sent": true, "timestamp": "2026-06-21T10:05:00.000Z" } }
```

---

## Multi-currency

The donation amount is formatted in its **original currency**. ISO currency
codes (USD, EUR, GBP, …) are formatted with the appropriate symbol and locale;
non-ISO / crypto codes (e.g. `XLM`) fall back to `"{amount} {CODE}"`.

## Regional tax requirements

Each region defines deductibility, the expected tax-ID label, language, and the
statement printed on the receipt. Built-in regions: `US`, `UK`, `CA`, `EU`,
`AU`, plus a `DEFAULT` fallback for unconfigured regions.

Override or extend the built-ins with the `REGIONAL_TAX_REQUIREMENTS`
environment variable (JSON merged over the defaults):

```json
{
  "US": { "taxDeductible": true, "requiredTaxId": "EIN", "language": "en-US", "statement": "This donation is tax-deductible as allowed by law." },
  "UK": { "taxDeductible": true, "requiredTaxId": "CHN", "language": "en-GB", "statement": "Gift Aid may be available." }
}
```

Invalid JSON is ignored (logged) and the built-in defaults are used.

---

## Configuration

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `RECEIPTS_ENABLED` | `true` | Master switch for generation/worker |
| `RECEIPT_STORAGE_PREFIX` | `receipts` | Key prefix within the storage backend |
| `RECEIPT_SENDER_EMAIL` | `EMAIL_FROM` | From address for receipt emails |
| `RECEIPT_URL_EXPIRY_SECONDS` | `86400` | Signed download URL lifetime |
| `RECEIPT_DEFAULT_REGION` | `US` | Region applied when none is supplied |
| `REGIONAL_TAX_REQUIREMENTS` | _(built-ins)_ | JSON overriding regional config |
| `RECEIPT_MAX_BATCH_SIZE` | `1000` | Max donations processed per batch job |
| `STORAGE_PROVIDER` | `local` | `local`, `s3`, or `azure` |

Storage files are written to `{RECEIPT_STORAGE_PREFIX}/{organizationId}/{donationId}_{timestamp}.pdf`.
Downloads use time-limited signed URLs / authenticated streaming. Receipt
**metadata is retained permanently for audit**; apply a separate retention
policy to the stored PDF files as required for GDPR compliance.

---

## Migration

The schema adds `TaxReceipt` and `ReceiptBatchJob` models, the
`ReceiptEmailStatus` / `ReceiptBatchJobStatus` enums, and a
`receiptGeneratedAt` column on `Donation`.

This repository keeps `prisma/migrations/` out of version control and applies
schema changes with `db push`:

```bash
npx prisma generate
npx prisma db push        # apply the new models/columns to the database
```

If you prefer a versioned migration, generate one locally with
`npx prisma migrate dev --name tax_receipts` (the resulting SQL only adds new
objects). Existing donations are unaffected — the new column is nullable and no
receipt is back-filled; use the batch endpoint to generate receipts for
historical donations.
