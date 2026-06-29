import { Worker, Job } from 'bullmq';
import { config } from '../config';
import { BeneficiaryService } from '../services/beneficiary.service';
import { assessFraud, getThirdPartyFraudScore } from '../services/kycFraud.service';
import { KYCStatus } from '@prisma/client';
import prisma from '../config/database';
import logger from '../config/logger';

const kycWorker = new Worker(
  'kyc-queue',
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
    connection: {
      host: config.bullmq.redisHost,
      port: config.bullmq.redisPort,
      password: config.bullmq.redisPassword,
    },
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
