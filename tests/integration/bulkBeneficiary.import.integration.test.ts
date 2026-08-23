/**
 * Integration test for BulkBeneficiaryService.importFromCSV()
 *
 * Tests against a real PostgreSQL instance to verify:
 *
 * AC-1 (3-duplicate import):
 *   Import a CSV with N unique rows + 3 rows whose (idDocumentNumber, nationality)
 *   already exist in the database.  After importFromCSV completes:
 *     - result.successCount === N (only new rows)
 *     - result.errors has exactly 3 entries with type === 'DUPLICATE'
 *     - each duplicate error has a valid existingBeneficiaryId pointing to a real row
 *     - no new beneficiary rows exist for the duplicate identities
 *
 * AC-2 (rollback correctness):
 *   After a successful import, rollbackJob() deletes exactly the N rows created
 *   by that job and leaves the 3 pre-existing beneficiaries untouched.
 *
 * Skips automatically when no database is reachable (DATABASE_URL unavailable or
 * connection refused) so `npm test` stays green on CI without Postgres.
 *
 * ⚠️  This test truncates the User and Beneficiary tables — do NOT run against
 *     a production database.
 */

import { PrismaClient, BatchJobStatus } from '@prisma/client';
import { BulkBeneficiaryService } from '../../src/services/bulkBeneficiary.service';

// The notification.service has a compiled JS artefact with a variable naming
// conflict that causes Jest's module parser to fail when it is required directly.
// We mock it here so the integration test can import the service under test
// without the transitive parse error.  The integration test never exercises the
// notification path.
jest.mock('../../src/services/notification.service', () => ({
    NotificationService: {
        createNotification: jest.fn(),
        sendNotificationEmail: jest.fn().mockResolvedValue(undefined),
    },
}));
jest.mock('../../src/utils/cache', () => ({
    invalidateBeneficiaryCache: jest.fn().mockResolvedValue(undefined),
}));

const prisma = new PrismaClient();

let dbAvailable = true;

// ── Database availability probe ───────────────────────────────────────────────

beforeAll(async () => {
    try {
        await prisma.$queryRaw`SELECT 1`;
    } catch {
        dbAvailable = false;
        // eslint-disable-next-line no-console
        console.warn(
            '[bulkBeneficiary.import.integration] No reachable Postgres at DATABASE_URL — skipping. ' +
            'Start one (e.g. docker-compose up postgres) and set DATABASE_URL to run this suite.'
        );
    }
});

afterAll(async () => {
    await prisma.$disconnect();
});

// ── Cleanup helpers ───────────────────────────────────────────────────────────

