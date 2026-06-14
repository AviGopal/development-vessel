import { readFile } from "node:fs/promises";
import type { ResolverResult } from "./types.js";

/**
 * selector_saturation_audit (2026-06-14) — detects degeneracy in the boredom
 * selector's OWN reward distribution: the meta-pathology where the UCB reward
 * collapses so the selector can no longer discriminate productive detectors
 * from idle ones.
 *
 * This is the recursive case named in SUBSTRATE_AS_MDP §9.3 limit-8: the
 * substrate had no detector for a degeneracy in its own improvement process.
 * On 2026-06-14 the selector reward was completion-not-yield, pinning 86% of
 * templates at mean=1.0 (variance ~0) — UCB degenerated to uniform allocation
 * and the substrate spent equal cycles on detectors finding real problems and
 * on ones idling. That was found by hand. This detector makes it self-catching.
 *
 * It reads the selector-state snapshot boredom now writes
 * (/workspace/state/boredom-selector-state.json: per-template reward means +
 * saturated_fraction + variance_of_means + saturation_verdict) and emits a
 * substrateGap when the distribution is saturated, naming the graded
 * information-yield reward (productive=1.0 / idle<1.0) as the fix. Deterministic,
 * cold-start-guarded, stable gap id (upsert, no spam).
 */

const DEFAULT_SNAPSHOT_PATH = "/workspace/state/boredom-selector-state.json";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

export interface SelectorSaturationAuditPointer {
  type: "selector_saturation_audit";
  /** path to boredom's selector-state snapshot. */
  snapshotPath?: string;
  /** saturated_fraction at/above which the selector is degenerate. Default 0.8. */
  saturatedFractionThreshold?: number;
  /** variance_of_means at/below which means are indistinguishable. Default 0.01. */
  varianceThreshold?: number;
  /** minimum sampled templates before a verdict is meaningful (cold-start guard). Default 8. */
  minSampledTemplates?: number;
  /** dev-vessel resolve URL for emitting the substrateGap. */
  devVesselUrl?: string;
}

interface SelectorSnapshot {
  generated_at?: string;
  sampled_templates?: number;
  mean_of_means?: number;
  variance_of_means?: number;
  saturated_fraction?: number;
  distinct_means?: number;
  saturation_verdict?: string;
}

/**
 * Best-effort substrateGap emission. Stable id so repeated ticks upsert one gap
 * rather than spamming. Feeds the gap->scenario->drafter pipeline.
 */
async function emitSaturationGap(
  devVesselUrl: string,
  snap: SelectorSnapshot,
): Promise<"emitted" | "error"> {
  const apiKey = process.env["METABOB_API_KEY"] ?? "";
  try {
    const res = await fetch(devVesselUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: "selector-reward-saturation",
              category: "learning_signal_degeneracy",
              source: "substrate_detected",
              summary:
                `boredom selector reward distribution is saturated ` +
                `(saturated_fraction=${snap.saturated_fraction}, variance_of_means=${snap.variance_of_means}, ` +
                `${snap.sampled_templates} templates) — UCB cannot discriminate productive from idle ` +
                `detectors, so exploration budget is spent uniformly and the learning rate is capped.`,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: {
                detector: "selector_saturation_audit",
                saturated_fraction: snap.saturated_fraction,
                variance_of_means: snap.variance_of_means,
                mean_of_means: snap.mean_of_means,
                sampled_templates: snap.sampled_templates,
                recommended_fix:
                  "grade the selector reward by information yield (productive=1.0 / idle<1.0) " +
                  "instead of mere completion, so UCB exploits detectors that actually produce findings",
                root_cause: "reward = completion, not learning produced",
              },
            },
          },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? "emitted" : "error";
  } catch {
    return "error";
  }
}

export async function resolveSelectorSaturationAudit(
  pointer: SelectorSaturationAuditPointer,
): Promise<ResolverResult> {
  const snapshotPath = pointer.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
  const satThreshold = pointer.saturatedFractionThreshold ?? 0.8;
  const varThreshold = pointer.varianceThreshold ?? 0.01;
  const minSampled = pointer.minSampledTemplates ?? 8;

  let snap: SelectorSnapshot;
  try {
    snap = JSON.parse(await readFile(snapshotPath, "utf-8")) as SelectorSnapshot;
  } catch (err) {
    // No snapshot yet (cold start, or boredom hasn't written one) — not a gap.
    return {
      shape: "selectorRewardHealth",
      body: {
        verdict: "unknown",
        reason: "no selector-state snapshot available",
        snapshot_path: snapshotPath,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        generated_at: new Date().toISOString(),
      },
    };
  }

  const sampled = snap.sampled_templates ?? 0;
  const saturatedFraction = snap.saturated_fraction ?? 0;
  const variance = snap.variance_of_means ?? 0;

  // Cold-start guard: too few sampled templates to judge.
  if (sampled < minSampled) {
    return {
      shape: "selectorRewardHealth",
      body: {
        verdict: "cold_start",
        sampled_templates: sampled,
        min_required: minSampled,
        generated_at: new Date().toISOString(),
      },
    };
  }

  const degenerate = saturatedFraction >= satThreshold && variance <= varThreshold;
  let gapEmission: "emitted" | "error" | "not_needed" = "not_needed";
  if (degenerate) {
    gapEmission = await emitSaturationGap(pointer.devVesselUrl ?? DEFAULT_DEV_VESSEL_URL, snap);
  }

  return {
    shape: "selectorRewardHealth",
    body: {
      verdict: degenerate ? "saturated" : "healthy",
      sampled_templates: sampled,
      saturated_fraction: saturatedFraction,
      variance_of_means: variance,
      mean_of_means: snap.mean_of_means,
      distinct_means: snap.distinct_means,
      snapshot_verdict: snap.saturation_verdict,
      gap_emission: gapEmission,
      snapshot_generated_at: snap.generated_at,
      generated_at: new Date().toISOString(),
    },
  };
}
