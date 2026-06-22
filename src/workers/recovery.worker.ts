import { processScheduledRetries } from '../services/recovery.service';
import logger from '../config/logger';

// Run auto-retry every 5 minutes
const INTERVAL_MS = 5 * 60_000;

let timer: NodeJS.Timeout | null = null;

export function startRecoveryWorker(): void {
  timer = setInterval(async () => {
    try {
      await processScheduledRetries();
    } catch (err) {
      logger.error('Recovery worker error:', err);
    }
  }, INTERVAL_MS);

  logger.info('Recovery worker started (interval: 5m)');
}

export function stopRecoveryWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
