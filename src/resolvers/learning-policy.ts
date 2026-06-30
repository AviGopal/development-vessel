/**
 * learning_policy — substrate-authored resolver (Seam ③).
 * Output shape: learningPolicy
 */

import type { ResolverResult } from "./types.js";

export interface LearningPolicyPointer {
  type: "learning_policy";
  [key: string]: unknown;
}

export async function resolveLearningPolicy(pointer: LearningPolicyPointer): Promise<ResolverResult> {
  const activityApi = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
  const headers = {
    "Authorization": `ApiKey ${process.env.METABOB_API_KEY ?? ""}`,
    "Content-Type": "application/json",
  };

  // Read REAL per-template Thompson posteriors from the activity-api.
  let templates: Array<{
    id?: string;
    metrics?: { thompson_alpha?: number; thompson_beta?: number; success_rate?: number };
  }> = [];
  try {
    const res = await fetch(`${activityApi}/v2/activities/templates?limit=100`, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      const data = (await res.json()) as { templates?: typeof templates };
      templates = Array.isArray(data.templates) ? data.templates : [];
    }
  } catch (_e) {
    // tolerate transient failure; fall through with whatever we have
  }

  // Compute posterior means: mean = alpha / (alpha + beta).
  const posteriorMeans: number[] = [];
  const successRates: number[] = [];
  let totalSamples = 0;
  for (const t of templates) {
    const m = t.metrics;
    if (!m) continue;
    const alpha = typeof m.thompson_alpha === "number" ? m.thompson_alpha : 1;
    const beta = typeof m.thompson_beta === "number" ? m.thompson_beta : 1;
    const denom = alpha + beta;
    if (denom > 0) {
      posteriorMeans.push(alpha / denom);
      totalSamples += denom; // alpha+beta ~ pseudo-observation volume
    }
    if (typeof m.success_rate === "number") {
      successRates.push(m.success_rate);
    }
  }

  const observed = posteriorMeans.length;

  // Convergence signal #1 — kappa-spread: max - min of posterior means.
  let kappaSpread = 0;
  if (observed > 0) {
    let lo = posteriorMeans[0]!;
    let hi = posteriorMeans[0]!;
    for (const v of posteriorMeans) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    kappaSpread = hi - lo;
  }

  // Convergence signal #2 — yield-saturation: fraction of templates pinned
  // near success_rate 0 or 1 (within a 0.05 band of either extreme).
  const SAT_BAND = 0.05;
  let pinned = 0;
  for (const sr of successRates) {
    if (sr <= SAT_BAND || sr >= 1 - SAT_BAND) pinned += 1;
  }
  const yieldSaturation = successRates.length > 0 ? pinned / successRates.length : 0;

  // Mean posterior across the learner, for reference.
  let meanPosterior = 0.5;
  if (observed > 0) {
    let acc = 0;
    for (const v of posteriorMeans) acc += v;
    meanPosterior = acc / observed;
  }

  // Recommend the five Thompson hyperparameters from the convergence evidence.
  //
  // High kappa-spread => the posteriors are well-separated and credit is mixing,
  // so we can afford a longer eligibility trace (TD_LAMBDA up) and a lower yield
  // floor (we trust the learner more). High yield-saturation => many templates are
  // pinned (degenerate / over-exploited) so we raise YIELD_FLOOR to force
  // exploration and lower TD_LAMBDA to stop over-crediting saturated rows.
  const TD_LAMBDA = Number(
    Math.max(0.4, Math.min(0.95, 0.6 + 0.4 * kappaSpread - 0.3 * yieldSaturation)).toFixed(3),
  );
  const YIELD_FLOOR = Number(
    Math.max(0.05, Math.min(0.5, 0.1 + 0.4 * yieldSaturation)).toFixed(3),
  );
  // Cost/production references scale with how much real sample volume backs the signal.
  const sampleConfidence = Math.min(1, totalSamples / 1000);
  const YIELD_COST_REF = Number((0.5 + 0.5 * sampleConfidence).toFixed(3));
  const YIELD_PROD_REF = Number((1 + 2 * meanPosterior).toFixed(3));
  // The fewer templates we actually observed, the more we must sample signatures.
  const SIGNATURE_SAMPLING_FLOOR = Number(
    Math.max(0.1, Math.min(1, observed > 0 ? Math.min(1, 50 / observed) : 1)).toFixed(3),
  );

  return {
    shape: "learningPolicy",
    body: {
      recommended_hyperparameters: {
        TD_LAMBDA,
        YIELD_FLOOR,
        YIELD_COST_REF,
        YIELD_PROD_REF,
        SIGNATURE_SAMPLING_FLOOR,
      },
      evidence: {
        kappa_spread: Number(kappaSpread.toFixed(4)),
        yield_saturation: Number(yieldSaturation.toFixed(4)),
        mean_posterior: Number(meanPosterior.toFixed(4)),
        templates_fetched: templates.length,
        templates_with_metrics: observed,
        total_sample_volume: Number(totalSamples.toFixed(1)),
        sample_confidence: Number(sampleConfidence.toFixed(4)),
      },
      rationale:
        "TD_LAMBDA rises with kappa-spread (separated posteriors => safe to lengthen the eligibility trace) and falls with yield-saturation; YIELD_FLOOR rises with yield-saturation to force exploration when templates are pinned; cost/prod refs scale with observed sample volume and mean posterior; SIGNATURE_SAMPLING_FLOOR rises when few templates are observed.",
      generated_at: new Date().toISOString(),
      pointer_type: pointer.type,
    },
  };
}
