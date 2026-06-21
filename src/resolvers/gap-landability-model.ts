/**
 * gap-landability-model.ts
 *
 * Backward model: explain landed-vs-not for closed/churned gaps from
 * observable features, then score each OPEN gap with a landability
 * probability.  Gaps scoring below UNLANDING_THRESHOLD are flagged for
 * auto-close (residual detector).
 *
 * Follows the predict → validate → residual template (same as the live
 * cost model).  Every prediction becomes a free residual-detector,
 * widening detectability for the stale-open/churn class.
 */

import type { Gap, GapOutcome, LandabilityScore, LandabilityModelResult } from "../types/gap-landability-types";

// ---------------------------------------------------------------------------
// Tuneable constants
// ---------------------------------------------------------------------------

/** Gaps scoring below this threshold are considered "un-landable" */
const UNLANDING_THRESHOLD = 0.35;

/** Minimum number of closed/churned gaps required to train the model */
const MIN_TRAINING_SAMPLES = 5;

// ---------------------------------------------------------------------------
// Feature extraction
 // ---------------------------------------------------------------------------

export interface GapFeatures {
  remediationAlreadyPresent: boolean;
  isSingleFile: boolean;
  categoryRisk: number; // 0..1, higher = riskier / less landable
  ageDays: number;
  hasLinkedPR: boolean;
}

function extractFeatures(gap: Gap): GapFeatures {
  const ageDays =
    (Date.now() - new Date(gap.createdAt).getTime()) / (1000 * 60 * 60 * 24);

  return {
    remediationAlreadyPresent: gap.remediationPresent ?? false,
    isSingleFile: (gap.affectedFiles?.length ?? 0) <= 1,
    categoryRisk: categoryToRisk(gap.category),
    ageDays,
    hasLinkedPR: gap.linkedPR != null,
  };
}

/**
 * Map gap category to a risk scalar.  Lower risk → more landable.
 * Extend this table as new categories are introduced.
 */
function categoryToRisk(category: string | undefined): number {
  const table: Record<string, number> = {
    security: 0.8,
    compliance: 0.75,
    performance: 0.5,
    reliability: 0.55,
    observability: 0.4,
    debt: 0.3,
    documentation: 0.15,
    model_opportunity: 0.2,
  };
  return table[category?.toLowerCase() ?? ""] ?? 0.5;
}

// ---------------------------------------------------------------------------
// Logistic regression (single-neuron) – closed-form weight estimation
// ---------------------------------------------------------------------------

/** Simple logistic helper */
function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

interface ModelWeights {
  wRemediation: number;
  wSingleFile: number;
  wCategoryRisk: number;
  wAgeDays: number;
  wLinkedPR: number;
  bias: number;
}

/**
 * Fit logistic regression weights using gradient descent over the
 * training set.  Returns null if the training set is too small.
 */
function fitWeights(
  samples: Array<{ features: GapFeatures; landed: boolean }>
): ModelWeights | null {
  if (samples.length < MIN_TRAINING_SAMPLES) return null;

  const lr = 0.05;
  const epochs = 300;

  let w: ModelWeights = {
    wRemediation: 0,
    wSingleFile: 0,
    wCategoryRisk: 0,
    wAgeDays: 0,
    wLinkedPR: 0,
    bias: 0,
  };

  for (let e = 0; e < epochs; e++) {
    const grad: ModelWeights = {
      wRemediation: 0,
      wSingleFile: 0,
      wCategoryRisk: 0,
      wAgeDays: 0,
      wLinkedPR: 0,
      bias: 0,
    };

    for (const { features: f, landed } of samples) {
      const z =
        w.bias +
        w.wRemediation * (f.remediationAlreadyPresent ? 1 : 0) +
        w.wSingleFile * (f.isSingleFile ? 1 : 0) +
        w.wCategoryRisk * f.categoryRisk +
        w.wAgeDays * (f.ageDays / 365) + // normalise to years
        w.wLinkedPR * (f.hasLinkedPR ? 1 : 0);

      const pred = sigmoid(z);
      const err = pred - (landed ? 1 : 0);

      grad.bias += err;
      grad.wRemediation += err * (f.remediationAlreadyPresent ? 1 : 0);
      grad.wSingleFile += err * (f.isSingleFile ? 1 : 0);
      grad.wCategoryRisk += err * f.categoryRisk;
      grad.wAgeDays += err * (f.ageDays / 365);
      grad.wLinkedPR += err * (f.hasLinkedPR ? 1 : 0);
    }

    const n = samples.length;
    w.bias -= (lr * grad.bias) / n;
    w.wRemediation -= (lr * grad.wRemediation) / n;
    w.wSingleFile -= (lr * grad.wSingleFile) / n;
    w.wCategoryRisk -= (lr * grad.wCategoryRisk) / n;
    w.wAgeDays -= (lr * grad.wAgeDays) / n;
    w.wLinkedPR -= (lr * grad.wLinkedPR) / n;
  }

  return w;
}

