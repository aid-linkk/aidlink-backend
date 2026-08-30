/**
 * fraudCalibration.service.ts
 *
 * Online re-calibration pipeline for the KYC fraud detection model.
 *
 * Key responsibilities:
 *  - computeECE          – equal-mass (quantile) binning ECE
 *  - computeAUC          – trapezoidal AUC-ROC
 *  - evaluateCalibration – per-version metrics (accepts optional modelVersionId)
 *  - fitPlattParams      – MLE Newton-Raphson Platt scaling with Platt (1999) regularisation
 *  - fitIsotonicRegression – PAV isotonic regression → breakpoints
 *  - applyCalibration    – routes to Platt or isotonic based on active version
 *  - runRecalibration    – complete version lifecycle: fetch → split → fit → evaluate → swap
 *
 * All arithmetic is plain TypeScript; no Python or ML framework is required.
 */

import prisma from '../config/database';
import logger from '../config/logger';
import { config } from '../config';
import { FraudDriftDetectionService, FraudDriftObservation, DriftBaseline } from './fraudDriftDetection.service';

function driftObservation(label: { reviewedAt: Date; outcome: string; featureSnapshot: unknown }): FraudDriftObservation {
  const snapshot = (label.featureSnapshot && typeof label.featureSnapshot === 'object' ? label.featureSnapshot : {}) as Record<string, unknown>;
  const nested = (snapshot.interactionFeatures && typeof snapshot.interactionFeatures === 'object' ? snapshot.interactionFeatures : {}) as Record<string, unknown>;
  const numeric: Record<string, number> = {};
  const categorical: Record<string, string> = {};
  for (const key of ['velocity', 'deviceFingerprintRisk', 'geographicAnomalyScore', 'externalFraudScore']) { const value = snapshot[key] ?? nested[key]; if (typeof value === 'number' && Number.isFinite(value)) numeric[key] = value; }
  for (const key of ['deviceType', 'region', 'country', 'fraudProviderCategory']) { const value = snapshot[key] ?? nested[key]; if (typeof value === 'string' && value) categorical[key] = value; }
  return { timestamp: label.reviewedAt, label: label.outcome === 'REJECTED' ? 1 : 0, numeric, categorical };
}

async function checkCalibrationDrift(active: { id: string; version: string; metadata: unknown }, rows: Array<{ reviewedAt: Date; outcome: string; featureSnapshot: unknown }>) {
  const drift = (config as typeof config & { fraudDrift?: { enabled: boolean; currentWindowHours: number; detectionIntervalMinutes: number } }).fraudDrift;
  if (!drift?.enabled) return undefined;
  const metadata = (active.metadata && typeof active.metadata === 'object' ? active.metadata : {}) as Record<string, unknown>;
  const lastChecked = typeof metadata.driftLastCheckedAt === 'string' ? new Date(metadata.driftLastCheckedAt) : undefined;
  if (lastChecked && Date.now() - lastChecked.getTime() < drift.detectionIntervalMinutes * 60_000) return undefined;
  const service = new FraudDriftDetectionService();
  const observations = rows.map(driftObservation);
  const currentStart = new Date(Date.now() - drift.currentWindowHours * 3_600_000);
  const baseline = metadata.driftBaseline as DriftBaseline | undefined;
  if (!baseline) {
    const historical = observations.filter(row => row.timestamp < currentStart);
    const established = service.establishBaseline(historical.length ? historical : observations);
    await prisma.fraudModelVersion.update({ where: { id: active.id }, data: { metadata: { ...metadata, driftBaseline: established, driftLastCheckedAt: new Date().toISOString() } } });
    logger.info('Fraud drift baseline established', { modelVersionId: active.id, sampleSize: established.labels.sampleSize });
    return undefined;
  }
  const report = service.detect(baseline, observations.filter(row => row.timestamp >= currentStart), { baselineId: baseline.establishedAt, modelVersionId: active.id });
  await prisma.fraudModelVersion.update({ where: { id: active.id }, data: { metadata: { ...metadata, driftLastCheckedAt: report.detectedAt.toISOString() } } });
  logger.info('Fraud drift report', { modelVersionId: active.id, modelVersion: active.version, driftDetected: report.driftDetected, driftType: report.driftType, driftPattern: report.driftPattern, severity: report.severity, affectedFeatures: report.affectedFeatures, labelPValue: report.labelResult?.pValue, featureMetrics: report.featureResults.map(result => ({ feature: result.feature, method: result.method, pValue: result.pValue, psi: result.psi })) });
  if (report.driftType === 'REAL') logger.warn('Fraud real drift alert: recalibration withheld pending review', { modelVersionId: active.id });
  return report;
}

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface CalibrationMetrics {
  ece: number;
  auc: number;
  sampleCount: number;
}

