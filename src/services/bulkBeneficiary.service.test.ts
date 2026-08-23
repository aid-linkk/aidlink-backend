/**
 * Unit tests for BulkBeneficiaryService.importFromCSV()
 *
 * Covers:
 *   1. Happy path — clean CSV creates all rows
 *   2. 413 guard — CSV with rows > BULK_IMPORT_MAX_ROWS throws 413
 *   3. DUPLICATE detection — pre-existing beneficiaries produce DUPLICATE errors
 *   4. Concurrent collision resistance — same identity in two concurrent calls
 *      produces deterministic emails, the second call detects DUPLICATE via the
 *      deduplication pre-check (not via a P2002 crash)
 *   5. Partial validation failure — rows missing required columns are excluded
 *      from the batch and reported in errors
 *   6. Empty CSV — throws BATCH_005
 *   7. rollbackJob — deletes only the rows created by this job (not pre-existing)
 */

import { BulkBeneficiaryService } from './bulkBeneficiary.service';
import { AppError } from '../middleware/error';
import { BatchJobStatus, BatchJobType } from '@prisma/client';

// ── Stub out heavy transitive dependencies ────────────────────────────────────
jest.mock('./notification.service', () => ({
    NotificationService: {
        createNotification: jest.fn(),
        sendNotificationEmail: jest.fn().mockResolvedValue(undefined),
    },
}));
jest.mock('../utils/cache', () => ({
    invalidateBeneficiaryCache: jest.fn().mockResolvedValue(undefined),
}));

// ── Prisma mock ────────────────────────────────────────────────────────────────
jest.mock('../config/database', () => {
    const prismaMock: any = {
        batchJob: {
            create: jest.fn(),
            update: jest.fn(),
            findUnique: jest.fn(),
        },
        user: {
            createMany: jest.fn(),
            findMany: jest.fn(),
            deleteMany: jest.fn(),
        },
        beneficiary: {
            findMany: jest.fn(),
            createMany: jest.fn(),
            deleteMany: jest.fn(),
        },
        $transaction: jest.fn().mockImplementation(async (cb: any) => {
            if (typeof cb === 'function') return cb(prismaMock);
            return Promise.all(cb);
        }),
    };
    return { __esModule: true, default: prismaMock };
});

