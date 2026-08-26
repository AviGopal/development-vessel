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
  // Novel-yield (learning-rate) observables, boredom V29 (2026-06-14). Distinct
  // from saturation: a redundant-pinned detector produces findings every run but
  // nothing NEW (novel_fraction≈0). After novelty-graded reward its mean already
  // decayed, so saturation is blind to it — this is the signal that catches it.
  mean_novel_fraction?: number | null;
  redundant_pinned_count?: number;
  redundant_pinned_templates?: string[];
  novelty_verdict?: string;
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

  // Two ways the selector can be degenerate, each masking learning: (1) SATURATED
  // — arms pinned high (saturated_fraction >= threshold with low variance); (2)
  // UNDIFFERENTIATED — the sampled arms' posterior means are indistinguishable
  // (variance at/below threshold and distinct_means <= 1), so Thompson selection is
  // effectively uniform-random even when nothing is saturated. The original AND-only
  // form missed (2) and reported "healthy" over undifferentiated posteriors.
  const undifferentiated = variance <= varThreshold && (snap.distinct_means ?? 2) <= 1;
  const degenerate = (saturatedFraction >= satThreshold && variance <= varThreshold) || undifferentiated;
  let gapEmission: "emitted" | "error" | "not_needed" = "not_needed";
  if (degenerate) {
    gapEmission = await emitSaturationGap(pointer.devVesselUrl ?? DEFAULT_DEV_VESSEL_URL, snap);
  }

  // Novelty-degeneracy (learning-rate) check — the recursion's recursion. After
  // novelty-graded reward, redundant-pinned detectors no longer saturate (mean
  // decayed), so they are invisible to the saturation check above. They are
  // still a learning-rate leak: cycles spent re-finding known problems. The
  // boredom snapshot now reports them directly.
  const noveltyDegenerate = snap.novelty_verdict === "redundant_pinned"
    && (snap.redundant_pinned_count ?? 0) > 0;
  let noveltyGapEmission: "emitted" | "error" | "not_needed" = "not_needed";
  if (noveltyDegenerate) {
    noveltyGapEmission = await emitNoveltyGap(pointer.devVesselUrl ?? DEFAULT_DEV_VESSEL_URL, snap);
  }

  // Findings array so light-dispatch grades this tick by what it actually
  // surfaced (and so its OWN re-emission is novelty-graded like any detector).
  const findings = [
    ...(degenerate ? [{ type: "reward_saturation", saturated_fraction: saturatedFraction }] : []),
    ...(noveltyDegenerate ? (snap.redundant_pinned_templates ?? []).map((id) => ({ type: "redundant_pinned", template_id: id })) : []),
  ];

  return {
    shape: "selectorRewardHealth",
    body: {
      verdict: degenerate ? (saturatedFraction >= satThreshold ? "saturated" : "undifferentiated") : noveltyDegenerate ? "redundant_pinned" : "healthy",
      sampled_templates: sampled,
      saturated_fraction: saturatedFraction,
      variance_of_means: variance,
      mean_of_means: snap.mean_of_means,
      distinct_means: snap.distinct_means,
      mean_novel_fraction: snap.mean_novel_fraction ?? null,
      redundant_pinned_count: snap.redundant_pinned_count ?? 0,
      snapshot_verdict: snap.saturation_verdict,
      snapshot_novelty_verdict: snap.novelty_verdict,
      gap_emission: gapEmission,
      novelty_gap_emission: noveltyGapEmission,
      findings,
      snapshot_generated_at: snap.generated_at,
      generated_at: new Date().toISOString(),
    },
  };
}

/**
 * Emit a substrateGap for novelty-degeneracy: detectors that produce findings
 * every run but nothing new. The fix is detector-specific (usually: the detector
 * mints volatile/timestamped finding ids so the same finding looks new — make
 * the id stable — or the underlying problem genuinely recurs and needs a fix,
 * not just re-detection). Stable gap id → upsert, no spam.
 */
async function emitNoveltyGap(devVesselUrl: string, snap: SelectorSnapshot): Promise<"emitted" | "error"> {
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
              id: "selector-novelty-degeneracy",
              category: "learning_signal_degeneracy",
              source: "substrate_detected",
              summary:
                `${snap.redundant_pinned_count} detector(s) are redundant-pinned ` +
                `(mean_novel_fraction=${snap.mean_novel_fraction}) — they produce findings every ` +
                `run but nothing NEW, so pool cycles are spent re-detecting known problems. ` +
                `Affected: ${(snap.redundant_pinned_templates ?? []).join(", ")}.`,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: {
                detector: "selector_saturation_audit",
                check: "novelty_degeneracy",
                mean_novel_fraction: snap.mean_novel_fraction,
                redundant_pinned_count: snap.redundant_pinned_count,
                redundant_pinned_templates: snap.redundant_pinned_templates,
                recommended_fix:
                  "for each redundant-pinned detector, make its finding ids stable (strip " +
                  "volatile/timestamp tokens) so re-emission is recognized; or fix the recurring " +
                  "underlying problem so the finding stops being produced",
                root_cause: "detector re-emits the same finding every run (no novelty)",
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