export interface LabelPoint {
  score: number;  // fraudScoreFloat ∈ [0,1]
  label: 0 | 1;  // 1 = REJECTED (fraud), 0 = APPROVED (legitimate)
}

export interface PlattParams {
  A: number;
  B: number;
}

export interface IsotonicBreakpoint {
  score: number;
  probability: number;
}

// ─── Pure numeric helpers ─────────────────────────────────────────────────────

/** Numerically stable sigmoid: 1 / (1 + exp(-z))  (standard form) */
function sigmoid(z: number): number {
  const clamped = Math.max(Math.min(z, 35), -35);
  return 1 / (1 + Math.exp(-clamped));
}

// ─── Equal-mass ECE ───────────────────────────────────────────────────────────

interface Bin {
  confidence: number;
  accuracy: number;
  count: number;
}

/**
 * Compute Expected Calibration Error using equal-mass (quantile) bins.
 *
 * Equal-mass binning: sort predictions by confidence, then split into M
 * groups of equal size.  Each group has roughly n/M samples regardless of
 * how the scores are distributed, so bins are never empty and the ECE is
 * not dominated by a single data point.
 *
 * Reference: Guo et al. (2017) "On Calibration of Modern Neural Networks".
 *
 * @param predictions Array of {probability, outcome} pairs
 * @param numBins     Number of equal-mass bins (default 10)
 */
export function computeECE(
  predictions: Array<{ probability: number; outcome: string }>,
  numBins: number = 10,
): number {
  if (predictions.length === 0) return 0;

  // Sort ascending by probability
  const sorted = [...predictions].sort((a, b) => a.probability - b.probability);
  const n = sorted.length;

  // Build equal-mass bins
  const bins: Bin[] = [];
  const binSize = n / numBins;

  for (let b = 0; b < numBins; b++) {
    const startIdx = Math.round(b * binSize);
    const endIdx = Math.round((b + 1) * binSize);
    const slice = sorted.slice(startIdx, endIdx);

    if (slice.length === 0) continue;

    let sumConf = 0;
    let sumAcc = 0;
    for (const p of slice) {
      sumConf += p.probability;
      sumAcc += p.outcome === 'REJECTED' ? 1 : 0;
    }
    bins.push({
      confidence: sumConf / slice.length,
      accuracy: sumAcc / slice.length,
      count: slice.length,
    });
  }

  // Weighted mean absolute calibration gap
  let ece = 0;
  for (const bin of bins) {
    ece += (bin.count / n) * Math.abs(bin.accuracy - bin.confidence);
  }

  return ece;
}

// ─── AUC-ROC ──────────────────────────────────────────────────────────────────

/**
 * Compute AUC-ROC using trapezoidal integration.
 */
