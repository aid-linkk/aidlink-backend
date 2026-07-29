/**
 * BeneficiaryPortalService
 *
 * All self-service operations available to an authenticated beneficiary.
 * Every method starts by resolving the beneficiary from the caller's userId,
 * so there is no risk of one beneficiary accessing another's data.
 */

import prisma from '../config/database';
import { KYCStatus, DistributionStatus, NotificationType } from '@prisma/client';
import { AppError } from '../middleware/error';
import logger from '../config/logger';
import { StorageService } from './storage.service';
import { NotificationService } from './notification.service';
import { config } from '../config';
import { sanitizeString } from '../utils/sanitization';

// ── Types ──────────────────────────────────────────────────────────────

export interface ProfileUpdateInput {
    phoneNumber?: string;
    address?: string;
    city?: string;
    country?: string;
    coordinates?: string;
    familySize?: number;
    needsAssessment?: string;
    needsCategory?: string;
}

export interface KYCUploadInput {
    documentType: string;
    submissionType: string;
    /** Optional: device/network metadata for fraud scoring */
    ipAddress?: string;
    userAgent?: string;
    deviceFingerprint?: string;
}

export interface SupportTicketInput {
    subject: string;
    message: string;
    category: 'VERIFICATION' | 'DISTRIBUTION' | 'PROFILE' | 'OTHER';
}

// Allowed editable fields — beneficiaries cannot change identity or status fields
const EDITABLE_FIELDS: Array<keyof ProfileUpdateInput> = [
    'phoneNumber', 'address', 'city', 'country',
    'coordinates', 'familySize', 'needsAssessment', 'needsCategory',
];

// ── Helper: resolve beneficiary from userId (always the first step) ───

async function resolveBeneficiary(userId: string) {
    const beneficiary = await prisma.beneficiary.findUnique({
        where: { userId },
    });
    if (!beneficiary) {
        throw AppError.from('BENEFICIARY_001', 'No beneficiary profile found for your account');
    }
    return beneficiary;
}

// ── Service ────────────────────────────────────────────────────────────

export class BeneficiaryPortalService {

    /**
     * Full profile with KYC summary, assignment count, distribution summary.
     */
    static async getMyProfile(userId: string) {
        const beneficiary = await prisma.beneficiary.findUnique({
            where: { userId },
            include: {
                user: {
                    select: { id: true, email: true, username: true, emailVerified: true, createdAt: true },
                },
                kycSubmissions: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    select: {
                        id: true, status: true, submissionType: true, documentType: true,
                        reviewNotes: true, reviewedAt: true, expiresAt: true, createdAt: true,
                    },
                },
                _count: {
                    select: { assignments: true, distributions: true },
                },
            },
        });

        if (!beneficiary) {
            throw AppError.from('BENEFICIARY_001', 'No beneficiary profile found for your account');
        }

        // Distribution total received
        const distAgg = await prisma.distribution.aggregate({
            where: { beneficiaryId: beneficiary.id, status: DistributionStatus.COMPLETED },
            _sum: { amount: true },
            _count: true,
        });