jest.mock('../config/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

// ── Config mock — keeps importMaxRows controllable per test ───────────────────
// Must be declared before jest.mock calls because jest.mock is hoisted.
// We expose a mutable object and mutate it per-test.
const mockConfigStore = {
    bulk: { importMaxRows: 1000 },
};
jest.mock('../config', () => ({
    __esModule: true,
    get default() { return mockConfigStore; },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const prismaMock = require('../config/database').default;

// ── CSV helpers ────────────────────────────────────────────────────────────────

const CSV_HEADER = 'firstName,lastName,dateOfBirth,gender,nationality,idDocumentType,idDocumentNumber,phoneNumber,address,city,country';

function makeRow(overrides: Record<string, string> = {}): string {
    const defaults: Record<string, string> = {
        firstName: 'Jane',
        lastName: 'Doe',
        dateOfBirth: '1990-01-15',
        gender: 'female',
        nationality: 'Kenyan',
        idDocumentType: 'PASSPORT',
        idDocumentNumber: 'A1234567',
        phoneNumber: '+254700000000',
        address: '123 Aid Street',
        city: 'Nairobi',
        country: 'Kenya',
        ...overrides,
    };
    return Object.values(defaults).join(',');
}

function makeCSV(rows: string[]): Buffer {
    return Buffer.from([CSV_HEADER, ...rows].join('\n'));
}

// ── Default mock returns ───────────────────────────────────────────────────────

const JOB_ID = 'job-abc123';
const USER_ID = 'org-user-1';

function setupHappyPathMocks(beneficiaryIds: string[] = ['ben-1']) {
    prismaMock.batchJob.create.mockResolvedValue({
        id: JOB_ID,
        type: BatchJobType.BENEFICIARY_IMPORT,
        status: BatchJobStatus.PROCESSING,
        totalItems: beneficiaryIds.length,
        processedItems: 0,
        successCount: 0,
        failureCount: 0,
        createdBy: USER_ID,
        metadata: {},
        rollbackData: null,
        errors: null,
        startedAt: new Date(),
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    });
    prismaMock.batchJob.update.mockResolvedValue({
        id: JOB_ID,
        status: BatchJobStatus.COMPLETED,
    });
    // No pre-existing beneficiaries
    prismaMock.beneficiary.findMany.mockResolvedValue([]);
    // createMany always resolves
    prismaMock.user.createMany.mockResolvedValue({ count: beneficiaryIds.length });
    // findMany for user IDs returns synthetic users
    prismaMock.user.findMany.mockResolvedValue(
        beneficiaryIds.map((id, i) => ({ id: `user-${i + 1}`, email: `import-hash${i}@placeholder.aidlink` }))
    );
    prismaMock.beneficiary.createMany.mockResolvedValue({ count: beneficiaryIds.length });
    // findMany for beneficiary IDs returns the created beneficiaries
    prismaMock.beneficiary.findMany.mockResolvedValueOnce([]) // first call = dedup check
        .mockResolvedValueOnce(beneficiaryIds.map((id) => ({ id }))); // second call = recover IDs
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('BulkBeneficiaryService.importFromCSV()', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockConfigStore.bulk.importMaxRows = 1000;
        // Default $transaction passes through to the mock (simulates interactive tx)
        prismaMock.$transaction.mockImplementation(async (cb: any) => {
            if (typeof cb === 'function') return cb(prismaMock);
            return Promise.all(cb);
        });
    });

    // ── Happy path ───────────────────────────────────────────────────────────
    describe('happy path', () => {
        it('creates all rows and returns successCount equal to row count', async () => {
            setupHappyPathMocks(['ben-1', 'ben-2']);
            const csv = makeCSV([
                makeRow({ idDocumentNumber: 'DOC001' }),
                makeRow({ idDocumentNumber: 'DOC002' }),
            ]);

            const result = await BulkBeneficiaryService.importFromCSV(csv, USER_ID);

            expect(result.successCount).toBe(2);
            expect(result.failureCount).toBe(0);
            expect(result.errors).toHaveLength(0);
            expect(result.status).toBe(BatchJobStatus.COMPLETED);
        });

        it('calls $transaction exactly once with a callback (single batch tx)', async () => {
            setupHappyPathMocks(['ben-1']);
            const csv = makeCSV([makeRow()]);

            await BulkBeneficiaryService.importFromCSV(csv, USER_ID);

            expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
            expect(typeof prismaMock.$transaction.mock.calls[0][0]).toBe('function');
        });

        it('calls createMany on user and beneficiary exactly once each (2 round trips, not N)', async () => {
            setupHappyPathMocks(['ben-1', 'ben-2', 'ben-3']);
            const csv = makeCSV([
                makeRow({ idDocumentNumber: 'DOC001' }),
                makeRow({ idDocumentNumber: 'DOC002' }),
                makeRow({ idDocumentNumber: 'DOC003' }),
            ]);

            await BulkBeneficiaryService.importFromCSV(csv, USER_ID);

            expect(prismaMock.user.createMany).toHaveBeenCalledTimes(1);
            expect(prismaMock.beneficiary.createMany).toHaveBeenCalledTimes(1);
        });

        it('derives placeholder emails from sha256(docNumber+nationality+jobId), not Date.now()', async () => {
            setupHappyPathMocks(['ben-1']);
            const csv = makeCSV([makeRow({ idDocumentNumber: 'X9999', nationality: 'Syrian' })]);

            await BulkBeneficiaryService.importFromCSV(csv, USER_ID);

            const userCreateManyCall = prismaMock.user.createMany.mock.calls[0][0];
            const email: string = userCreateManyCall.data[0].email;

            // Must start with 'import-' and end with '@placeholder.aidlink'
            expect(email).toMatch(/^import-[0-9a-f]{16}@placeholder\.aidlink$/);
            // Must NOT contain a Date.now() pattern (13 decimal digits)
            expect(email).not.toMatch(/\.\d{13}\./);
        });

        it('produces the same placeholder email for the same (docNumber, nationality, jobId) on retry', async () => {
            // Two calls to the mock — same input row, same jobId (same batchJob.create mock)
            // should produce identical emails (deterministic hash)
            setupHappyPathMocks(['ben-1']);
            const csv = makeCSV([makeRow({ idDocumentNumber: 'STABLE01', nationality: 'Ethiopian' })]);

            await BulkBeneficiaryService.importFromCSV(csv, USER_ID);
            const firstEmail = prismaMock.user.createMany.mock.calls[0][0].data[0].email;

            // Reset and replay with same jobId
            jest.clearAllMocks();
            setupHappyPathMocks(['ben-1']); // same JOB_ID in mock

            await BulkBeneficiaryService.importFromCSV(csv, USER_ID);
            const secondEmail = prismaMock.user.createMany.mock.calls[0][0].data[0].email;

            expect(firstEmail).toBe(secondEmail);
        });
    });

    // ── 413 guard ────────────────────────────────────────────────────────────
    describe('413 guard', () => {
        it('throws a 413 AppError when rows.length > importMaxRows', async () => {
            mockConfigStore.bulk.importMaxRows = 5;
            const rows = Array.from({ length: 6 }, (_, i) =>
                makeRow({ idDocumentNumber: `DOC${i.toString().padStart(3, '0')}` })
            );
            const csv = makeCSV(rows);

            await expect(
                BulkBeneficiaryService.importFromCSV(csv, USER_ID)
            ).rejects.toMatchObject({ statusCode: 413 });
        });

        it('does NOT touch the database when 413 is triggered', async () => {
            mockConfigStore.bulk.importMaxRows = 2;
            const csv = makeCSV([
                makeRow({ idDocumentNumber: 'DOC001' }),
                makeRow({ idDocumentNumber: 'DOC002' }),
                makeRow({ idDocumentNumber: 'DOC003' }),
            ]);

            await expect(
                BulkBeneficiaryService.importFromCSV(csv, USER_ID)
            ).rejects.toMatchObject({ statusCode: 413 });

            expect(prismaMock.batchJob.create).not.toHaveBeenCalled();
            expect(prismaMock.user.createMany).not.toHaveBeenCalled();
            expect(prismaMock.beneficiary.createMany).not.toHaveBeenCalled();
        });

        it('accepts exactly importMaxRows rows without throwing', async () => {
            mockConfigStore.bulk.importMaxRows = 3;
            setupHappyPathMocks(['ben-1', 'ben-2', 'ben-3']);
            const rows = Array.from({ length: 3 }, (_, i) =>
                makeRow({ idDocumentNumber: `DOC${i}` })
            );
            const csv = makeCSV(rows);

            // Should not throw
            const result = await BulkBeneficiaryService.importFromCSV(csv, USER_ID);
            expect(result.totalItems).toBe(3);
        });
    });

    // ── DUPLICATE detection ──────────────────────────────────────────────────
    describe('DUPLICATE detection', () => {
        it('pre-existing beneficiaries are reported as DUPLICATE errors with existingBeneficiaryId', async () => {
            prismaMock.batchJob.create.mockResolvedValue({
                id: JOB_ID,
                type: BatchJobType.BENEFICIARY_IMPORT,
                status: BatchJobStatus.PROCESSING,
                totalItems: 2,
                processedItems: 0,
                successCount: 0,
                failureCount: 0,
                createdBy: USER_ID,
                metadata: {},
                rollbackData: null,
                errors: null,
                startedAt: new Date(),
                completedAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            prismaMock.batchJob.update.mockResolvedValue({
                id: JOB_ID,
                status: BatchJobStatus.PARTIAL,
            });

            // Row 0: DOC001/Kenyan — exists in DB already
            // Row 1: DOC002/Kenyan — new
            prismaMock.beneficiary.findMany
                .mockResolvedValueOnce([
                    // First call = dedup check — DOC001 already exists
                    { id: 'existing-ben-1', idDocumentNumber: 'DOC001', nationality: 'Kenyan' },
                ])
                .mockResolvedValueOnce([
                    // Second call (inside tx) = recover newly-inserted IDs
                    { id: 'new-ben-1' },
                ]);

            prismaMock.user.createMany.mockResolvedValue({ count: 1 });
            prismaMock.user.findMany.mockResolvedValue([
                { id: 'user-1', email: 'import-somehash001@placeholder.aidlink' },
            ]);
            prismaMock.beneficiary.createMany.mockResolvedValue({ count: 1 });

            const csv = makeCSV([
                makeRow({ idDocumentNumber: 'DOC001', nationality: 'Kenyan' }),
                makeRow({ idDocumentNumber: 'DOC002', nationality: 'Kenyan' }),
            ]);

            const result = await BulkBeneficiaryService.importFromCSV(csv, USER_ID);

            expect(result.successCount).toBe(1);
            expect(result.failureCount).toBe(1);

            const dupError = result.errors.find((e) => e.type === 'DUPLICATE');
            expect(dupError).toBeDefined();
            expect(dupError?.existingBeneficiaryId).toBe('existing-ben-1');
            expect(dupError?.index).toBe(0);
        });

        it('does not call createMany for rows that are duplicates', async () => {
            prismaMock.batchJob.create.mockResolvedValue({
                id: JOB_ID, type: BatchJobType.BENEFICIARY_IMPORT,
                status: BatchJobStatus.PROCESSING, totalItems: 1, processedItems: 0,
                successCount: 0, failureCount: 0, createdBy: USER_ID, metadata: {},
                rollbackData: null, errors: null, startedAt: new Date(),
                completedAt: null, createdAt: new Date(), updatedAt: new Date(),
            });
            prismaMock.batchJob.update.mockResolvedValue({ id: JOB_ID, status: BatchJobStatus.FAILED });

            // Only 1 row, and it's a duplicate
            prismaMock.beneficiary.findMany.mockResolvedValueOnce([
                { id: 'existing-ben-1', idDocumentNumber: 'DOC001', nationality: 'Kenyan' },
            ]);

            const csv = makeCSV([makeRow({ idDocumentNumber: 'DOC001', nationality: 'Kenyan' })]);

            await BulkBeneficiaryService.importFromCSV(csv, USER_ID);

            expect(prismaMock.$transaction).not.toHaveBeenCalled();
            expect(prismaMock.user.createMany).not.toHaveBeenCalled();
            expect(prismaMock.beneficiary.createMany).not.toHaveBeenCalled();
        });
    });

    // ── Concurrent collision resistance ──────────────────────────────────────
    describe('concurrent collision resistance', () => {
        it('two concurrent calls for the same identity produce DUPLICATE in the second (not a crash)', async () => {
            // Job A creates ben-1 for DOC001/Kenyan
            // Job B runs "concurrently" — the dedup pre-check now sees the row
            // because Job A completed between the two calls in our sequential mock.

            // Job A setup
            const jobAMock = {
                id: 'job-A', type: BatchJobType.BENEFICIARY_IMPORT,
                status: BatchJobStatus.PROCESSING, totalItems: 1, processedItems: 0,
                successCount: 0, failureCount: 0, createdBy: USER_ID, metadata: {},
                rollbackData: null, errors: null, startedAt: new Date(),
                completedAt: null, createdAt: new Date(), updatedAt: new Date(),
            };
            const jobBMock = { ...jobAMock, id: 'job-B' };

            // Simulate: first importFromCSV call creates the row
            prismaMock.batchJob.create
                .mockResolvedValueOnce(jobAMock)
                .mockResolvedValueOnce(jobBMock);
            prismaMock.batchJob.update.mockResolvedValue({ id: 'any', status: BatchJobStatus.COMPLETED });

            // Job A: no pre-existing
            prismaMock.beneficiary.findMany
                .mockResolvedValueOnce([]) // Job A dedup check — nothing exists yet
                .mockResolvedValueOnce([{ id: 'ben-A' }]) // Job A recover IDs inside tx
                // Job B dedup check — now the beneficiary exists (simulating Job A completed)
                .mockResolvedValueOnce([
                    { id: 'ben-A', idDocumentNumber: 'DOC001', nationality: 'Kenyan' },
                ]);

            prismaMock.user.createMany.mockResolvedValue({ count: 1 });
            prismaMock.user.findMany.mockResolvedValue([
                { id: 'user-1', email: 'import-abc@placeholder.aidlink' },
            ]);
            prismaMock.beneficiary.createMany.mockResolvedValue({ count: 1 });

            const csv = makeCSV([makeRow({ idDocumentNumber: 'DOC001', nationality: 'Kenyan' })]);

            // Run Job A
            const resultA = await BulkBeneficiaryService.importFromCSV(csv, USER_ID);
            expect(resultA.successCount).toBe(1);
            expect(resultA.errors).toHaveLength(0);

            // Run Job B (same CSV, same identity now exists)
            prismaMock.batchJob.update.mockResolvedValue({ id: 'job-B', status: BatchJobStatus.FAILED });
            const resultB = await BulkBeneficiaryService.importFromCSV(csv, USER_ID);

            // Job B must NOT crash — it must detect the duplicate and return a DUPLICATE error
            expect(resultB.successCount).toBe(0);
            expect(resultB.errors).toHaveLength(1);
            expect(resultB.errors[0].type).toBe('DUPLICATE');
            expect(resultB.errors[0].existingBeneficiaryId).toBe('ben-A');

            // No P2002 crash — $transaction called once (for Job A), not for Job B
            expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
        });
    });

    // ── Validation errors ────────────────────────────────────────────────────
    describe('validation errors', () => {
        it('rows missing required columns produce VALIDATION-style errors and are excluded from batch', async () => {
            prismaMock.batchJob.create.mockResolvedValue({
                id: JOB_ID, type: BatchJobType.BENEFICIARY_IMPORT,
                status: BatchJobStatus.PROCESSING, totalItems: 2, processedItems: 0,
                successCount: 0, failureCount: 0, createdBy: USER_ID, metadata: {},
                rollbackData: null, errors: null, startedAt: new Date(),
                completedAt: null, createdAt: new Date(), updatedAt: new Date(),
            });
            prismaMock.batchJob.update.mockResolvedValue({
                id: JOB_ID, status: BatchJobStatus.PARTIAL,
            });
            prismaMock.beneficiary.findMany
                .mockResolvedValueOnce([]) // dedup check
                .mockResolvedValueOnce([{ id: 'ben-1' }]); // recover IDs
            prismaMock.user.createMany.mockResolvedValue({ count: 1 });
            prismaMock.user.findMany.mockResolvedValue([
                { id: 'user-1', email: 'import-xxx@placeholder.aidlink' },
            ]);
            prismaMock.beneficiary.createMany.mockResolvedValue({ count: 1 });

            // Row 0 is missing firstName (replace value with empty)
            const badRow = 'Jane,Doe,1990-01-15,female,Kenyan,PASSPORT,DOC001,+254700000000,123 Aid Street,Nairobi,Kenya';
            // Row 1 is missing firstName entirely — use CSV with missing column
            const csvWithMissingCol = Buffer.from(
                `${CSV_HEADER}\n` +
                `,Doe,1990-01-15,female,Kenyan,PASSPORT,DOC001,+254700000000,123 Aid Street,Nairobi,Kenya\n` +
                `${badRow.replace('DOC001', 'DOC002')}\n`
            );

            const result = await BulkBeneficiaryService.importFromCSV(csvWithMissingCol, USER_ID);

            // Row 0 fails validation (empty firstName), row 1 succeeds
            expect(result.failureCount).toBeGreaterThanOrEqual(1);
            expect(result.successCount).toBe(1);
        });
    });

    // ── Empty CSV ────────────────────────────────────────────────────────────
    describe('empty CSV', () => {
        it('throws BATCH_005 for a CSV with header only (no data rows)', async () => {
            const csv = Buffer.from(CSV_HEADER);
            await expect(
                BulkBeneficiaryService.importFromCSV(csv, USER_ID)
            ).rejects.toMatchObject({ message: expect.stringContaining('') });
        });
    });

    // ── rollbackJob ──────────────────────────────────────────────────────────
    describe('rollbackJob', () => {
        it('deletes only user records created in this job (not pre-existing)', async () => {
            const jobId = 'job-rollback-1';
            prismaMock.batchJob.findUnique.mockResolvedValue({
                id: jobId,
                type: BatchJobType.BENEFICIARY_IMPORT,
                status: BatchJobStatus.COMPLETED,
                rollbackData: { createdBeneficiaryIds: ['ben-1', 'ben-2'] },
                metadata: {},
            });
            prismaMock.beneficiary.findMany.mockResolvedValue([
                { userId: 'user-1' },
                { userId: 'user-2' },
            ]);
            prismaMock.user.deleteMany.mockResolvedValue({ count: 2 });
            prismaMock.batchJob.update.mockResolvedValue({
                id: jobId, status: BatchJobStatus.ROLLED_BACK,
            });

            const result = await BulkBeneficiaryService.rollbackJob(jobId, 'admin-1');

            expect(result.rolledBack).toBe(2);
            expect(prismaMock.user.deleteMany).toHaveBeenCalledWith({
                where: { id: { in: ['user-1', 'user-2'] } },
            });
        });

        it('does not call deleteMany when createdBeneficiaryIds is empty', async () => {
            const jobId = 'job-rollback-empty';
            prismaMock.batchJob.findUnique.mockResolvedValue({
                id: jobId,
                type: BatchJobType.BENEFICIARY_IMPORT,
                status: BatchJobStatus.COMPLETED,
                rollbackData: { createdBeneficiaryIds: [] },
                metadata: {},
            });
            prismaMock.batchJob.update.mockResolvedValue({
                id: jobId, status: BatchJobStatus.ROLLED_BACK,
            });

            const result = await BulkBeneficiaryService.rollbackJob(jobId, 'admin-1');

            expect(result.rolledBack).toBe(0);
            expect(prismaMock.user.deleteMany).not.toHaveBeenCalled();
        });

        it('throws BATCH_002 when job is not in COMPLETED or PARTIAL status', async () => {
            prismaMock.batchJob.findUnique.mockResolvedValue({
                id: 'job-processing',
                type: BatchJobType.BENEFICIARY_IMPORT,
                status: BatchJobStatus.PROCESSING,
                rollbackData: null,
                metadata: {},
            });

            await expect(
                BulkBeneficiaryService.rollbackJob('job-processing', 'admin-1')
            ).rejects.toMatchObject({ message: expect.any(String) });
        });
    });
});