export function computeAUC(
  predictions: Array<{ probability: number; outcome: string }>,
): number {
  if (predictions.length === 0) return 0;

  const sorted = [...predictions].sort((a, b) => b.probability - a.probability);

  const totalPos = predictions.filter(l => l.outcome === 'REJECTED').length;
  const totalNeg = predictions.filter(l => l.outcome === 'APPROVED').length;

  if (totalPos === 0 || totalNeg === 0) return 0.5;

  let tp = 0, fp = 0, prevFPR = 0, prevTPR = 0, auc = 0;

  for (const pred of sorted) {
    if (pred.outcome === 'REJECTED') tp++;
    else fp++;

    const fpr = fp / totalNeg;
    const tpr = tp / totalPos;

    auc += (fpr - prevFPR) * (tpr + prevTPR) / 2;
    prevFPR = fpr;
    prevTPR = tpr;
  }

  return auc;
}

// ─── Calibration evaluation (per-version) ────────────────────────────────────

/**
 * Evaluate ECE and AUC for fraud labels.
 *
 * @param modelVersionId When provided, only labels for that version are used.
 *                       Pass undefined for a diagnostics-only global view.
 */
export async function evaluateCalibration(
  modelVersionId?: string,
): Promise<CalibrationMetrics> {
  const startTime = Date.now();

  try {
    const whereClause = modelVersionId
      ? { modelVersionId }
      : {};

    const labels = await prisma.fraudLabel.findMany({
      where: whereClause,
      select: {
        fraudScoreFloat: true,
        outcome: true,
      },
    });

    const sampleCount = labels.length;

    if (sampleCount === 0) {
      logger.warn('No fraud labels found for calibration evaluation', { modelVersionId });
      return { ece: 0, auc: 0, sampleCount: 0 };
    }

    const predictions = labels.map((l: { fraudScoreFloat: number | null; outcome: string }) => ({
      probability: l.fraudScoreFloat ?? 0,
      outcome: l.outcome,
    }));

    const ece = computeECE(predictions);
    const auc = computeAUC(predictions);

    const duration = Date.now() - startTime;
    logger.info('Calibration evaluation completed', {
      modelVersionId,
      sampleCount,
      ece,
      auc,
      durationMs: duration,
    });

    if (ece > 0.05) {
      logger.warn(`High ECE detected: ${ece.toFixed(4)} > 0.05`, { modelVersionId });
    }
    if (auc < 0.75) {
      logger.warn(`Low AUC detected: ${auc.toFixed(4)} < 0.75`, { modelVersionId });
    }

    return { ece, auc, sampleCount };
  } catch (error) {
    logger.error('Calibration evaluation failed', { error, modelVersionId });
    throw error;
  }
}

// ─── Platt scaling MLE (Newton-Raphson) ───────────────────────────────────────

/**
 * Fit Platt scaling parameters (A, B) using Newton-Raphson MLE.
 *
 * The objective is regularised log-loss as described in Platt (1999):
 *
 *   t+ = (N+ + 1) / (N+ + 2)   (positive class target)
 *   t- = 1 / (N- + 2)           (negative class target)
 *   L(A, B) = -Σ [ t_i * log(p_i) + (1 - t_i) * log(1 - p_i) ]
 *   where p_i = sigmoid(A * score_i + B)
 *
 * The Newton-Raphson update uses the exact Hessian of the log-loss (a 2×2
 * positive-definite matrix), giving quadratic convergence near the optimum.
 *
 * Requires at least 2 positive and 2 negative samples.
 *
 * @param labels  Array of { score ∈ [0,1], label ∈ {0,1} }
 * @returns       Fitted { A, B } parameters
 * @throws        If there are fewer than 2 samples of either class
 */
