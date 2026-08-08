import { Worker, Queue, Job } from 'bullmq';
import { config } from '../config';
import { BeneficiaryService } from '../services/beneficiary.service';
import { assessFraud, getThirdPartyFraudScore } from '../services/kycFraud.service';
import { NotificationService } from '../services/notification.service';
import { KYCStatus, Role } from '@prisma/client';
import prisma from '../config/database';
import logger from '../config/logger';

const QUEUE_NAME = 'kyc-queue';

const connection = {
  host: config.bullmq.redisHost,
  port: config.bullmq.redisPort,
  password: config.bullmq.redisPassword,
};

// Producer — used to register the repeatable KYC expiration scan.
// (Event-driven jobs like CALCULATE_RISK_SCORE/AUTO_REVIEW_KYC/FRAUD_DETECTION
// are enqueued from BeneficiaryService against the same 'kyc-queue' name.)
export const kycQueue = new Queue(QUEUE_NAME, { connection });

/**
 * Register the periodic KYC expiration scan. No-op when
 * config.kycExpiration.enabled is false, so the feature flag fully gates
 * the automation. The check interval is configurable via
 * KYC_EXPIRATION_CRON (defaults to hourly).
 */
export const scheduleKYCExpirationJob = async (): Promise<void> => {
  if (!config.kycExpiration.enabled) {
    logger.info('KYC expiration automation disabled; skipping schedule');
    return;
  }

  await kycQueue.add(
    'EXPIRE_KYC_SUBMISSIONS',
    { type: 'EXPIRE_KYC_SUBMISSIONS', data: {} },
    {
      repeat: { pattern: config.kycExpiration.checkIntervalCron },
      jobId: 'kyc-expiration-scan',
      removeOnComplete: true,
      removeOnFail: 100,
    }
  );

  logger.info(`Scheduled KYC expiration scan: ${config.kycExpiration.checkIntervalCron}`);
};

