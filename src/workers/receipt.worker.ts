import { Worker, Queue, Job } from 'bullmq';
import { config } from '../config';
import { ReceiptService } from '../services/receipt.service';
import logger from '../config/logger';

const QUEUE_NAME = 'receipt-queue';

const connection = {
  host: config.bullmq.redisHost,
  port: config.bullmq.redisPort,
  password: config.bullmq.redisPassword,
};

const defaultJobOpts = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 500,
};

let queue: Queue | null = null;
export function getReceiptQueue(): Queue {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, { connection });
  }
  return queue;
}

/** Enqueue receipt generation for a freshly confirmed donation (de-duplicated). */
export const enqueueReceiptGeneration = async (
  donationId: string,
  region?: string,
): Promise<void> => {
  await getReceiptQueue().add(
    'GENERATE_RECEIPT',
    { type: 'GENERATE_RECEIPT', data: { donationId, region } },
    { ...defaultJobOpts, jobId: `generate-receipt:${donationId}` },
  );
};

/** Enqueue (re)delivery of a receipt email. */
export const enqueueReceiptEmail = async (receiptId: string): Promise<void> => {
  await getReceiptQueue().add(
    'SEND_RECEIPT_EMAIL',
    { type: 'SEND_RECEIPT_EMAIL', data: { receiptId } },
    defaultJobOpts,
  );
};

/** Enqueue asynchronous processing of a batch generation job. */
export const enqueueBatchProcessing = async (jobId: string): Promise<void> => {
  await getReceiptQueue().add(
    'PROCESS_BATCH',
    { type: 'PROCESS_BATCH', data: { jobId } },
    { ...defaultJobOpts, jobId: `process-batch:${jobId}`, attempts: 1 },
  );
};

let worker: Worker | null = null;

/**
 * Starts the receipt worker. Called from the server bootstrap when receipts are
 * enabled. Idempotent — repeated calls return the existing worker.
 */
export function startReceiptWorker(): Worker {
  if (worker) {
    return worker;
  }

  worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { type, data } = job.data;
      logger.info(`Processing receipt job: ${job.id}, type: ${type}`);

      switch (type) {
        case 'GENERATE_RECEIPT': {
          const receipt = await ReceiptService.generateReceipt(data.donationId, {
            region: data.region,
            deliveryMethod: 'EMAIL',
          });
          await enqueueReceiptEmail(receipt.id);
          return { receiptId: receipt.id };
        }

        case 'SEND_RECEIPT_EMAIL': {
          // Throw on failure so BullMQ retries delivery.
          await ReceiptService.sendReceiptEmail(data.receiptId, { throwOnError: true });
          return { receiptId: data.receiptId };
        }

        case 'PROCESS_BATCH': {
          const result = await ReceiptService.processBatchJob(data.jobId);
          return { jobId: data.jobId, status: result.status };
        }

        default:
          throw new Error(`Unknown receipt job type: ${type}`);
      }
    },
    { connection, concurrency: 5 },
  );

  worker.on('completed', (job) => {
    logger.info(`Receipt job completed: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Receipt job failed: ${job?.id}`, err);
  });

  logger.info('Receipt worker started');
  return worker;
}

export default startReceiptWorker;
