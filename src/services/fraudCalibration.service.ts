import prisma from '../config/database';
import logger from '../config/logger';

interface CalibrationMetrics {
  ece: number;
  auc: number;
  sampleCount: number;
}

interface Bin {
  confidence: number;
  accuracy: number;
  count: number;
}

/**
 * Compute Expected Calibration Error (ECE)
 * Partitions predictions into M=10 equal-width bins and computes weighted calibration error
 */
function computeECE(labels: Array<{ probability: number; outcome: string }>, numBins: number = 10): number {
  if (labels.length === 0) return 0;

  const bins: Bin[] = Array.from({ length: numBins }, () => ({
    confidence: 0,
    accuracy: 0,
    count: 0,
  }));

  // Assign each prediction to a bin
  for (const label of labels) {
    const binIndex = Math.min(Math.floor(label.probability * numBins), numBins - 1);
    bins[binIndex].count += 1;
    bins[binIndex].confidence += label.probability;
    bins[binIndex].accuracy += label.outcome === 'REJECTED' ? 1 : 0; // REJECTED = positive class (fraud)
  }

  // Compute ECE
  let ece = 0;
  for (const bin of bins) {
    if (bin.count > 0) {
      const avgConfidence = bin.confidence / bin.count;
      const avgAccuracy = bin.accuracy / bin.count;
      const weight = bin.count / labels.length;
      ece += weight * Math.abs(avgAccuracy - avgConfidence);
    }
  }

  return ece;
}

/**
 * Compute AUC-ROC using trapezoidal integration
 * Sorts predictions by probability descending and computes TPR/FPR at each threshold
 */
function computeAUC(labels: Array<{ probability: number; outcome: string }>): number {
  if (labels.length === 0) return 0;

  // Sort by probability descending
  const sorted = [...labels].sort((a, b) => b.probability - a.probability);

  let tp = 0;
  let fp = 0;
  let prevFPR = 0;
  let prevTPR = 0;
  let auc = 0;

  // Count total positives and negatives
  const totalPositives = labels.filter(l => l.outcome === 'REJECTED').length;
  const totalNegatives = labels.filter(l => l.outcome === 'APPROVED').length;

  if (totalPositives === 0 || totalNegatives === 0) return 0.5; // Undefined AUC, return neutral

  for (const label of sorted) {
    if (label.outcome === 'REJECTED') {
      tp++;
    } else {
      fp++;
    }

    const fpr = fp / totalNegatives;
    const tpr = tp / totalPositives;

    // Trapezoidal integration
    auc += (fpr - prevFPR) * (tpr + prevTPR) / 2;

    prevFPR = fpr;
    prevTPR = tpr;
  }

  return auc;
}

/**
 * Main calibration evaluation function
 * Reads all FraudLabel rows and computes ECE and AUC-ROC
 */
export async function evaluateCalibration(): Promise<CalibrationMetrics> {
  const startTime = Date.now();

  try {
    // Fetch all fraud labels
    const labels = await prisma.fraudLabel.findMany({
      select: {
        fraudScoreFloat: true,
        outcome: true,
      },
    });

    const sampleCount = labels.length;

    if (sampleCount === 0) {
      logger.warn('No fraud labels found for calibration evaluation');
      return { ece: 0, auc: 0, sampleCount: 0 };
    }

    // Prepare data for metrics computation
    const predictions = labels.map((label: { fraudScoreFloat: number | null; outcome: string }) => ({
      probability: label.fraudScoreFloat ?? 0,
      outcome: label.outcome,
    }));

    // Compute metrics
    const ece = computeECE(predictions);
    const auc = computeAUC(predictions);

    const duration = Date.now() - startTime;
    logger.info(`Calibration evaluation completed in ${duration}ms`, {
      sampleCount,
      ece,
      auc,
      duration,
    });

    // Log warnings if metrics are below thresholds
    if (ece > 0.05) {
      logger.warn(`High Expected Calibration Error detected: ${ece.toFixed(4)} > 0.05`);
    }

    if (auc < 0.75) {
      logger.warn(`Low AUC-ROC detected: ${auc.toFixed(4)} < 0.75`);
    }

    return { ece, auc, sampleCount };
  } catch (error) {
    logger.error('Calibration evaluation failed', { error });
    throw error;
  }
}

/**
 * Update the active model version with calibration metrics
 */
export async function updateModelVersionMetrics(
  modelVersionId: string,
  ece: number,
  auc: number
): Promise<void> {
  try {
    await prisma.fraudModelVersion.update({
      where: { id: modelVersionId },
      data: {
        ece,
        auc,
      },
    });

    logger.info(`Updated model version ${modelVersionId} with calibration metrics`, { ece, auc });
  } catch (error) {
    logger.error('Failed to update model version metrics', { error, modelVersionId });
    throw error;
  }
}

/**
 * Get the current fraud model health status
 */
export async function getFraudModelHealth(): Promise<{
  version: string | null;
  lastCalibrated: Date | null;
  ece: number | null;
  auc: number | null;
}> {
  try {
    const activeVersion = await prisma.fraudModelVersion.findFirst({
      where: { isActive: true },
      orderBy: { calibratedAt: 'desc' },
      select: {
        version: true,
        calibratedAt: true,
        ece: true,
        auc: true,
      },
    });

    if (!activeVersion) {
      return {
        version: null,
        lastCalibrated: null,
        ece: null,
        auc: null,
      };
    }

    return {
      version: activeVersion.version,
      lastCalibrated: activeVersion.calibratedAt,
      ece: activeVersion.ece,
      auc: activeVersion.auc,
    };
  } catch (error) {
    logger.error('Failed to get fraud model health', { error });
    throw error;
  }
}
