import { parse as csvParse } from 'csv-parse/sync';
import prisma from '../config/database';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { BeneficiaryStatus, KYCStatus, DistributionMethod, BatchJobType, BatchJobStatus, NotificationType } from '@prisma/client';
import { NotificationService } from './notification.service';
import { invalidateBeneficiaryCache } from '../utils/cache';
import { toCsv } from '../utils/csv';
import { CryptoUtils } from '../utils/crypto';
import config from '../config';

// ── Types ──────────────────────────────────────────────────────────────

/**
 * The type field distinguishes a hard failure (VALIDATION, RUNTIME) from a
 * soft deduplicate warning (DUPLICATE).  Callers may choose to treat DUPLICATE
 * rows differently (e.g. show a warning rather than an error to the field
 * worker).
 */
export type BatchErrorType = 'VALIDATION' | 'RUNTIME' | 'DUPLICATE';

export interface BatchError {
    index: number;
    /** Machine-readable error category. */
    type?: BatchErrorType;
    message: string;
    /** For DUPLICATE errors: the ID of the pre-existing beneficiary. */
    existingBeneficiaryId?: string;
    data?: Record<string, unknown>;
}

export interface BatchJobResult {
    jobId: string;
    status: BatchJobStatus;
    totalItems: number;
    processedItems: number;
    successCount: number;
    failureCount: number;
    errors: BatchError[];
}

export interface BulkStatusUpdateItem {
    beneficiaryId: string;
    status: BeneficiaryStatus;
    reason?: string;
}

export interface BulkKYCItem {
    beneficiaryId: string;
    documentType: string;
    documentUrl: string;
    submissionType: string;
    selfieUrl?: string;
}

export interface BulkDistributionItem {
    beneficiaryId: string;
    amount: number;
    method: DistributionMethod;
    notes?: string;
}

export interface BulkNotificationItem {
    beneficiaryId: string;
    title: string;
    message: string;
    metadata?: Record<string, unknown>;
}

// Required CSV columns for beneficiary import
const CSV_REQUIRED_COLUMNS = [
    'firstName', 'lastName', 'dateOfBirth', 'gender', 'nationality',
    'idDocumentType', 'idDocumentNumber', 'phoneNumber', 'address',
    'city', 'country',
] as const;

// ── CSV parsing helper ─────────────────────────────────────────────────

function parseBeneficiaryCSV(buffer: Buffer): { rows: Record<string, string>[]; parseErrors: BatchError[] } {
    let records: Record<string, string>[];

    try {
        records = csvParse(buffer, {
            columns: true,
            skip_empty_lines: true,
            trim: true,
        }) as Record<string, string>[];
    } catch (err) {
        throw AppError.from('BATCH_005', `CSV parse error: ${err instanceof Error ? err.message : String(err)}`);
    }

    const parseErrors: BatchError[] = [];

    records.forEach((row, index) => {
        const missing = CSV_REQUIRED_COLUMNS.filter((col) => !row[col]?.trim());
        if (missing.length > 0) {
            parseErrors.push({
                index,
                message: `Missing required columns: ${missing.join(', ')}`,
                data: row as Record<string, unknown>,
            });
        }
    });

    return { rows: records, parseErrors };
}

// ── Job helpers ────────────────────────────────────────────────────────

async function createJob(
    type: BatchJobType,
    createdBy: string,
    totalItems: number,
    metadata?: Record<string, unknown>
) {
    return prisma.batchJob.create({
        data: {
            type,
            status: BatchJobStatus.PROCESSING,
            createdBy,
            totalItems,
            startedAt: new Date(),
            metadata: metadata ?? {},
        },
    });
}

async function finalizeJob(
    jobId: string,
    successCount: number,
    failureCount: number,
    errors: BatchError[],
    rollbackData?: unknown
) {
    const status = failureCount === 0
        ? BatchJobStatus.COMPLETED
        : successCount === 0
            ? BatchJobStatus.FAILED
            : BatchJobStatus.PARTIAL;

    return prisma.batchJob.update({
        where: { id: jobId },
        data: {
            status,
            successCount,
            failureCount,
            processedItems: successCount + failureCount,
            errors: errors.length > 0 ? (errors as any) : undefined,
            rollbackData: rollbackData ? (rollbackData as any) : undefined,
            completedAt: new Date(),
        },
    });
}

// ── Service ────────────────────────────────────────────────────────────

export class BulkBeneficiaryService {