        return {
            ...beneficiary,
            distributionSummary: {
                totalReceived: distAgg._sum.amount ?? 0,
                count: distAgg._count,
            },
        };
    }

    /**
     * Update mutable profile fields. Identity fields (name, DOB, ID doc) are
     * immutable after submission — only an admin/verifier can change them.
     */
    static async updateProfile(userId: string, input: ProfileUpdateInput) {
        const beneficiary = await resolveBeneficiary(userId);

        // Strip any keys not in the allow-list (defense-in-depth beyond Zod)
        const safeData: Record<string, unknown> = {};
        for (const key of EDITABLE_FIELDS) {
            if (input[key] !== undefined) {
                const val = input[key];
                safeData[key] = typeof val === 'string' ? sanitizeString(val) : val;
            }
        }

        if (Object.keys(safeData).length === 0) {
            throw new AppError('No valid fields provided for update', 400);
        }

        const updated = await prisma.beneficiary.update({
            where: { id: beneficiary.id },
            data: safeData,
        });

        logger.info(`Beneficiary portal: profile updated for ${beneficiary.id}`);
        return updated;
    }

    /**
     * Get current KYC/verification status — latest submission + history.
     */
    static async getVerificationStatus(userId: string) {
        const beneficiary = await resolveBeneficiary(userId);

        const submissions = await prisma.kYCSubmission.findMany({
            where: { beneficiaryId: beneficiary.id },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, status: true, submissionType: true, documentType: true,
                reviewNotes: true, reviewedAt: true, expiresAt: true, fraudScore: true,
                createdAt: true, updatedAt: true,
                documentHistory: {
                    orderBy: { replacedAt: 'desc' },
                    take: 3,
                    select: { field: true, replacedAt: true },
                },
            },
        });

        const latest = submissions[0] ?? null;
        const canSubmit = !latest || ![KYCStatus.PENDING, KYCStatus.UNDER_REVIEW].includes(latest.status);

        return {
            beneficiaryStatus: beneficiary.status,
            verifiedAt: beneficiary.verifiedAt,
            latestSubmission: latest,
            submissionHistory: submissions,
            canSubmit,
            ...(latest?.expiresAt && latest.expiresAt < new Date()
                ? { expired: true, expiredAt: latest.expiresAt }
                : {}),
        };
    }

    /**
     * Create a KYC submission then immediately attach the uploaded file buffer.
     * Returns { submission, documentUrl } so the caller has the persisted URL.
     */
    static async uploadKYCDocument(
        userId: string,
        fileBuffer: Buffer,
        field: 'document' | 'selfie',
        input: KYCUploadInput
    ) {
        const beneficiary = await resolveBeneficiary(userId);

        // Block if there's already an active submission
        const active = await prisma.kYCSubmission.findFirst({
            where: {
                beneficiaryId: beneficiary.id,
                status: { in: [KYCStatus.PENDING, KYCStatus.UNDER_REVIEW] },
            },
        });

        if (active && field === 'document') {
            // Allow uploading selfie to existing active submission
            throw AppError.from('BENEFICIARY_003');
        }

        // Upload the file first
        const { url, key } = await StorageService.upload('kyc-document', beneficiary.id, fileBuffer);

        let submission;

        if (field === 'document') {
            // Create a fresh submission with the document URL
            submission = await prisma.kYCSubmission.create({
                data: {
                    userId,
                    beneficiaryId: beneficiary.id,
                    submissionType: input.submissionType,
                    documentType: input.documentType,
                    documentUrl: url,
                    status: KYCStatus.PENDING,
                    ipAddress: input.ipAddress ?? null,
                    userAgent: input.userAgent ?? null,
                    deviceFingerprint: input.deviceFingerprint ?? null,
                },
            });
            logger.info(`Beneficiary portal: KYC document uploaded, submission ${submission.id}`);
        } else {
            // Attach selfie to the most recent submission (any non-expired status)
            const target = await prisma.kYCSubmission.findFirst({
                where: { beneficiaryId: beneficiary.id },
                orderBy: { createdAt: 'desc' },
            });

            if (!target) {
                throw new AppError('Upload a primary document before adding a selfie', 400);
            }

            const prev = target.selfieUrl;
            submission = await prisma.kYCSubmission.update({
                where: { id: target.id },
                data: { selfieUrl: url },
            });

            if (prev) {
                await prisma.kYCDocumentHistory.create({
                    data: { submissionId: target.id, field: 'selfie', replacedUrl: prev, newUrl: url, uploadedBy: userId },
                });
                StorageService.delete(StorageService.parseStorageKey(prev) ?? key).catch(() => { });
            }

            logger.info(`Beneficiary portal: selfie uploaded to submission ${target.id}`);
        }

        return { submission, uploadedUrl: url, field };
    }

    /**
     * Campaigns the beneficiary is currently assigned to.
     */
    static async getMyCampaigns(userId: string, page = 1, limit = 10) {
        const beneficiary = await resolveBeneficiary(userId);

        const skip = (page - 1) * limit;

        const [assignments, total] = await Promise.all([
            prisma.beneficiaryAssignment.findMany({
                where: { beneficiaryId: beneficiary.id },
                skip,
                take: limit,
                orderBy: { assignedAt: 'desc' },
                include: {
                    campaign: {
                        select: {
                            id: true, title: true, description: true, imageUrl: true,
                            status: true, startDate: true, endDate: true,
                            targetAmount: true, currentAmount: true,
                            organization: { select: { id: true, name: true, logo: true } },
                        },
                    },
                },
            }),
            prisma.beneficiaryAssignment.count({ where: { beneficiaryId: beneficiary.id } }),
        ]);

        return {
            data: assignments.map((a) => ({
                assignmentId: a.id,
                assignedAt: a.assignedAt,
                assignedAmount: a.assignedAmount,
                allocatedAmount: a.allocatedAmount,
                priority: a.priority,
                notes: a.notes,
                campaign: a.campaign,
            })),
            pagination: {
                page, limit, total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    /**
     * Distributions received by this beneficiary, with aggregate totals.
     */
    static async getMyDistributions(
        userId: string,
        page = 1,
        limit = 10,
        statusFilter?: DistributionStatus
    ) {
        const beneficiary = await resolveBeneficiary(userId);

        const where = {
            beneficiaryId: beneficiary.id,
            ...(statusFilter ? { status: statusFilter } : {}),
        };

        const skip = (page - 1) * limit;

        const [distributions, total, totals] = await Promise.all([
            prisma.distribution.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                include: {
                    campaign: {
                        select: {
                            id: true, title: true, imageUrl: true,
                            organization: { select: { id: true, name: true } }
                        },
                    },
                },
            }),
            prisma.distribution.count({ where }),
            // Aggregate only COMPLETED distributions for the summary card
            prisma.distribution.groupBy({
                by: ['currency'],
                where: { beneficiaryId: beneficiary.id, status: DistributionStatus.COMPLETED },
                _sum: { amount: true },
                _count: true,
            }),
        ]);

        return {
            data: distributions,
            summary: totals.map((t) => ({
                currency: t.currency,
                totalReceived: t._sum.amount ?? 0,
                count: t._count,
            })),
            pagination: {
                page, limit, total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    /**
     * Submit a support ticket — persisted as a notification to the support team
     * and a confirmation notification back to the beneficiary.
     */
    static async contactSupport(userId: string, input: SupportTicketInput) {
        const beneficiary = await resolveBeneficiary(userId);

        const subject = sanitizeString(input.subject.trim());
        const message = sanitizeString(input.message.trim());

        if (subject.length < 5) throw new AppError('Subject must be at least 5 characters', 400);
        if (message.length < 20) throw new AppError('Message must be at least 20 characters', 400);

        // Notify the beneficiary that their ticket was received
        const confirmationNotification = await NotificationService.createNotification(
            userId,
            NotificationType.SYSTEM_ALERT,
            `Support request received: ${subject}`,
            `We received your support request and will get back to you at the email on your account. ` +
            `Category: ${input.category}. Your message: "${message}"`,
            {
                ticketCategory: input.category,
                beneficiaryId: beneficiary.id,
                submittedAt: new Date().toISOString(),
            }
        );

        // Fire-and-forget confirmation email to beneficiary
        NotificationService.sendNotificationEmail(userId, confirmationNotification).catch((err) =>
            logger.error('Support ticket confirmation email failed:', err)
        );

        // Notify support team by emailing support address directly
        const supportHtml =
            `<p><strong>New support request from beneficiary ${beneficiary.id}</strong></p>` +
            `<p><strong>Category:</strong> ${input.category}</p>` +
            `<p><strong>Subject:</strong> ${subject}</p>` +
            `<p><strong>Message:</strong><br/>${message.replace(/\n/g, '<br/>')}</p>` +
            `<p><strong>User ID:</strong> ${userId}</p>` +
            `<p><strong>Beneficiary ID:</strong> ${beneficiary.id}</p>`;

        NotificationService.sendEmail(
            config.email.supportEmail,
            `[Beneficiary Support] ${subject}`,
            supportHtml
        ).catch((err) => logger.error('Support team email dispatch failed:', err));

        logger.info(`Beneficiary portal: support ticket submitted by ${beneficiary.id} — ${input.category}`);

        return {
            ticketId: confirmationNotification.id,
            subject,
            category: input.category,
            submittedAt: confirmationNotification.createdAt,
            message: 'Your support request has been received. Check your email for confirmation.',
        };
    }
}