/**
 * Score a single gap given trained weights.
 * Returns a probability in [0,1] where 1 = definitely landable.
 */
function scoreGap(gap: Gap, weights: ModelWeights): number {
  const f = extractFeatures(gap);
  const z =
    weights.bias +
    weights.wRemediation * (f.remediationAlreadyPresent ? 1 : 0) +
    weights.wSingleFile * (f.isSingleFile ? 1 : 0) +
    weights.wCategoryRisk * f.categoryRisk +
    weights.wAgeDays * (f.ageDays / 365) +
    weights.wLinkedPR * (f.hasLinkedPR ? 1 : 0);
  return sigmoid(z);
}

/**
 * Fallback heuristic score when there is insufficient training data.
 * Uses a simple weighted combination of the most predictive features.
 */
function heuristicScore(gap: Gap): number {
  const f = extractFeatures(gap);
  let score = 0.5;
  if (f.remediationAlreadyPresent) score += 0.2;
  if (f.isSingleFile) score += 0.1;
  if (f.hasLinkedPR) score += 0.15;
  score -= f.categoryRisk * 0.2;
  // Long-lived open gaps are harder to land
  if (f.ageDays > 90) score -= 0.1;
  if (f.ageDays > 180) score -= 0.1;
  return Math.max(0, Math.min(1, score));
}

// ---------------------------------------------------------------------------
// Main resolver export
// ---------------------------------------------------------------------------

/**
 * runLandabilityModel
 *
 * @param closedGaps  Historical gaps with known outcomes (landed / churned).
 * @param openGaps    Current open gaps to score.
 * @returns           Scores for every open gap plus a list of gap IDs
 *                    recommended for auto-close (residual detector output).
 */
export function runLandabilityModel(
  closedGaps: Array<{ gap: Gap; outcome: GapOutcome }>,
  openGaps: Gap[]
): LandabilityModelResult {
  // Build training set
  const trainingSet = closedGaps.map(({ gap, outcome }) => ({
    features: extractFeatures(gap),
    landed: outcome === "landed",
  }));

  const weights = fitWeights(trainingSet);
  const modelAvailable = weights !== null;

  // Score open gaps
  const scores: LandabilityScore[] = openGaps.map((gap) => {
    const probability = modelAvailable
      ? scoreGap(gap, weights!)
      : heuristicScore(gap);

    const unlanding = probability < UNLANDING_THRESHOLD;

    return {
      gapId: gap.id,
      landabilityScore: probability,
      isUnlanding: unlanding,
      modelSource: modelAvailable ? "backward_logistic" : "heuristic",
      features: extractFeatures(gap),
    };
  });

  // Residual detector: gaps recommended for auto-close
  const autoCloseRecommendations = scores
    .filter((s) => s.isUnlanding)
    .map((s) => s.gapId);

  // Validate: compute in-sample accuracy when model is available
  let trainingAccuracy: number | null = null;
  if (modelAvailable) {
    let correct = 0;
    for (const { features, landed } of trainingSet) {
      const z =
        weights!.bias +
        weights!.wRemediation * (features.remediationAlreadyPresent ? 1 : 0) +
        weights!.wSingleFile * (features.isSingleFile ? 1 : 0) +
        weights!.wCategoryRisk * features.categoryRisk +
        weights!.wAgeDays * (features.ageDays / 365) +
        weights!.wLinkedPR * (features.hasLinkedPR ? 1 : 0);
      const pred = sigmoid(z) >= 0.5;
      if (pred === landed) correct++;
    }
    trainingAccuracy = correct / trainingSet.length;
  }

  return {
    scores,
    autoCloseRecommendations,
    modelAvailable,
    trainingAccuracy,
    trainingSamples: trainingSet.length,
    threshold: UNLANDING_THRESHOLD,
  };
}
