import config from '../config';
import logger from '../config/logger';
import { WebhookService } from '../services/webhook.service';

let retryProcessor: NodeJS.Timeout | null = null;

export function startWebhookRetryProcessor(): void {
  if (retryProcessor) {
    return;
  }

  retryProcessor = setInterval(() => {
    WebhookService.processDueRetries().then((processed) => {
      if (processed > 0) {
        logger.info(`Processed ${processed} webhook retry event(s)`);
      }
    }).catch((error) => {
      logger.error('Webhook retry processor failed', error);
    });
  }, config.webhooks.retryProcessorIntervalMs);

  retryProcessor.unref();
}

export function stopWebhookRetryProcessor(): void {
  if (!retryProcessor) {
    return;
  }

  clearInterval(retryProcessor);
  retryProcessor = null;
}