export function fitPlattParams(labels: LabelPoint[]): PlattParams {
  const positives = labels.filter(l => l.label === 1);
  const negatives = labels.filter(l => l.label === 0);

  const nPos = positives.length;
  const nNeg = negatives.length;

  if (nPos < 2 || nNeg < 2) {
    throw new Error(
      `fitPlattParams requires ≥2 samples of each class; got ${nPos} positive, ${nNeg} negative`,
    );
  }

  // Platt (1999) regularised targets
  const tPos = (nPos + 1) / (nPos + 2);  // e.g. 0.75 for nPos=1
  const tNeg = 1 / (nNeg + 2);            // e.g. 0.333 for nNeg=1

  // Build (score, target) pairs
  const pairs: Array<{ score: number; t: number }> = [
    ...positives.map(l => ({ score: l.score, t: tPos })),
    ...negatives.map(l => ({ score: l.score, t: tNeg })),
  ];

  // Initialise with identity transform; Newton-Raphson converges quickly from here
  let A = 0.0;  // Start at 0 to avoid sign ambiguity; B = 0 ⇒ sigmoid(0) = 0.5
  let B = 0.0;

  const maxIter = 100;
  const tol = 1e-7;

  for (let iter = 0; iter < maxIter; iter++) {
    // Gradient and Hessian of the regularised log-loss w.r.t. (A, B)
    let dA = 0, dB = 0;
    let h11 = 0, h12 = 0, h22 = 0;  // Hessian: [[h11, h12], [h12, h22]]

    for (const { score, t } of pairs) {
      const z = A * score + B;
      const p = sigmoid(z);

      // Residual: p - t
      const r = p - t;

      // Second-order weight: p(1-p)  (always positive)
      const w = p * (1 - p);

      // Gradient += r * [score, 1]
      dA += r * score;
      dB += r;

      // Hessian += w * [score^2, score; score, 1]
      h11 += w * score * score;
      h12 += w * score;
      h22 += w;
    }

    // Solve 2×2 system: [h11 h12; h12 h22] * [dA; dB] = gradient
    const det = h11 * h22 - h12 * h12;
    if (Math.abs(det) < 1e-12) break; // Hessian singular → stop

    const stepA = (h22 * dA - h12 * dB) / det;
    const stepB = (-h12 * dA + h11 * dB) / det;

    A -= stepA;
    B -= stepB;

    if (Math.abs(stepA) + Math.abs(stepB) < tol) break;
  }

  return { A, B };
}

// ─── Isotonic regression (PAV algorithm) ─────────────────────────────────────

/**
 * Fit isotonic regression to (score, label) pairs using the
 * Pool-Adjacent-Violators (PAV) algorithm.
 *
 * Returns breakpoints: a monotone non-decreasing step function over the
 * score range, stored as [{ score, probability }, ...] in ascending order.
 * Each breakpoint represents the right edge of a flat segment.
 *
 * Reference: Zadrozny & Elkan (2002) "Transforming classifier scores into
 * accurate multiclass probability estimates."
 *
 * @param labels  Array of { score, label } (any order)
 * @returns       Sorted breakpoint array
 */
export function fitIsotonicRegression(labels: LabelPoint[]): IsotonicBreakpoint[] {
  if (labels.length === 0) return [];

  // Sort by score ascending; ties broken by label (0 before 1 for conservatism)
  const sorted = [...labels].sort((a, b) => a.score - b.score || a.label - b.label);

  // PAV: merge blocks that violate the monotone non-decreasing constraint
  // Each block tracks { sumLabels, count, rightmostScore }
  interface Block {
    sumLabels: number;
    count: number;
    maxScore: number;
  }

  const blocks: Block[] = sorted.map(l => ({
    sumLabels: l.label,
    count: 1,
    maxScore: l.score,
  }));

  // Merge left while the previous block average > current block average
  let i = 1;
  while (i < blocks.length) {
    const prev = blocks[i - 1];
    const curr = blocks[i];

    if (prev.sumLabels / prev.count > curr.sumLabels / curr.count) {
      // Merge current into previous
      prev.sumLabels += curr.sumLabels;
      prev.count += curr.count;
      prev.maxScore = curr.maxScore;
      blocks.splice(i, 1);
      // Back-check: may have introduced a new violation with the block before prev
      if (i > 1) i--;
    } else {
      i++;
    }
  }

  return blocks.map(b => ({
    score: b.maxScore,
    probability: b.sumLabels / b.count,
  }));
}