    /**
     * Import beneficiaries from a CSV buffer.
     *
     * Algorithm (O(1) round trips after parsing):
     *   1. Guard: reject oversized imports with HTTP 413 before touching the DB.
     *   2. Pre-import deduplication: query for any (idDocumentNumber, nationality)
     *      pairs that already exist.  Matching rows are recorded as DUPLICATE
     *      warnings and excluded from the batch insert.
     *   3. Derive collision-resistant placeholder emails using
     *      sha256(idDocumentNumber + nationality + jobId).slice(0, 16) so that
     *      concurrent imports for the same beneficiary identity converge to the
     *      same email and the ON CONFLICT DO NOTHING clause handles idempotency.
     *   4. Single prisma.$transaction with two createMany calls:
     *      - createMany users (skipDuplicates: true)
     *      - createMany beneficiaries (skipDuplicates: true)
     *   5. Recover created IDs with a findMany on the placeholder emails
     *      (one extra round trip, still O(1) total).
     */
    static async importFromCSV(
        csvBuffer: Buffer,
        organizationUserId: string
    ): Promise<BatchJobResult> {
        const { rows, parseErrors } = parseBeneficiaryCSV(csvBuffer);

        if (rows.length === 0) {
            throw AppError.from('BATCH_005');
        }

        // ── 413 guard ────────────────────────────────────────────────────────
        const maxRows = config.bulk.importMaxRows;
        if (rows.length > maxRows) {
            throw new AppError(
                `CSV contains ${rows.length} rows which exceeds the maximum of ${maxRows}. ` +
                `Split the file into smaller batches or raise BULK_IMPORT_MAX_ROWS.`,
                413
            );
        }

        // Create the batch job record first so we have a stable jobId to use
        // in the placeholder email hash.
        const job = await createJob(
            BatchJobType.BENEFICIARY_IMPORT,
            organizationUserId,
            rows.length,
            { source: 'csv_upload', columnCount: Object.keys(rows[0] ?? {}).length }
        );

        const errors: BatchError[] = [...parseErrors];

        // Build a set of row indices that already failed parse validation
        const failedIndices = new Set(parseErrors.map((e) => e.index));

        // Only process rows that passed validation
        const validRows = rows
            .map((row, index) => ({ row, index }))
            .filter(({ index }) => !failedIndices.has(index));

        // ── Pre-import deduplication ──────────────────────────────────────────
        // Query for existing beneficiaries matching any (idDocumentNumber, nationality)
        // in the current batch.  We use OR clauses rather than an IN on a composite
        // key because Prisma does not expose tuple IN syntax directly.
        const lookupPairs = validRows.map(({ row }) => ({
            idDocumentNumber: row.idDocumentNumber,
            nationality: row.nationality,
        }));

        const existingBeneficiaries = lookupPairs.length > 0
            ? await prisma.beneficiary.findMany({
                where: {
                    OR: lookupPairs,
                },
                select: { id: true, idDocumentNumber: true, nationality: true },
            })
            : [];

        // Build a lookup map: `${docNumber}:${nationality}` → beneficiary id
        const existingMap = new Map<string, string>(
            existingBeneficiaries.map((b) => [
                `${b.idDocumentNumber}:${b.nationality}`,
                b.id,
            ])
        );

        // Partition valid rows into new vs duplicate
        const newRows: Array<{ row: Record<string, string>; index: number }> = [];
        for (const { row, index } of validRows) {
            const key = `${row.idDocumentNumber}:${row.nationality}`;
            if (existingMap.has(key)) {
                errors.push({
                    index,
                    type: 'DUPLICATE',
                    message: `Beneficiary with idDocumentNumber '${row.idDocumentNumber}' and nationality '${row.nationality}' already exists`,
                    existingBeneficiaryId: existingMap.get(key),
                    data: row as Record<string, unknown>,
                });
            } else {
                newRows.push({ row, index });
            }
        }

        const createdBeneficiaryIds: string[] = [];

        if (newRows.length > 0) {
            // ── Derive collision-resistant placeholder emails ──────────────────
            // Email = import-{sha256(docNumber + nationality + jobId).slice(0,16)}@placeholder.aidlink
            // • Deterministic per beneficiary identity + job — retrying the same
            //   import produces the same email and skipDuplicates handles idempotency.
            // • The jobId suffix scopes the hash to this import job, preventing
            //   collisions when the same identity is imported across different jobs
            //   (which would produce the same hash without the jobId suffix and would
            //   be silently deduplicated by the User unique constraint on email).
            const userPayloads = newRows.map(({ row }) => {
                const hash = CryptoUtils.sha256(
                    `${row.idDocumentNumber}${row.nationality}${job.id}`
                ).slice(0, 16);
                return {
                    email: `import-${hash}@placeholder.aidlink`,
                    role: 'BENEFICIARY' as const,
                    status: 'PENDING_VERIFICATION' as const,
                };
            });

            // ── Single transaction: two createMany calls ──────────────────────
            try {
                await prisma.$transaction(async (tx) => {
                    // Step 1: batch insert users (ON CONFLICT DO NOTHING)
                    await tx.user.createMany({
                        data: userPayloads,
                        skipDuplicates: true,
                    });

                    // Step 2: recover the inserted user IDs so we can wire up the
                    // beneficiary foreign keys.  findMany on email IN (...) is one
                    // round trip regardless of batch size.
                    const emails = userPayloads.map((u) => u.email);
                    const insertedUsers = await tx.user.findMany({
                        where: { email: { in: emails } },
                        select: { id: true, email: true },
                    });

                    const emailToUserId = new Map(insertedUsers.map((u) => [u.email, u.id]));

                    // Step 3: build beneficiary payloads, skipping any rows whose
                    // user email did not end up in the DB (should not happen given
                    // skipDuplicates + prior deduplication, but guard defensively).
                    const beneficiaryPayloads = newRows
                        .map(({ row }) => {
                            const hash = CryptoUtils.sha256(
                                `${row.idDocumentNumber}${row.nationality}${job.id}`
                            ).slice(0, 16);
                            const email = `import-${hash}@placeholder.aidlink`;
                            const userId = emailToUserId.get(email);
                            if (!userId) return null;
                            return {
                                userId,
                                firstName: row.firstName,
                                lastName: row.lastName,
                                dateOfBirth: new Date(row.dateOfBirth),
                                gender: row.gender,
                                nationality: row.nationality,
                                idDocumentType: row.idDocumentType,
                                idDocumentNumber: row.idDocumentNumber,
                                phoneNumber: row.phoneNumber,
                                address: row.address,
                                city: row.city,
                                country: row.country,
                                coordinates: row.coordinates ?? null,
                                familySize: row.familySize ? parseInt(row.familySize, 10) : 1,
                                needsAssessment: row.needsAssessment ?? null,
                                needsCategory: row.needsCategory ?? null,
                                status: BeneficiaryStatus.PENDING,
                            };
                        })
                        .filter((p): p is NonNullable<typeof p> => p !== null);

                    // Step 4: batch insert beneficiaries (ON CONFLICT DO NOTHING)
                    await tx.beneficiary.createMany({
                        data: beneficiaryPayloads,
                        skipDuplicates: true,
                    });

                    // Step 5: recover the inserted beneficiary IDs for rollback tracking.
                    // Filter to only userIds we just inserted to avoid picking up any
                    // pre-existing beneficiaries that share a userId.
                    const insertedUserIds = Array.from(emailToUserId.values());
                    const insertedBeneficiaries = await tx.beneficiary.findMany({
                        where: { userId: { in: insertedUserIds } },
                        select: { id: true },
                    });

                    for (const b of insertedBeneficiaries) {
                        createdBeneficiaryIds.push(b.id);
                    }
                });
            } catch (err) {
                // The entire batch transaction failed — record as a runtime error
                // for all rows in this batch rather than silently swallowing it.
                for (const { row, index } of newRows) {
                    errors.push({
                        index,
                        type: 'RUNTIME',
                        message: err instanceof Error ? err.message : String(err),
                        data: row as Record<string, unknown>,
                    });
                }
            }
        }

        const successCount = createdBeneficiaryIds.length;
        const failureCount = errors.length;

        const updated = await finalizeJob(job.id, successCount, failureCount, errors, {
            createdBeneficiaryIds,
        });

        logger.info(`Bulk import job ${job.id}: ${successCount} created, ${failureCount} errors (${errors.filter((e) => e.type === 'DUPLICATE').length} duplicates)`);

        return {
            jobId: job.id,
            status: updated.status,
            totalItems: rows.length,
            processedItems: successCount + failureCount,
            successCount,
            failureCount,
            errors,
        };
    }

