/**
 * Gap Landability Backward Model
 *
 * Backward model: trained over gap→cutover outcome history.
 * Features: remediation already present?, single-file?, category.
 * Outputs a landability score [0,1] per OPEN gap.
 * Score < LANDABILITY_THRESHOLD → gap is predicted un-landable → candidate for auto-close.
 *
 * Every prediction becomes a free residual detector:
 * if a gap predicted un-landable later lands, that is a signal the model needs updating.
 */

export interface GapLandabilityFeatures {
  /** Gap unique identifier */
  gapId: string;
  /** Category/subtype of the gap (e.g. "model_opportunity", "missing_coverage", etc.) */
  category: string;
  /** Whether a remediation/fix is already present in the codebase */
  remediationAlreadyPresent: boolean;
  /** Whether the fix touches only a single file */
  singleFile: boolean;
  /** How many days the gap has been open (staleness signal) */
  daysOpen: number;
  /** Number of prior churn cycles (closed then reopened) */
  churnCycles: number;
}

export interface LandabilityPrediction {
  gapId: string;
  score: number; // [0, 1]  higher = more landable
  features: GapLandabilityFeatures;
  predictedLandable: boolean;
  reason: string;
}

/**
 * Historical outcome record used to (re-)calibrate the model weights.
 * landed=true  → gap was closed via a real code change (cutover).
 * landed=false → gap was churned/closed without a real fix.
 */
export interface GapOutcomeRecord {
  gapId: string;
  features: GapLandabilityFeatures;
  landed: boolean;
}

/** Threshold below which a gap is considered un-landable. */
export const LANDABILITY_THRESHOLD = 0.35;

/**
 * Simple logistic-style linear model weights.
 * Calibrated from the backward pass over closed/churned gap history.
 * Weights can be updated by calling `calibrateWeights`.
 */
export interface ModelWeights {
  intercept: number;
  remediationAlreadyPresent: number;
  singleFile: number;
  daysOpenPenalty: number;  // negative: more days → less landable
  churnPenalty: number;     // negative: more churn → less landable
  /** Per-category bias; missing categories default to 0 */
  categoryBias: Record<string, number>;
}

/** Default weights derived from domain heuristics (prior). */
const DEFAULT_WEIGHTS: ModelWeights = {
  intercept: 0.5,
  remediationAlreadyPresent: 0.3,
  singleFile: 0.15,
  daysOpenPenalty: -0.005,
  churnPenalty: -0.1,
  categoryBias: {
    missing_coverage: 0.1,
    model_opportunity: -0.05,
    performance: 0.05,
    security: 0.15,
  },
};

/** Sigmoid activation to squash linear score into [0,1]. */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Compute raw linear score from features and weights.
 */
function linearScore(f: GapLandabilityFeatures, w: ModelWeights): number {
  let score = w.intercept;
  if (f.remediationAlreadyPresent) score += w.remediationAlreadyPresent;
  if (f.singleFile) score += w.singleFile;
  score += w.daysOpenPenalty * f.daysOpen;
  score += w.churnPenalty * f.churnCycles;
  score += w.categoryBias[f.category] ?? 0;
  return score;
}

/**
 * Predict landability for a single open gap.
 */
export function predictLandability(
  features: GapLandabilityFeatures,
  weights: ModelWeights = DEFAULT_WEIGHTS
): LandabilityPrediction {
  const raw = linearScore(features, weights);
  const score = sigmoid(raw);
  const predictedLandable = score >= LANDABILITY_THRESHOLD;

  const reasons: string[] = [];
  if (features.remediationAlreadyPresent) reasons.push("remediation present");
  if (features.singleFile) reasons.push("single-file fix");
  if (features.daysOpen > 30) reasons.push(`stale (${features.daysOpen}d open)`);
  if (features.churnCycles > 0) reasons.push(`churned ${features.churnCycles}x`);
  if (!predictedLandable) reasons.push("score below threshold");

  return {
    gapId: features.gapId,
    score,
    features,
    predictedLandable,
    reason: reasons.join("; ") || "baseline",
  };
}

/**
 * Batch-predict landability for a list of open gaps.
 * Returns all predictions, sorted ascending by score (least landable first).
 */
