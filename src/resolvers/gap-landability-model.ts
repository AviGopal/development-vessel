/**
 * gap-landability-model.ts
 *
 * Backward model: predict gap landability from historical gap→cutover outcome data.
 *
 * Template: predict → validate → residual  (mirrors the live cost model pattern)
 *
 * Features used per gap:
 *   - remediationAlreadyPresent: boolean  (fix file already touched?)
 *   - singleFile: boolean                 (gap touches only one file?)
 *   - category: string                    (gap category label)
 *
 * Training set: closed + churned gaps with known outcome (landed=true/false).
 * Model: naive-Bayes-style log-odds per feature bucket (no external deps).
 *
 * Outputs:
 *   - landabilityScore ∈ [0,1] for every OPEN gap
 *   - residual detector: flags / auto-closes gaps below UNLANDABLE_THRESHOLD
 */

export interface GapRecord {
  id: string;
  status: "open" | "closed" | "churned";
  category: string;
  remediationAlreadyPresent: boolean;
  singleFile: boolean;
  /** Only defined for closed/churned gaps */
  landed?: boolean;
}

export interface LandabilityPrediction {
  gapId: string;
  score: number;          // 0 = very unlikely to land, 1 = very likely
  autoClose: boolean;     // true when score < UNLANDABLE_THRESHOLD
  residualFlag: string | null;
}

// Gaps scoring below this are flagged as un-landable and auto-closed.
const UNLANDABLE_THRESHOLD = 0.25;

// Laplace smoothing constant
const ALPHA = 1;

type FeatureBucket = string; // e.g. "category:lifecycle" | "singleFile:true"

interface FeatureCounts {
  landed: number;
  notLanded: number;
}

interface TrainedModel {
  priorLanded: number;     // P(landed)
  priorNotLanded: number;  // P(not landed)
  buckets: Map<FeatureBucket, FeatureCounts>;
  totalLanded: number;
  totalNotLanded: number;
}

function extractFeatures(gap: GapRecord): FeatureBucket[] {
  return [
    `category:${gap.category}`,
    `remediationAlreadyPresent:${gap.remediationAlreadyPresent}`,
    `singleFile:${gap.singleFile}`,
  ];
}

export function trainModel(history: GapRecord[]): TrainedModel {
  const trainingSet = history.filter(
    (g) => (g.status === "closed" || g.status === "churned") && g.landed !== undefined
  );

  let totalLanded = 0;
  let totalNotLanded = 0;
  const buckets = new Map<FeatureBucket, FeatureCounts>();

  for (const gap of trainingSet) {
    const isLanded = gap.landed === true;
    if (isLanded) totalLanded++; else totalNotLanded++;

    for (const feat of extractFeatures(gap)) {
      if (!buckets.has(feat)) buckets.set(feat, { landed: 0, notLanded: 0 });
      const counts = buckets.get(feat)!;
      if (isLanded) counts.landed++; else counts.notLanded++;
    }
  }

  const total = totalLanded + totalNotLanded;
  const priorLanded = total > 0 ? totalLanded / total : 0.5;
  const priorNotLanded = 1 - priorLanded;

  return { priorLanded, priorNotLanded, buckets, totalLanded, totalNotLanded };
}

export function scoreGap(model: TrainedModel, gap: GapRecord): number {
  const features = extractFeatures(gap);

  // Log-odds accumulation (naive Bayes)
  let logOddsLanded = Math.log(model.priorLanded + 1e-9);
  let logOddsNotLanded = Math.log(model.priorNotLanded + 1e-9);

  for (const feat of features) {
    const counts = model.buckets.get(feat);
    const landedCount = counts ? counts.landed : 0;
    const notLandedCount = counts ? counts.notLanded : 0;

    // Laplace-smoothed P(feature | class)
    const pFeatLanded =
      (landedCount + ALPHA) / (model.totalLanded + ALPHA * 2);
    const pFeatNotLanded =
      (notLandedCount + ALPHA) / (model.totalNotLanded + ALPHA * 2);

    logOddsLanded += Math.log(pFeatLanded);
    logOddsNotLanded += Math.log(pFeatNotLanded);
  }

  // Convert to probability via softmax over two classes
  const maxLog = Math.max(logOddsLanded, logOddsNotLanded);
  const expLanded = Math.exp(logOddsLanded - maxLog);
  const expNotLanded = Math.exp(logOddsNotLanded - maxLog);
  const score = expLanded / (expLanded + expNotLanded);

  return Math.max(0, Math.min(1, score));
}

export function predictLandability(
  history: GapRecord[],
  openGaps: GapRecord[]
): LandabilityPrediction[] {
  const model = trainModel(history);

  return openGaps
    .filter((g) => g.status === "open")
    .map((gap) => {
      const score = scoreGap(model, gap);
      const autoClose = score < UNLANDABLE_THRESHOLD;
      const residualFlag = autoClose
        ? `gap_landability_low: gap ${gap.id} scored ${score.toFixed(3)} < threshold ${UNLANDABLE_THRESHOLD} — predicted un-landable, eligible for auto-close`
        : null;
      return { gapId: gap.id, score, autoClose, residualFlag };
    });
}

/**
 * Residual detector entry-point.
 *
 * Returns auto-close candidates and residual flags for monitoring.
 * Every prediction is a free residual signal (predict→validate→residual template).
 */
export function runLandabilityDetector(allGaps: GapRecord[]): {
  predictions: LandabilityPrediction[];
  autoCloseCandidates: string[];
  residuals: string[];
} {
  const history = allGaps.filter(
    (g) => g.status === "closed" || g.status === "churned"
  );
  const openGaps = allGaps.filter((g) => g.status === "open");

  const predictions = predictLandability(history, openGaps);
  const autoCloseCandidates = predictions
    .filter((p) => p.autoClose)
    .map((p) => p.gapId);
  const residuals = predictions
    .filter((p) => p.residualFlag !== null)
    .map((p) => p.residualFlag as string);

  return { predictions, autoCloseCandidates, residuals };
}