    /**
     * Batch status updates — update multiple beneficiaries' status in one call.
     */
    static async batchStatusUpdate(
        items: BulkStatusUpdateItem[],
        actorUserId: string
    ): Promise<BatchJobResult> {
        if (items.length === 0) throw AppError.from('BATCH_004');

        const job = await createJob(BatchJobType.BENEFICIARY_STATUS_UPDATE, actorUserId, items.length);

        const errors: BatchError[] = [];
        const rollbackData: Array<{ id: string; previousStatus: string }> = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            try {
                const existing = await prisma.beneficiary.findUnique({ where: { id: item.beneficiaryId } });

                if (!existing) {
                    errors.push({ index: i, message: `Beneficiary ${item.beneficiaryId} not found` });
                    continue;
                }

                rollbackData.push({ id: existing.id, previousStatus: existing.status });

                await prisma.beneficiary.update({
                    where: { id: item.beneficiaryId },
                    data: {
                        status: item.status,
                        verifiedAt: item.status === BeneficiaryStatus.VERIFIED ? new Date() : undefined,
                        verifiedBy: item.status === BeneficiaryStatus.VERIFIED ? actorUserId : undefined,
                    },
                });

                await invalidateBeneficiaryCache(item.beneficiaryId);
            } catch (err) {
                errors.push({
                    index: i,
                    message: err instanceof Error ? err.message : String(err),
                    data: item as unknown as Record<string, unknown>,
                });
            }
        }

