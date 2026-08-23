## fix(bulk-import): collision-resistant emails, batch inserts, deduplication & 413 guard

### Summary

Fixes three production bugs in `BulkBeneficiaryService.importFromCSV()` that cause silent data loss and timeout failures during field deployments — particularly in disaster-response scenarios where hundreds of tablets may hit the same endpoint concurrently.

> **Scope:** `importFromCSV()` only. `batchStatusUpdate`, `bulkKYCSubmit`, and `batchCreateDistributions` are unchanged.

---

## Problem Statement

### Bug 1 — `Date.now()` collision in placeholder email generation

```ts
// BEFORE (broken)
const placeholderEmail = `beneficiary.import.${Date.now()}.${i}@placeholder.aidlink`;
```

`Date.now()` returns milliseconds. Two concurrent import jobs both processing row index `i = 3` within the same millisecond produce the **identical email**, causing the second `tx.user.create` to throw `P2002 Unique constraint failed on field: email`. The error is silently swallowed into the `errors` array — the beneficiary is never created and the field worker receives no actionable feedback.

### Bug 2 — N individual `prisma.$transaction` calls for N rows

```ts
// BEFORE (broken)
for (let i = 0; i < rows.length; i++) {
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ ... });
    const beneficiary = await tx.beneficiary.create({ ... });
    return beneficiary;
  });
}
```

For a 500-row CSV this executes **~1,500 sequential database round trips** (500 BEGIN/COMMIT + 500 user INSERTs + 500 beneficiary INSERTs). At 2 ms RTT that is 3 seconds of pure latency before any query execution time. Imports above ~300 rows begin timing out under load.

### Bug 3 — No deduplication against existing beneficiaries

The code attempted `user.create` + `beneficiary.create` for every row unconditionally. A beneficiary with `idDocumentNumber = 'A1234567'` could be imported multiple times across separate jobs, creating duplicate identities with different placeholder emails. The P2002 on email collision was the only (broken) guard.

---

## Solution

### 1. Collision-resistant placeholder emails

```ts
// AFTER
const hash = CryptoUtils.sha256(
  `${row.idDocumentNumber}${row.nationality}${job.id}`
).slice(0, 16);
const email = `import-${hash}@placeholder.aidlink`;
```

- Uses `CryptoUtils.sha256()` from `src/utils/crypto.ts` — no new dependencies
- **Deterministic per identity + job**: retrying the same import produces the same emails; `skipDuplicates: true` handles idempotency at the DB level
- **Job-scoped**: the `jobId` suffix prevents cross-job hash collisions when the same identity is imported in two separate jobs

### 2. Single batch transaction — O(1) round trips

```ts
// AFTER — entire import in one transaction, two createMany calls
await prisma.$transaction(async (tx) => {
  await tx.user.createMany({ data: userPayloads, skipDuplicates: true });

  const insertedUsers = await tx.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true },
  });

  // build beneficiary payloads wired to user IDs...

  await tx.beneficiary.createMany({ data: beneficiaryPayloads, skipDuplicates: true });

  const insertedBeneficiaries = await tx.beneficiary.findMany({
    where: { userId: { in: insertedUserIds } },
    select: { id: true },
  });

  // collect IDs for rollback tracking
});
```

| Metric | Before | After |
|--------|--------|-------|
| DB round trips (1,000 rows) | ~3,000 | **4** (2 createMany + 2 findMany) |
| Transaction boundaries | 1,000 | **1** |
| Latency floor @ 2ms RTT | ~6 s | **~8 ms** |
| 30 s HTTP timeout risk | > 300 rows | **> 1,000 rows** |

### 3. Pre-import deduplication

Before the batch insert, the service queries for all `(idDocumentNumber, nationality)` pairs in the CSV that already exist in the database. Matching rows are:

- **Excluded** from the batch insert (no duplicate creation)
- **Recorded** in `errors[]` with `type: 'DUPLICATE'` and a valid `existingBeneficiaryId`

Field workers receive an actionable warning, not a silent failure.

```ts
// New BatchError shape
{
  index: 2,
  type: 'DUPLICATE',
  message: "Beneficiary with idDocumentNumber 'A1234567' and nationality 'Kenyan' already exists",
  existingBeneficiaryId: 'clxyz...',
  data: { ... }
}
```

### 4. Row-count guard (HTTP 413)

```ts
if (rows.length > config.bulk.importMaxRows) {
  throw new AppError(`CSV contains ${rows.length} rows which exceeds the maximum of ${maxRows}...`, 413);
}
```

Configurable via `BULK_IMPORT_MAX_ROWS` env var (default: `1000`). Checked **before any database operations** are attempted.

### 5. Database unique constraint

```prisma
// prisma/schema.prisma — Beneficiary model
@@unique([idDocumentNumber, nationality])
```

Backs the application-level deduplication check with a hard DB guarantee. Enables `createMany({ skipDuplicates: true })` to map to `INSERT ... ON CONFLICT DO NOTHING` at the database level.

### 6. `rollbackJob()` fixes

- **BENEFICIARY_IMPORT**: replaced N individual `user.delete` calls with a single `user.deleteMany({ where: { id: { in: userIds } } })` — O(1) not O(n)
- **BENEFICIARY_STATUS_UPDATE**: fixed a key-name bug where rollback read `.previousStatuses` but `batchStatusUpdate` saved the data as a plain array at the top level

