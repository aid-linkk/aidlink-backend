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