export function predictLandabilityBatch(
  gapFeaturesList: GapLandabilityFeatures[],
  weights: ModelWeights = DEFAULT_WEIGHTS
): LandabilityPrediction[] {
  return gapFeaturesList
    .map((f) => predictLandability(f, weights))
    .sort((a, b) => a.score - b.score);
}

/**
 * Backward-model calibration: given a set of historical outcome records,
 * compute per-feature empirical rates and return updated weights.
 *
 * This is a one-pass maximum-likelihood estimate (logistic regression
 * approximated via feature mean differences) so it stays dependency-free.
 */
export function calibrateWeights(history: GapOutcomeRecord[]): ModelWeights {
  if (history.length === 0) return DEFAULT_WEIGHTS;

  const landed = history.filter((r) => r.landed);
  const notLanded = history.filter((r) => !r.landed);

  const landedN = landed.length;
  const notN = notLanded.length;

  /** Mean of a boolean feature across a slice. */
  const meanBool = (slice: GapOutcomeRecord[], key: keyof GapLandabilityFeatures): number => {
    if (slice.length === 0) return 0;
    return slice.filter((r) => Boolean(r.features[key])).length / slice.length;
  };

  const meanNum = (slice: GapOutcomeRecord[], key: keyof GapLandabilityFeatures): number => {
    if (slice.length === 0) return 0;
    return slice.reduce((s, r) => s + (r.features[key] as number), 0) / slice.length;
  };

  // Feature deltas: landed_mean - notLanded_mean → direction of weight
  const remediationDelta = meanBool(landed, "remediationAlreadyPresent") - meanBool(notLanded, "remediationAlreadyPresent");
  const singleFileDelta = meanBool(landed, "singleFile") - meanBool(notLanded, "singleFile");
  const daysOpenDelta = meanNum(landed, "daysOpen") - meanNum(notLanded, "daysOpen");
  const churnDelta = meanNum(landed, "churnCycles") - meanNum(notLanded, "churnCycles");

  // Prior land rate → intercept via logit
  const landRate = Math.min(Math.max(landedN / history.length, 0.01), 0.99);
  const intercept = Math.log(landRate / (1 - landRate));

  // Per-category bias from empirical land rate vs overall
  const categoryBias: Record<string, number> = {};
  const categories = new Set(history.map((r) => r.features.category));
  for (const cat of categories) {
    const catRecords = history.filter((r) => r.features.category === cat);
    const catLandRate = catRecords.filter((r) => r.landed).length / catRecords.length;
    const safeLandRate = Math.min(Math.max(catLandRate, 0.01), 0.99);
    const catLogit = Math.log(safeLandRate / (1 - safeLandRate));
    categoryBias[cat] = catLogit - intercept;
  }

  return {
    intercept,
    remediationAlreadyPresent: remediationDelta * 2, // scale heuristic
    singleFile: singleFileDelta * 1.5,
    daysOpenPenalty: daysOpenDelta !== 0 ? -Math.abs(daysOpenDelta) * 0.005 : DEFAULT_WEIGHTS.daysOpenPenalty,
    churnPenalty: churnDelta !== 0 ? -Math.abs(churnDelta) * 0.1 : DEFAULT_WEIGHTS.churnPenalty,
    categoryBias,
  };
}

/**
 * Residual detector: given a prediction made earlier and the actual outcome,
 * return true if the prediction was wrong (residual signal).
 * Log these for model drift detection.
 */
export function detectResidual(
  prediction: LandabilityPrediction,
  actuallyLanded: boolean
): { isResidual: boolean; message: string } {
  const isResidual = prediction.predictedLandable !== actuallyLanded;
  const message = isResidual
    ? `Residual detected for gap ${prediction.gapId}: predicted ${
        prediction.predictedLandable ? "landable" : "un-landable"
      } (score=${prediction.score.toFixed(3)}) but outcome was ${
        actuallyLanded ? "landed" : "not landed"
      }. Model recalibration recommended.`
    : `Prediction confirmed for gap ${prediction.gapId} (score=${prediction.score.toFixed(3)}).`;
  return { isResidual, message };
}