const kycWorker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    const { type, data } = job.data;

    logger.info(`Processing KYC job: ${job.id}, type: ${type}`);

    try {
      switch (type) {
        case 'CALCULATE_RISK_SCORE':
          const riskScore = await BeneficiaryService.calculateRiskScore(data.beneficiaryId);
          logger.info(`Risk score calculated for beneficiary ${data.beneficiaryId}: ${riskScore}`);
          return { riskScore };

        case 'AUTO_REVIEW_KYC': {
          // calculateRiskScore() returns a number, not a beneficiary object
          const riskScore = await BeneficiaryService.calculateRiskScore(data.beneficiaryId);

          if (riskScore < 30) {
            // Low risk - auto approve
            await BeneficiaryService.reviewKYC(
              data.submissionId,
              KYCStatus.APPROVED,
              'Auto-approved: Low risk profile',
              data.systemUserId,
              'ADMIN'
            );
            logger.info(`Auto-approved submission ${data.submissionId}, riskScore: ${riskScore}`);
            return { status: 'approved', riskScore };
          } else if (riskScore > 70) {
            // High risk - auto reject
            await BeneficiaryService.reviewKYC(
              data.submissionId,
              KYCStatus.REJECTED,
              'Auto-rejected: High risk profile',
              data.systemUserId,
              'ADMIN'
            );
            logger.info(`Auto-rejected submission ${data.submissionId}, riskScore: ${riskScore}`);
            return { status: 'rejected', riskScore };
          }

          // Medium risk - requires manual review
          logger.info(`Manual review required for submission ${data.submissionId}, riskScore: ${riskScore}`);
          return { status: 'manual_review_required', riskScore };
        }

        case 'FRAUD_DETECTION': {
          logger.info(`Running fraud detection for submission ${data.submissionId}`);

          const submission = await prisma.kYCSubmission.findUnique({
            where: { id: data.submissionId as string },
            include: { beneficiary: { select: { country: true, city: true, idDocumentNumber: true } } },
          });

          if (!submission) {
            logger.warn(`FRAUD_DETECTION: submission ${data.submissionId} not found`);
            return { status: 'submission_not_found' };
          }

          const fraudInput = {
            submissionId: submission.id,
            beneficiaryId: submission.beneficiaryId,
            userId: submission.userId,
            documentUrl: submission.documentUrl,
            documentType: submission.documentType,
            selfieUrl: submission.selfieUrl,
            additionalDocs: submission.additionalDocs,
            ipAddress: (submission as any).ipAddress ?? null,
            userAgent: (submission as any).userAgent ?? null,
            deviceFingerprint: (submission as any).deviceFingerprint ?? null,
            claimedCountry: submission.beneficiary?.country ?? null,
            claimedCity: submission.beneficiary?.city ?? null,
          };

          const assessment = await assessFraud(fraudInput);

          // Optional third-party enrichment
          const thirdParty = await getThirdPartyFraudScore(fraudInput);
          if (thirdParty && thirdParty.score > 0) {
            assessment.fraudScore = Math.min(
              Math.round(assessment.fraudScore * 0.7 + thirdParty.score * 0.3),
              100,
            );
            assessment.fraudSignals.push(...thirdParty.signals);
            assessment.fraudReason += ' (enriched with third-party data)';
          }

          await prisma.kYCSubmission.update({
            where: { id: submission.id },
            data: {
              fraudScore: assessment.fraudScore,
              fraudSignals: assessment.fraudSignals,
              fraudReason: assessment.fraudReason,
            } as any,
          });

          logger.info(
            `Fraud detection complete for submission ${submission.id}: score=${assessment.fraudScore}, signals=${assessment.fraudSignals.length}`,
          );
          return { status: 'fraud_detection_completed', fraudScore: assessment.fraudScore, signalCount: assessment.fraudSignals.length };
        }

        case 'EXPIRE_KYC_SUBMISSIONS': {
          // Periodic scan (see scheduleKYCExpirationJob): marks APPROVED
          // submissions past their expiresAt as EXPIRED. Safe to run
          // repeatedly/concurrently — see BeneficiaryService.expireKYCSubmissions.
          const result = await BeneficiaryService.expireKYCSubmissions(
            (data && data.batchSize) || config.kycExpiration.batchSize
          );

          // Notify each newly-expired beneficiary, plus reviewers/admins for
          // high-risk cases. Each notification is dispatched independently
          // so one failure doesn't block the others or fail the job.
          let notified = 0;
          let adminAlerts = 0;

          let reviewerIds: string[] = [];
          const needsReviewerLookup =
            config.kycExpiration.notifyAdminsOnHighRisk &&
            result.expiredSubmissions.some(
              (s) => s.fraudScore >= config.kycExpiration.highRiskFraudScoreThreshold
            );
          if (needsReviewerLookup) {
            const reviewers = await prisma.user.findMany({
              where: { role: { in: [Role.VERIFIER, Role.ADMIN] }, status: 'ACTIVE' as any },
              select: { id: true },
            });
            reviewerIds = reviewers.map((r) => r.id);
          }

          for (const submission of result.expiredSubmissions) {
            try {
              await NotificationService.sendKYCExpiredNotification(
                submission.userId,
                submission.id,
                submission.expiresAt
              );
              notified += 1;
            } catch (err) {
              logger.error(
                `Failed to send KYC expiration notification for submission ${submission.id}:`,
                err
              );
            }

            if (
              config.kycExpiration.notifyAdminsOnHighRisk &&
              submission.fraudScore >= config.kycExpiration.highRiskFraudScoreThreshold &&
              reviewerIds.length > 0
            ) {
              const alerts = await Promise.allSettled(
                reviewerIds.map((reviewerId) =>
                  NotificationService.sendKYCExpirationAdminAlert(
                    reviewerId,
                    submission.id,
                    submission.userId,
                    submission.fraudScore
                  )
                )
              );
              if (alerts.some((a) => a.status === 'fulfilled')) adminAlerts += 1;
            }
          }

          logger.info(
            `KYC expiration scan complete: ${result.scanned} scanned, ${result.expired} expired, ` +
            `${notified} notified, ${adminAlerts} admin alerts, ${result.errors} errors`
          );
          return { status: 'expiration_scan_completed', ...result, notified, adminAlerts };
        }

        default:
          throw new Error(`Unknown KYC job type: ${type}`);
      }

      logger.info(`KYC job completed: ${job.id}`);
      return { status: 'completed' };
    } catch (error) {
      logger.error(`KYC job failed: ${job.id}`, error);
      throw error;
    }
  },
  {
    connection,
    concurrency: 5,
  }
);

kycWorker.on('completed', (job) => {
  logger.info(`KYC job completed: ${job.id}`);
});

kycWorker.on('failed', (job, err) => {
  logger.error(`KYC job failed: ${job?.id}`, err);
});

export default kycWorker;