        const successCount = items.length - errors.length;
        const updated = await finalizeJob(job.id, successCount, errors.length, errors, rollbackData);

        logger.info(`Batch status update job ${job.id}: ${successCount} updated, ${errors.length} failed`);

        return {
            jobId: job.id,
            status: updated.status,
            totalItems: items.length,
            processedItems: successCount + errors.length,
            successCount,
            failureCount: errors.length,
            errors,
        };
    }

    /**
     * Bulk KYC submission — submit KYC for multiple beneficiaries.
     */
    static async bulkKYCSubmit(
        items: BulkKYCItem[],
        actorUserId: string
    ): Promise<BatchJobResult> {
        if (items.length === 0) throw AppError.from('BATCH_004');

        const job = await createJob(BatchJobType.KYC_BULK_SUBMIT, actorUserId, items.length);

        const errors: BatchError[] = [];
        const createdSubmissionIds: string[] = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            try {
                const beneficiary = await prisma.beneficiary.findUnique({
                    where: { id: item.beneficiaryId },
                });

                if (!beneficiary) {
                    errors.push({ index: i, message: `Beneficiary ${item.beneficiaryId} not found` });
                    continue;
                }

                // Skip if there's already an active KYC submission
                const active = await prisma.kYCSubmission.findFirst({
                    where: {
                        beneficiaryId: item.beneficiaryId,
                        status: { in: [KYCStatus.PENDING, KYCStatus.UNDER_REVIEW] },
                    },
                });

                if (active) {
                    errors.push({
                        index: i,
                        message: `Beneficiary ${item.beneficiaryId} already has an active KYC submission`,
                    });
                    continue;
                }

                const submission = await prisma.kYCSubmission.create({
                    data: {
                        userId: beneficiary.userId,
                        beneficiaryId: item.beneficiaryId,
                        submissionType: item.submissionType,
                        documentType: item.documentType,
                        documentUrl: item.documentUrl,
                        selfieUrl: item.selfieUrl ?? null,
                        status: KYCStatus.PENDING,
                    },
                });

                createdSubmissionIds.push(submission.id);
            } catch (err) {
                errors.push({
                    index: i,
                    message: err instanceof Error ? err.message : String(err),
                    data: item as unknown as Record<string, unknown>,
                });
            }
        }

        const successCount = createdSubmissionIds.length;
        const updated = await finalizeJob(job.id, successCount, errors.length, errors, {
            createdSubmissionIds,
        });

        logger.info(`Bulk KYC submit job ${job.id}: ${successCount} submitted, ${errors.length} failed`);

        return {
            jobId: job.id,
            status: updated.status,
            totalItems: items.length,
            processedItems: successCount + errors.length,
            successCount,
            failureCount: errors.length,
            errors,
        };
    }

    /**
     * Batch distribution creation — create distributions for multiple beneficiaries under one campaign.
     */
    static async batchCreateDistributions(
        campaignId: string,
        items: BulkDistributionItem[],
        actorUserId: string
    ): Promise<BatchJobResult> {
        if (items.length === 0) throw AppError.from('BATCH_004');

        const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
        if (!campaign) throw AppError.from('CAMPAIGN_002');

        const job = await createJob(
            BatchJobType.DISTRIBUTION_BATCH_CREATE,
            actorUserId,
            items.length,
            { campaignId }
        );

        const errors: BatchError[] = [];
        const createdDistributionIds: string[] = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            try {
                // Verify beneficiary exists and is assigned to this campaign
                const assignment = await prisma.beneficiaryAssignment.findUnique({
                    where: {
                        campaignId_beneficiaryId: {
                            campaignId,
                            beneficiaryId: item.beneficiaryId,
                        },
                    },
                });

                if (!assignment) {
                    errors.push({
                        index: i,
                        message: `Beneficiary ${item.beneficiaryId} is not assigned to campaign ${campaignId}`,
                    });
                    continue;
                }

                const distribution = await prisma.distribution.create({
                    data: {
                        campaignId,
                        beneficiaryId: item.beneficiaryId,
                        amount: item.amount,
                        method: item.method,
                        notes: item.notes ?? '',
                        status: 'PENDING',
                    },
                });

                createdDistributionIds.push(distribution.id);
            } catch (err) {
                errors.push({
                    index: i,
                    message: err instanceof Error ? err.message : String(err),
                    data: item as unknown as Record<string, unknown>,
                });
            }
        }

        const successCount = createdDistributionIds.length;
        const updated = await finalizeJob(job.id, successCount, errors.length, errors, {
            createdDistributionIds,
        });

        logger.info(`Batch distributions job ${job.id}: ${successCount} created, ${errors.length} failed`);

        return {
            jobId: job.id,
            status: updated.status,
            totalItems: items.length,
            processedItems: successCount + errors.length,
            successCount,
            failureCount: errors.length,
            errors,
        };
    }

    /**
     * Bulk communication — send notifications to multiple beneficiaries.
     */
    static async bulkSendNotifications(
        items: BulkNotificationItem[],
        actorUserId: string
    ): Promise<BatchJobResult> {
        if (items.length === 0) throw AppError.from('BATCH_004');

        const job = await createJob(BatchJobType.BULK_NOTIFICATION, actorUserId, items.length);

        const errors: BatchError[] = [];
        const sentNotificationIds: string[] = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            try {
                const beneficiary = await prisma.beneficiary.findUnique({
                    where: { id: item.beneficiaryId },
                    select: { userId: true },
                });

                if (!beneficiary) {
                    errors.push({ index: i, message: `Beneficiary ${item.beneficiaryId} not found` });
                    continue;
                }

                const notification = await NotificationService.createNotification(
                    beneficiary.userId,
                    NotificationType.CAMPAIGN_UPDATE,
                    item.title,
                    item.message,
                    item.metadata
                );

                // Fire-and-forget email delivery
                NotificationService.sendNotificationEmail(beneficiary.userId, notification).catch((err) =>
                    logger.error(`Bulk notification email failed for beneficiary ${item.beneficiaryId}:`, err)
                );

                sentNotificationIds.push(notification.id);
            } catch (err) {
                errors.push({
                    index: i,
                    message: err instanceof Error ? err.message : String(err),
                    data: item as unknown as Record<string, unknown>,
                });
            }
        }

        const successCount = sentNotificationIds.length;
        const updated = await finalizeJob(job.id, successCount, errors.length, errors, {
            sentNotificationIds,
        });

        logger.info(`Bulk notifications job ${job.id}: ${successCount} sent, ${errors.length} failed`);

        return {
            jobId: job.id,
            status: updated.status,
            totalItems: items.length,
            processedItems: successCount + errors.length,
            successCount,
            failureCount: errors.length,
            errors,
        };
    }

    /**
     * Rollback a completed or partial batch job.
     * Supported types: BENEFICIARY_IMPORT, BENEFICIARY_STATUS_UPDATE, KYC_BULK_SUBMIT,
     * DISTRIBUTION_BATCH_CREATE.
     */
    static async rollbackJob(jobId: string, actorUserId: string): Promise<{ jobId: string; rolledBack: number }> {
        const job = await prisma.batchJob.findUnique({ where: { id: jobId } });

        if (!job) throw AppError.from('BATCH_001');

        if (
            job.status !== BatchJobStatus.COMPLETED &&
            job.status !== BatchJobStatus.PARTIAL
        ) {
            throw AppError.from('BATCH_002');
        }

        const rollback = (job.rollbackData ?? {}) as Record<string, unknown>;
        let rolledBack = 0;

        if (job.type === BatchJobType.BENEFICIARY_IMPORT) {
            // rollbackData was saved as { createdBeneficiaryIds: string[] }
            const ids = (rollback.createdBeneficiaryIds ?? []) as string[];
            if (ids.length > 0) {
                // Resolve user IDs for the beneficiaries created in this job, then
                // delete the user records (cascades to beneficiary via onDelete: Cascade).
                const beneficiaries = await prisma.beneficiary.findMany({
                    where: { id: { in: ids } },
                    select: { userId: true },
                });
                const userIds = beneficiaries.map((b) => b.userId);
                if (userIds.length > 0) {
                    const result = await prisma.user.deleteMany({ where: { id: { in: userIds } } });
                    rolledBack = result.count;
                }
            }
        } else if (job.type === BatchJobType.BENEFICIARY_STATUS_UPDATE) {
            // rollbackData was saved as a plain Array<{id, previousStatus}> (not nested)
            const snapshots = Array.isArray(rollback)
                ? (rollback as Array<{ id: string; previousStatus: string }>)
                : [];
            for (const snap of snapshots) {
                try {
                    await prisma.beneficiary.update({
                        where: { id: snap.id },
                        data: { status: snap.previousStatus as BeneficiaryStatus },
                    });
                    await invalidateBeneficiaryCache(snap.id);
                    rolledBack++;
                } catch (err) {
                    logger.warn(`Rollback: failed to revert status for ${snap.id}:`, err);
                }
            }
        } else if (job.type === BatchJobType.KYC_BULK_SUBMIT) {
            const ids = (rollback.createdSubmissionIds ?? []) as string[];
            if (ids.length > 0) {
                const result = await prisma.kYCSubmission.deleteMany({ where: { id: { in: ids } } });
                rolledBack = result.count;
            }
        } else if (job.type === BatchJobType.DISTRIBUTION_BATCH_CREATE) {
            const ids = (rollback.createdDistributionIds ?? []) as string[];
            if (ids.length > 0) {
                const result = await prisma.distribution.deleteMany({
                    where: { id: { in: ids }, status: 'PENDING' },
                });
                rolledBack = result.count;
            }
        }

        await prisma.batchJob.update({
            where: { id: jobId },
            data: {
                status: BatchJobStatus.ROLLED_BACK,
                metadata: {
                    ...(job.metadata as object ?? {}),
                    rolledBackBy: actorUserId,
                    rolledBackAt: new Date().toISOString(),
                    rolledBackCount: rolledBack,
                },
            },
        });

        logger.info(`Rollback job ${jobId} by ${actorUserId}: ${rolledBack} records reverted`);

        return { jobId, rolledBack };
    }

    /**
     * Get job status by ID.
     */
    static async getJobStatus(jobId: string) {
        const job = await prisma.batchJob.findUnique({ where: { id: jobId } });
        if (!job) throw AppError.from('BATCH_001');
        return job;
    }

    /**
     * List batch jobs for an actor.
     */
    static async listJobs(
        createdBy: string,
        type?: BatchJobType,
        page = 1,
        limit = 20
    ) {
        const where: Record<string, unknown> = { createdBy };
        if (type) where['type'] = type;

        const [jobs, total] = await Promise.all([
            prisma.batchJob.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                select: {
                    id: true,
                    type: true,
                    status: true,
                    totalItems: true,
                    processedItems: true,
                    successCount: true,
                    failureCount: true,
                    startedAt: true,
                    completedAt: true,
                    createdAt: true,
                },
            }),
            prisma.batchJob.count({ where }),
        ]);

        return {
            data: jobs,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    /**
     * Generate a CSV template for bulk beneficiary import.
     */
    static getImportTemplate(): string {
        return toCsv(
            [
                'firstName', 'lastName', 'dateOfBirth', 'gender', 'nationality',
                'idDocumentType', 'idDocumentNumber', 'phoneNumber', 'address',
                'city', 'country', 'coordinates', 'familySize', 'needsAssessment', 'needsCategory',
            ],
            [
                {
                    firstName: 'Jane', lastName: 'Doe', dateOfBirth: '1990-01-15',
                    gender: 'female', nationality: 'Kenyan', idDocumentType: 'PASSPORT',
                    idDocumentNumber: 'A1234567', phoneNumber: '+254700000000',
                    address: '123 Aid Street', city: 'Nairobi', country: 'Kenya',
                    coordinates: '{"lat":-1.286389,"lng":36.817223}', familySize: '4',
                    needsAssessment: 'Requires food and shelter', needsCategory: 'FOOD_SHELTER',
                },
            ]
        );
    }
}