/**
 * Look up calibrated probability using isotonic breakpoints.
 * Performs a linear scan (breakpoints are short in practice).
 *
 * @param rawScore        Score to calibrate (0–100 scale or 0–1 — must match breakpoints scale)
 * @param breakpoints     Sorted breakpoints from fitIsotonicRegression
 */
export function applyIsotonicCalibration(
  rawScore: number,
  breakpoints: IsotonicBreakpoint[],
): number {
  if (breakpoints.length === 0) return rawScore;

  // Scores below the first breakpoint → use first segment probability
  if (rawScore <= breakpoints[0].score) return breakpoints[0].probability;

  // Scores above the last breakpoint → use last segment probability
  if (rawScore >= breakpoints[breakpoints.length - 1].score) {
    return breakpoints[breakpoints.length - 1].probability;
  }

  // Binary search for the enclosing segment
  let lo = 0;
  let hi = breakpoints.length - 1;

  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (breakpoints[mid].score <= rawScore) lo = mid;
    else hi = mid;
  }

  return breakpoints[lo].probability;
}

// ─── Calibration router ───────────────────────────────────────────────────────

interface ActiveVersionShape {
  id: string;
  plattA: number;
  plattB: number;
  calibrationType: string;
  isotonicBreakpoints: unknown | null;
}

/**
 * Apply calibration using the active model version's chosen method.
 * Called by assessFraud() in kycFraud.service.ts.
 *
 * @param rawScore      Raw fraud score 0–100
 * @param activeVersion Active FraudModelVersion row (may be null)
 * @returns             Calibrated probability ∈ [0,1]
 */
export function applyCalibration(
  rawScore: number,
  activeVersion: ActiveVersionShape | null,
): number {
  if (!activeVersion) {
    // Identity fallback: sigmoid(1 * rawScore + 0)
    return sigmoid(rawScore);
  }

  if (
    activeVersion.calibrationType === 'isotonic' &&
    activeVersion.isotonicBreakpoints != null
  ) {
    const breakpoints = activeVersion.isotonicBreakpoints as IsotonicBreakpoint[];
    return applyIsotonicCalibration(rawScore, breakpoints);
  }

  // Default: Platt — standard sigmoid
  const z = activeVersion.plattA * rawScore + activeVersion.plattB;
  return sigmoid(z);
}

// ─── Stratified train/validation split ───────────────────────────────────────

/**
 * Stratified 80/20 split.  The positive and negative classes are split
 * independently so the class ratio is preserved in both partitions.
 */
function stratifiedSplit(
  labels: LabelPoint[],
  trainFraction: number = 0.8,
): { train: LabelPoint[]; validation: LabelPoint[] } {
  const positives = labels.filter(l => l.label === 1);
  const negatives = labels.filter(l => l.label === 0);

  const splitClass = (arr: LabelPoint[]) => {
    const n = Math.floor(arr.length * trainFraction);
    return { train: arr.slice(0, n), validation: arr.slice(n) };
  };

  const posSplit = splitClass(positives);
  const negSplit = splitClass(negatives);

  return {
    train: [...posSplit.train, ...negSplit.train],
    validation: [...posSplit.validation, ...negSplit.validation],
  };
}

// ─── Full re-calibration pipeline ────────────────────────────────────────────

export interface RecalibrationResult {
  newVersionId: string;
  oldVersionId: string | null;
  newEce: number;
  newAuc: number;
  oldEce: number | null;
  calibrationType: 'platt' | 'isotonic';
}

/**
 * Run the complete online re-calibration pipeline:
 *
 *   a. Read labels for the current active FraudModelVersion only.
 *   b. Require MIN_CALIBRATION_SAMPLES of each class; skip otherwise.
 *   c. Stratified 80/20 train/validation split.
 *   d. Fit Platt parameters on the train set.
 *   e. Evaluate ECE on the validation set; if ECE > isotonicEceThreshold, fit isotonic.
 *   f. Create a new FraudModelVersion (isActive = false).
 *   g. Atomic transaction: new version isActive = true, old version isActive = false.
 *   h. Log the transition with old and new ECE/AUC.
 */