async function cleanTables() {
    // Cascade order: Beneficiary → User (Beneficiary.userId FK cascades via User.onDelete: Cascade)
    // Also clean BatchJob rows created during the test.
    await prisma.kYCSubmission.deleteMany({});
    await prisma.beneficiaryAssignment.deleteMany({});
    await prisma.distribution.deleteMany({});
    await prisma.beneficiary.deleteMany({});
    await prisma.batchJob.deleteMany({});
    await prisma.user.deleteMany({ where: { email: { contains: '@placeholder.aidlink' } } });
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

const CSV_HEADER = 'firstName,lastName,dateOfBirth,gender,nationality,idDocumentType,idDocumentNumber,phoneNumber,address,city,country';

function makeRow(
    idDocumentNumber: string,
    nationality = 'Kenyan',
    firstName = 'Jane',
    overrides: Record<string, string> = {}
): string {
    const row: Record<string, string> = {
        firstName,
        lastName: 'Doe',
        dateOfBirth: '1990-01-15',
        gender: 'female',
        nationality,
        idDocumentType: 'PASSPORT',
        idDocumentNumber,
        phoneNumber: '+254700000000',
        address: '123 Aid Street',
        city: 'Nairobi',
        country: 'Kenya',
        ...overrides,
    };
    return Object.values(row).join(',');
}

function makeCSV(rows: string[]): Buffer {
    return Buffer.from([CSV_HEADER, ...rows].join('\n'));
}

/** Helper: skip the test body cleanly when Postgres is unavailable. */
function skippable(name: string, fn: () => Promise<void>, timeout = 15_000) {
    it(name, async () => {
        if (!dbAvailable) return;
        await fn();
    }, timeout);
}

// ── Pre-seed helper ───────────────────────────────────────────────────────────

/**
 * Create 3 pre-existing beneficiaries in the DB that will collide with
 * rows in the CSV we import.  Returns their IDs.
 */
async function seedExistingBeneficiaries(): Promise<string[]> {
    const seeds = [
        { doc: 'EXIST001', nationality: 'Kenyan' },
        { doc: 'EXIST002', nationality: 'Ethiopian' },
        { doc: 'EXIST003', nationality: 'Somali' },
    ];

    const ids: string[] = [];
    for (const { doc, nationality } of seeds) {
        // Create a placeholder user so the FK is satisfied
        const user = await prisma.user.create({
            data: {
                email: `pre-existing.${doc.toLowerCase()}@placeholder.aidlink`,
                role: 'BENEFICIARY',
                status: 'PENDING_VERIFICATION',
            },
        });
        const ben = await prisma.beneficiary.create({
            data: {
                userId: user.id,
                firstName: 'Pre',
                lastName: 'Existing',
                dateOfBirth: new Date('1985-06-01'),
                gender: 'male',
                nationality,
                idDocumentType: 'NATIONAL_ID',
                idDocumentNumber: doc,
                phoneNumber: '+0000000000',
                address: 'Seed Address',
                city: 'SeedCity',
                country: 'Kenya',
                status: 'PENDING',
            },
        });
        ids.push(ben.id);
    }
    return ids;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('BulkBeneficiaryService.importFromCSV() — integration', () => {
    const ORG_USER_ID = 'org-integration-test-user';

    // Ensure we have a user record for ORG_USER_ID (batchJob.createdBy FK)
    beforeAll(async () => {
        if (!dbAvailable) return;
        await prisma.user.upsert({
            where: { email: 'org-integration@aidlink-test.internal' },
            update: {},
            create: {
                id: ORG_USER_ID,
                email: 'org-integration@aidlink-test.internal',
                role: 'ORGANIZATION',
                status: 'ACTIVE',
            },
        });
    });

    beforeEach(async () => {
        if (!dbAvailable) return;
        await cleanTables();
    });

    afterAll(async () => {
        if (!dbAvailable) return;
        await cleanTables();
        await prisma.user.deleteMany({ where: { id: ORG_USER_ID } });
    });

    // ── AC-1: 3-duplicate import ──────────────────────────────────────────
    describe('AC-1: 3-duplicate CSV import', () => {
        skippable('returns successCount = total - 3 and 3 DUPLICATE errors with valid existingBeneficiaryIds', async () => {
            // Seed 3 pre-existing beneficiaries
            const existingIds = await seedExistingBeneficiaries();

            // Build CSV: 3 new rows + 3 rows that match the pre-existing identities
            const newRows = [
                makeRow('NEW001', 'Ugandan'),
                makeRow('NEW002', 'Rwandan'),
                makeRow('NEW003', 'Sudanese'),
            ];
            const duplicateRows = [
                makeRow('EXIST001', 'Kenyan'),   // matches existingIds[0]
                makeRow('EXIST002', 'Ethiopian'), // matches existingIds[1]
                makeRow('EXIST003', 'Somali'),    // matches existingIds[2]
            ];
            const csv = makeCSV([...newRows, ...duplicateRows]);

            const result = await BulkBeneficiaryService.importFromCSV(csv, ORG_USER_ID);

            // ── successCount = 3 (new rows only) ──────────────────────────
            expect(result.successCount).toBe(3);

            // ── failureCount = 3 (duplicates only) ──────────────────────
            expect(result.failureCount).toBe(3);

            // ── errors array has exactly 3 DUPLICATE entries ──────────────
            const duplicateErrors = result.errors.filter((e) => e.type === 'DUPLICATE');
            expect(duplicateErrors).toHaveLength(3);

            // ── each DUPLICATE error has a valid existingBeneficiaryId ────
            const reportedExistingIds = duplicateErrors.map((e) => e.existingBeneficiaryId);
            for (const id of existingIds) {
                expect(reportedExistingIds).toContain(id);
            }

            // ── no new beneficiary rows created for EXIST001/002/003 ─────
            const dupBens = await prisma.beneficiary.findMany({
                where: {
                    OR: [
                        { idDocumentNumber: 'EXIST001', nationality: 'Kenyan' },
                        { idDocumentNumber: 'EXIST002', nationality: 'Ethiopian' },
                        { idDocumentNumber: 'EXIST003', nationality: 'Somali' },
                    ],
                },
            });
            // Exactly 3 rows (the pre-existing ones) — no duplicates created
            expect(dupBens).toHaveLength(3);

            // ── new rows ARE in the DB ─────────────────────────────────────
            const newBens = await prisma.beneficiary.findMany({
                where: {
                    OR: [
                        { idDocumentNumber: 'NEW001', nationality: 'Ugandan' },
                        { idDocumentNumber: 'NEW002', nationality: 'Rwandan' },
                        { idDocumentNumber: 'NEW003', nationality: 'Sudanese' },
                    ],
                },
            });
            expect(newBens).toHaveLength(3);
        });

        skippable('DUPLICATE error messages include the offending idDocumentNumber', async () => {
            await seedExistingBeneficiaries();
            const csv = makeCSV([makeRow('EXIST001', 'Kenyan')]);

            const result = await BulkBeneficiaryService.importFromCSV(csv, ORG_USER_ID);

            expect(result.errors[0].message).toContain('EXIST001');
        });
    });

    // ── AC-2: rollback deletes only newly-created rows ────────────────────
    describe('AC-2: rollback correctness', () => {
        skippable('rollbackJob deletes only the rows created by this job, leaves pre-existing rows intact', async () => {
            const existingIds = await seedExistingBeneficiaries();

            // Import 2 new rows + 1 duplicate
            const csv = makeCSV([
                makeRow('ROLLBACK001', 'Ugandan'),
                makeRow('ROLLBACK002', 'Rwandan'),
                makeRow('EXIST001', 'Kenyan'), // duplicate
            ]);

            const result = await BulkBeneficiaryService.importFromCSV(csv, ORG_USER_ID);
            expect(result.successCount).toBe(2);

            // Verify 2 new beneficiaries were created
            const newBensBefore = await prisma.beneficiary.findMany({
                where: {
                    OR: [
                        { idDocumentNumber: 'ROLLBACK001', nationality: 'Ugandan' },
                        { idDocumentNumber: 'ROLLBACK002', nationality: 'Rwandan' },
                    ],
                },
            });
            expect(newBensBefore).toHaveLength(2);

            // Rollback the job
            const rollbackResult = await BulkBeneficiaryService.rollbackJob(result.jobId, 'admin-test');
            expect(rollbackResult.rolledBack).toBe(2);

            // The 2 new beneficiaries should be gone
            const newBensAfter = await prisma.beneficiary.findMany({
                where: {
                    OR: [
                        { idDocumentNumber: 'ROLLBACK001', nationality: 'Ugandan' },
                        { idDocumentNumber: 'ROLLBACK002', nationality: 'Rwandan' },
                    ],
                },
            });
            expect(newBensAfter).toHaveLength(0);

            // The 3 pre-existing beneficiaries must still be intact
            const stillExisting = await prisma.beneficiary.findMany({
                where: { id: { in: existingIds } },
            });
            expect(stillExisting).toHaveLength(3);
        });
    });

    // ── Placeholder email format ───────────────────────────────────────────
    describe('placeholder email format', () => {
        skippable('created user records have collision-resistant placeholder emails (no Date.now())', async () => {
            const csv = makeCSV([makeRow('EMAILTEST001', 'Kenyan')]);

            await BulkBeneficiaryService.importFromCSV(csv, ORG_USER_ID);

            const user = await prisma.user.findFirst({
                where: { email: { contains: '@placeholder.aidlink' } },
            });

            expect(user).not.toBeNull();
            expect(user!.email).toMatch(/^import-[0-9a-f]{16}@placeholder\.aidlink$/);
            // No 13-digit epoch timestamp in the email
            expect(user!.email).not.toMatch(/\d{13}/);
        });
    });
});
