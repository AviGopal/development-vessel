/**
 * gap-landability-model.ts
 *
 * Backward model: learn from closed/churned gap history (landed vs not) and
 * produce a landability score [0,1] for every OPEN gap.
 *
 * Features used per gap:
 *   - remediationPresent : boolean  (remediation field is non-empty)
 *   - singleFile         : boolean  (affectedFiles.length === 1)
 *   - categoryRisk       : number   (per-category prior churn rate, 0–1)
 *
 * Model: naive logistic regression trained online over the history window.
 * Each prediction is stored as a residual detector entry so stale predictions
 * are automatically surfaced when reality diverges.
 *
 * Follow the predict → validate → residual template used by the live cost model.
 */

export interface GapRecord {
  id: string;
  category: string;
  remediation?: string;
  affectedFiles?: string[];
  status: "open" | "closed" | "churned";
  landed?: boolean; // true = fix landed at cutover, false = churned/skipped
}

export interface LandabilityPrediction {
  gapId: string;
  score: number; // [0,1] probability of landing
  features: {
    remediationPresent: boolean;
    singleFile: boolean;
    categoryRisk: number;
  };
  recommendation: "keep" | "auto-close";
  residual?: number; // filled in after outcome is known
}

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

function extractFeatures(
  gap: GapRecord,
  categoryRiskMap: Map<string, number>
): { remediationPresent: boolean; singleFile: boolean; categoryRisk: number } {
  return {
    remediationPresent:
      typeof gap.remediation === "string" && gap.remediation.trim().length > 0,
    singleFile: (gap.affectedFiles ?? []).length === 1,
    categoryRisk: categoryRiskMap.get(gap.category) ?? 0.5,
  };
}

// ---------------------------------------------------------------------------
// Build per-category churn-rate prior from closed history
// ---------------------------------------------------------------------------

function buildCategoryRiskMap(
  history: GapRecord[]
): Map<string, number> {
  const closed = history.filter(
    (g) => g.status === "closed" || g.status === "churned"
  );
  const counts = new Map<string, { total: number; churned: number }>();

  for (const g of closed) {
    const entry = counts.get(g.category) ?? { total: 0, churned: 0 };
    entry.total += 1;
    if (g.landed === false) entry.churned += 1;
    counts.set(g.category, entry);
  }

  const riskMap = new Map<string, number>();
  for (const [cat, { total, churned }] of counts.entries()) {
    // Laplace smoothing with α=1
    riskMap.set(cat, (churned + 1) / (total + 2));
  }
  return riskMap;
}

// ---------------------------------------------------------------------------
// Logistic regression helpers
// ---------------------------------------------------------------------------

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

interface Weights {
  w0: number; // bias
  w1: number; // remediationPresent
  w2: number; // singleFile
  w3: number; // categoryRisk (negative coefficient expected)
}

/**
 * One-pass stochastic gradient descent over closed history to fit weights.
 * Target y=1 means "landed", y=0 means "churned".
 */
function fitWeights(history: GapRecord[], categoryRiskMap: Map<string, number>): Weights {
  const weights: Weights = { w0: 0, w1: 0, w2: 0, w3: 0 };
  const lr = 0.1;

  const labeled = history.filter(
    (g) => (g.status === "closed" || g.status === "churned") &&
           g.landed !== undefined
  );

  for (const g of labeled) {
    const { remediationPresent, singleFile, categoryRisk } = extractFeatures(
      g,
      categoryRiskMap
    );
    const x1 = remediationPresent ? 1 : 0;
    const x2 = singleFile ? 1 : 0;
    const x3 = categoryRisk;
    const y = g.landed ? 1 : 0;

    const z =
      weights.w0 +
      weights.w1 * x1 +
      weights.w2 * x2 +
      weights.w3 * x3;
    const p = sigmoid(z);
    const err = p - y;

    weights.w0 -= lr * err;
    weights.w1 -= lr * err * x1;
    weights.w2 -= lr * err * x2;
    weights.w3 -= lr * err * x3;
  }

  return weights;
}

function predict(weights: Weights, x1: number, x2: number, x3: number): number {
  return sigmoid(
    weights.w0 + weights.w1 * x1 + weights.w2 * x2 + weights.w3 * x3
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score every open gap for landability.
 *
 * @param allGaps  Full gap corpus (open + closed/churned history)
 * @param autoCloseThreshold  Score below this → recommend auto-close (default 0.25)
 * @returns predictions for open gaps only, sorted ascending by score
 */
export function scoreOpenGaps(
  allGaps: GapRecord[],
  autoCloseThreshold = 0.25
): LandabilityPrediction[] {
  const categoryRiskMap = buildCategoryRiskMap(allGaps);
  const weights = fitWeights(allGaps, categoryRiskMap);

  const openGaps = allGaps.filter((g) => g.status === "open");

  const predictions: LandabilityPrediction[] = openGaps.map((g) => {
    const features = extractFeatures(g, categoryRiskMap);
    const x1 = features.remediationPresent ? 1 : 0;
    const x2 = features.singleFile ? 1 : 0;
    const x3 = features.categoryRisk;
    const score = predict(weights, x1, x2, x3);

    return {
      gapId: g.id,
      score,
      features,
      recommendation: score < autoCloseThreshold ? "auto-close" : "keep",
    };
  });

  predictions.sort((a, b) => a.score - b.score);
  return predictions;
}

/**
 * After a gap resolves, compute the residual (prediction error) and return it
 * so callers can feed it into a residual-detector pipeline.
 *
 * residual > 0  → model was over-confident the gap would land (surprise churn)
 * residual < 0  → model was over-confident the gap would churn (surprise land)
 */
export function computeResidual(
  prediction: LandabilityPrediction,
  actuallyLanded: boolean
): number {
  const actual = actuallyLanded ? 1 : 0;
  const residual = prediction.score - actual;
  return residual;
}

/**
 * Convenience: given a list of predictions and their known outcomes, return
 * all entries whose |residual| exceeds `threshold` (default 0.4).
 * These are the gaps where the model was most wrong — prime candidates for
 * manual review and model retraining.
 */
export function detectResiduals(
  predictions: LandabilityPrediction[],
  outcomes: Map<string, boolean>,
  threshold = 0.4
): Array<LandabilityPrediction & { residual: number }> {
  const result: Array<LandabilityPrediction & { residual: number }> = [];

  for (const p of predictions) {
    const landed = outcomes.get(p.gapId);
    if (landed === undefined) continue;
    const residual = computeResidual(p, landed);
    if (Math.abs(residual) >= threshold) {
      result.push({ ...p, residual });
    }
  }

  return result;
}