function shouldRejectCatastrophicForgetting(current: { ece?: number | null; auc?: number | null }, candidate: { ece: number; auc: number }): boolean {
  if (current.ece == null || current.auc == null) return false;
  const eceDelta = candidate.ece - current.ece;
  const aucDelta = current.auc - candidate.auc;
  return eceDelta > 0.1 || aucDelta > 0.05;
}

export async function runRecalibration(): Promise<RecalibrationResult | null> {
  const { fraudRecalibration } = config;
  const isotonicThreshold = fraudRecalibration.isotonicEceThreshold;
  const minSamples = fraudRecalibration.minCalibrationSamples;

  // ── Step a: Get active version ─────────────────────────────────────────────
  const activeVersion = await prisma.fraudModelVersion.findFirst({
    where: { isActive: true },
    orderBy: { calibratedAt: 'desc' },
    select: {
      id: true,
      version: true,
      plattA: true,
      plattB: true,
      ece: true,
      auc: true,
    },
  });

  if (!activeVersion) {
    logger.warn('runRecalibration: no active FraudModelVersion found, skipping');
    return null;
  }

  // ── Step b: Fetch and validate label counts ────────────────────────────────
  const rawLabels = await prisma.fraudLabel.findMany({
    where: { modelVersionId: activeVersion.id },
    select: { fraudScoreFloat: true, outcome: true },
  });

  // Keep the historical calibration query unchanged unless drift monitoring is enabled.
  const driftEnabled = (config as typeof config & { fraudDrift?: { enabled: boolean } }).fraudDrift?.enabled === true;
  if (driftEnabled) {
    const [driftRows, versionState] = await Promise.all([
      prisma.fraudLabel.findMany({ where: { modelVersionId: activeVersion.id }, select: { reviewedAt: true, outcome: true, featureSnapshot: true } }),
      prisma.fraudModelVersion.findUnique({ where: { id: activeVersion.id }, select: { metadata: true } }),
    ]);
    const driftReport = await checkCalibrationDrift({ ...activeVersion, metadata: versionState?.metadata ?? null }, driftRows);
    if (driftReport?.driftType === 'REAL') return null;
  }

  const labels: LabelPoint[] = rawLabels.map((l: { fraudScoreFloat: number | null; outcome: string }) => ({
    score: l.fraudScoreFloat ?? 0,
    label: l.outcome === 'REJECTED' ? 1 : 0,
  }));

  const nPos = labels.filter(l => l.label === 1).length;
  const nNeg = labels.filter(l => l.label === 0).length;

  if (nPos < minSamples || nNeg < minSamples) {
    logger.warn(
      `runRecalibration: insufficient labels for version ${activeVersion.id}. ` +
      `Need ≥${minSamples} per class; have ${nPos} positive, ${nNeg} negative. Skipping.`,
    );
    return null;
  }

  // ── Step c: Stratified 80/20 split ────────────────────────────────────────
  const { train, validation } = stratifiedSplit(labels);

  // ── Step d: Fit Platt on train ─────────────────────────────────────────────
  let fittedPlatt: PlattParams;
  try {
    fittedPlatt = fitPlattParams(train);
  } catch (err) {
    logger.error('runRecalibration: Platt fitting failed', { error: err });
    return null;
  }

  // ── Step e: Evaluate on validation set ────────────────────────────────────
  const valPredictions = validation.map(l => ({
    probability: sigmoid(fittedPlatt.A * l.score + fittedPlatt.B),
    outcome: l.label === 1 ? 'REJECTED' : 'APPROVED',
  }));

  const valEce = computeECE(valPredictions);
  const valAuc = computeAUC(valPredictions);

  let calibrationType: 'platt' | 'isotonic' = 'platt';
  let isotonicBreakpoints: IsotonicBreakpoint[] | null = null;

  if (valEce > isotonicThreshold) {
    logger.info(
      `runRecalibration: Platt ECE ${valEce.toFixed(4)} > ${isotonicThreshold}; ` +
      'fitting isotonic regression on train set',
    );

    isotonicBreakpoints = fitIsotonicRegression(train);
    calibrationType = 'isotonic';

    // Re-evaluate ECE/AUC using isotonic predictions
    const isoPredictions = validation.map(l => ({
      probability: applyIsotonicCalibration(l.score, isotonicBreakpoints!),
      outcome: l.label === 1 ? 'REJECTED' : 'APPROVED',
    }));

    const isoEce = computeECE(isoPredictions);
    const isoAuc = computeAUC(isoPredictions);

    logger.info(
      `runRecalibration: isotonic ECE=${isoEce.toFixed(4)}, AUC=${isoAuc.toFixed(4)}`,
    );
  }

  if (shouldRejectCatastrophicForgetting(activeVersion, { ece: valEce, auc: valAuc })) {
    logger.warn('runRecalibration: candidate calibration would catastrophically forget the active model; aborting', {
      modelVersionId: activeVersion.id,
      oldEce: activeVersion.ece,
      oldAuc: activeVersion.auc,
      newEce: valEce,
      newAuc: valAuc,
    });
    return null;
  }

  // ── Step f: Create new inactive version ───────────────────────────────────
  const now = new Date();
  const newVersion = `v${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;

  const newVersionRecord = await prisma.fraudModelVersion.create({
    data: {
      version: newVersion,
      plattA: fittedPlatt.A,
      plattB: fittedPlatt.B,
      calibrationType,
      isotonicBreakpoints: isotonicBreakpoints
        ? (isotonicBreakpoints as unknown as import('@prisma/client').Prisma.InputJsonValue)
        : undefined,
      isActive: false,          // Start inactive; the transaction below activates it
      ece: valEce,
      auc: valAuc,
      calibratedAt: now,
      metadata: {
        trainSize: train.length,
        validationSize: validation.length,
        nPos,
        nNeg,
        parentVersionId: activeVersion.id,
        fittedAt: now.toISOString(),
      },
    },
  });

  // ── Step g: Atomic version swap ────────────────────────────────────────────
  await prisma.$transaction([
    prisma.fraudModelVersion.update({
      where: { id: activeVersion.id },
      data: { isActive: false },
    }),
    prisma.fraudModelVersion.update({
      where: { id: newVersionRecord.id },
      data: { isActive: true },
    }),
  ]);

  // ── Step h: Log the transition ─────────────────────────────────────────────
  logger.info('runRecalibration: version swap complete', {
    oldVersionId: activeVersion.id,
    newVersionId: newVersionRecord.id,
    oldEce: activeVersion.ece,
    newEce: valEce,
    oldAuc: activeVersion.auc,
    newAuc: valAuc,
    calibrationType,
    trainSize: train.length,
    validationSize: validation.length,
  });

  return {
    newVersionId: newVersionRecord.id,
    oldVersionId: activeVersion.id,
    newEce: valEce,
    newAuc: valAuc,
    oldEce: activeVersion.ece ?? null,
    calibrationType,
  };
}

// ─── Legacy helpers (kept for backwards compatibility) ────────────────────────

/**
 * Update the active model version with calibration metrics.
 * @deprecated Prefer runRecalibration() which writes metrics on version creation.
 */
export async function updateModelVersionMetrics(
  modelVersionId: string,
  ece: number,
  auc: number,
): Promise<void> {
  try {
    await prisma.fraudModelVersion.update({
      where: { id: modelVersionId },
      data: { ece, auc },
    });
    logger.info(`Updated model version ${modelVersionId} with calibration metrics`, { ece, auc });
  } catch (error) {
    logger.error('Failed to update model version metrics', { error, modelVersionId });
    throw error;
  }
}

/**
 * Get the current fraud model health status.
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
      return { version: null, lastCalibrated: null, ece: null, auc: null };
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