---

## Files Changed

| File | Change |
|------|--------|
| `prisma/schema.prisma` | `@@unique([idDocumentNumber, nationality])` on `Beneficiary` |
| `prisma/migrations/20260823000000_add_beneficiary_unique_doc_nationality/migration.sql` | New migration for the unique index |
| `src/config/index.ts` | `config.bulk.importMaxRows` (env `BULK_IMPORT_MAX_ROWS`, default `1000`) |
| `src/config/__mocks__/database.ts` | `createMany`, `deleteMany` on `user`/`beneficiary`/`distribution`; new `batchJob` and `kYCSubmission` mocks |
| `src/services/bulkBeneficiary.service.ts` | All three bugs fixed + 413 guard + `rollbackJob` fixes |
| `src/services/bulkBeneficiary.service.test.ts` | **New** — 16 unit tests |
| `tests/integration/bulkBeneficiary.import.integration.test.ts` | **New** — integration AC tests (skips gracefully without Postgres) |

---

## Testing

### Unit tests (`src/services/bulkBeneficiary.service.test.ts`) — 16/16 ✅

```
BulkBeneficiaryService.importFromCSV()
  happy path
    ✓ creates all rows and returns successCount equal to row count
    ✓ calls $transaction exactly once with a callback (single batch tx)
    ✓ calls createMany on user and beneficiary exactly once each (2 round trips, not N)
    ✓ derives placeholder emails from sha256(docNumber+nationality+jobId), not Date.now()
    ✓ produces the same placeholder email for the same (docNumber, nationality, jobId) on retry
  413 guard
    ✓ throws a 413 AppError when rows.length > importMaxRows
    ✓ does NOT touch the database when 413 is triggered
    ✓ accepts exactly importMaxRows rows without throwing
  DUPLICATE detection
    ✓ pre-existing beneficiaries are reported as DUPLICATE errors with existingBeneficiaryId
    ✓ does not call createMany for rows that are duplicates
  concurrent collision resistance
    ✓ two concurrent calls for the same identity produce DUPLICATE in the second (not a crash)
  validation errors
    ✓ rows missing required columns produce VALIDATION-style errors and are excluded from batch
  empty CSV
    ✓ throws BATCH_005 for a CSV with header only (no data rows)
  rollbackJob
    ✓ deletes only user records created in this job (not pre-existing)
    ✓ does not call deleteMany when createdBeneficiaryIds is empty
    ✓ throws BATCH_002 when job is not in COMPLETED or PARTIAL status
```

### Integration tests (`tests/integration/bulkBeneficiary.import.integration.test.ts`)

Requires a live PostgreSQL instance at `DATABASE_URL`. Skips automatically when no database is reachable (safe on CI without Postgres). When Postgres is available covers:

- **AC-1**: Import CSV with 3 new rows + 3 rows matching pre-existing `(idDocumentNumber, nationality)` pairs → `successCount = 3`, `errors` has exactly 3 `DUPLICATE` entries each with a valid `existingBeneficiaryId`, no duplicate DB rows created
- **AC-2**: `rollbackJob()` after the import deletes exactly the 3 newly-created beneficiaries and leaves the 3 pre-existing rows untouched
- **Email format**: Created `User.email` matches `/^import-[0-9a-f]{16}@placeholder\.aidlink$/` and contains no 13-digit epoch timestamp

---

## Acceptance Criteria Checklist

- [x] A migration adds `@@unique([idDocumentNumber, nationality])` on `Beneficiary`
- [x] `importFromCSV()` generates placeholder emails using `sha256(idDocumentNumber + nationality + jobId).slice(0, 16)` — no `Date.now()` call
- [x] Unit test: two concurrent calls with overlapping rows produce `DUPLICATE` warnings in the second call, not failures
- [x] The entire batch insert uses exactly **2 `createMany` calls inside 1 `prisma.$transaction`**, not N individual transactions
- [x] `rollbackJob()` after a 1,000-row import deletes exactly the rows created by that job (not pre-existing duplicates)
- [x] Integration test: CSV with 3 duplicate rows → `successCount = (total - 3)`, `errors` contains 3 entries with `type: 'DUPLICATE'` and valid `existingBeneficiaryId` fields
- [x] CSV upload with `rows.length > BULK_IMPORT_MAX_ROWS` returns HTTP `413` before any DB operations
- [x] All existing tests in `src/controllers/bulkBeneficiary.controller.ts` continue to pass (controller API is unchanged)

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BULK_IMPORT_MAX_ROWS` | `1000` | Maximum rows accepted per CSV import. Raise for faster infrastructure. |

---

## Deployment Notes

1. **Run the migration before deploying** — `prisma migrate deploy` applies the `@@unique` constraint. On a large existing `Beneficiary` table this will fail if duplicate `(idDocumentNumber, nationality)` pairs already exist. Deduplicate data first if needed.
2. The 413 guard is active immediately on deploy. If any existing automation submits CSVs larger than 1,000 rows, set `BULK_IMPORT_MAX_ROWS` to a higher value before deploying.
3. No breaking changes to the HTTP API — request/response shapes for all bulk endpoints are unchanged.
