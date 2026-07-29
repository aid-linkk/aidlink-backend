import { parse as csvParse } from 'csv-parse/sync';
import prisma from '../config/database';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { BeneficiaryStatus, KYCStatus, DistributionMethod, BatchJobType, BatchJobStatus, NotificationType } from '@prisma/client';
import { NotificationService } from './notification.service';
import { invalidateBeneficiaryCache } from '../utils/cache';
import { toCsv } from '../utils/csv';

// ── Types ──────────────────────────────────────────────────────────────

export interface BatchError {
    index: number;
    message: string;
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
     * Each row creates a User (with a placeholder email) + Beneficiary.
     * Rolls back all created records if rollback is triggered.
     */
    static async importFromCSV(
        csvBuffer: Buffer,
        organizationUserId: string
    ): Promise<BatchJobResult> {
        const { rows, parseErrors } = parseBeneficiaryCSV(csvBuffer);

        if (rows.length === 0) {
            throw AppError.from('BATCH_005');
        }

        const job = await createJob(
            BatchJobType.BENEFICIARY_IMPORT,
            organizationUserId,
            rows.length,
            { source: 'csv_upload', columnCount: Object.keys(rows[0] ?? {}).length }
        );

        const errors: BatchError[] = [...parseErrors];
        const createdBeneficiaryIds: string[] = [];

        // Build a set of row indices that already failed parse validation
        const failedIndices = new Set(parseErrors.map((e) => e.index));

        for (let i = 0; i < rows.length; i++) {
            if (failedIndices.has(i)) continue;

            const row = rows[i];

            try {
                // Derive a deterministic placeholder email so we can create a User record
                const placeholderEmail = `beneficiary.import.${Date.now()}.${i}@placeholder.aidlink`;

                const result = await prisma.$transaction(async (tx) => {
                    const user = await tx.user.create({
                        data: {
                            email: placeholderEmail,
                            role: 'BENEFICIARY',
                            status: 'PENDING_VERIFICATION',
                        },
                    });

                    const beneficiary = await tx.beneficiary.create({
                        data: {
                            userId: user.id,
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
                            familySize: row.familySize ? parseInt(row.familySize) : 1,
                            needsAssessment: row.needsAssessment ?? null,
                            needsCategory: row.needsCategory ?? null,
                            status: BeneficiaryStatus.PENDING,
                        },
                    });

                    return beneficiary;
                });

                createdBeneficiaryIds.push(result.id);
            } catch (err) {
                errors.push({
                    index: i,
                    message: err instanceof Error ? err.message : String(err),
                    data: row as Record<string, unknown>,
                });
            }
        }

        const successCount = createdBeneficiaryIds.length;
        const failureCount = errors.length;

        const updated = await finalizeJob(job.id, successCount, failureCount, errors, {
            createdBeneficiaryIds,
        });

        logger.info(`Bulk import job ${job.id}: ${successCount} created, ${failureCount} failed`);

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
            const ids = (rollback.createdBeneficiaryIds ?? []) as string[];
            // Delete beneficiaries + their auto-created user records
            for (const beneficiaryId of ids) {
                try {
                    const b = await prisma.beneficiary.findUnique({
                        where: { id: beneficiaryId },
                        select: { userId: true },
                    });
                    if (b) {
                        await prisma.user.delete({ where: { id: b.userId } });
                        rolledBack++;
                    }
                } catch (err) {
                    logger.warn(`Rollback: failed to delete beneficiary ${beneficiaryId}:`, err);
                }
            }
        } else if (job.type === BatchJobType.BENEFICIARY_STATUS_UPDATE) {
            const snapshots = (rollback as { previousStatuses?: Array<{ id: string; previousStatus: string }> })
                .previousStatuses ?? [];
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
