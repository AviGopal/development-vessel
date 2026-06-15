import type { ResolverResult } from "./types.js";
import { readFileSync } from "node:fs";

/**
 * cost_expectation_scan — deterministic detector that turns the V30 cost-aware
 * selector's OWN cost expectations into actionable substrate gaps. The closing
 * half of "detection of costs/constraints via our expectations": V30 made the
 * boredom selector predict + validate per-template wall-clock cost and exposed
 * it in boredom-selector-state.json; this scan READS that snapshot and emits a
 * gap when the cost model is miscalibrated or a template is cost-inefficient, so
 * the cost signal routes into the gap → bridge → drafter loop instead of sitting
 * as an unread observable.
 *
 * Two finding classes (cost = the negative component of the §1.1 reward vector):
 *  1. cost_expectation_miscalibrated — cost_model_verdict="surprising"
 *     (mean_cost_residual > 0.5): the substrate's predictions about its own cost
 *     are systematically wrong = a detected constraint to investigate (the
 *     analog of budget_exhausted at the model level).
 *  2. cost_inefficient_template — a productive template (mean >= minMean) whose
 *     expected_cost_ms is >= costMultiple × pool median: it does useful work but
 *     far more expensively than its peers → candidate for a cheaper variant.
 *
 * Mirrors gate_saturation_scan: one server-side resolver, deterministic filter,
 * conditional emit-per-finding, no LLM. Reads the bind-mounted selector snapshot
 * the selector already writes rather than re-deriving any statistic.
 */

interface SnapshotTemplate {
  template_id?: unknown;
  picks?: unknown;
  mean?: unknown;
  expected_cost_ms?: unknown;
  expected_cost_tokens?: unknown;
  value_per_sec?: unknown;
}
interface SelectorSnapshot {
  generated_at?: unknown;
  pool_median_cost_ms?: unknown;
  pool_median_cost_tokens?: unknown;
  mean_cost_residual?: unknown;
  mean_cost_residual_tokens?: unknown;
  cost_residual_samples?: unknown;
  cost_model_verdict?: unknown;
  cost_model_verdict_tokens?: unknown;
  templates?: unknown;
}

export interface CostExpectationScanPointer {
  type: "cost_expectation_scan";
  /** Path to the selector snapshot. Default /workspace/state/boredom-selector-state.json. */
  selectorStatePath?: string;
  /** A template ≥ this × pool-median cost is cost-inefficient. Default 2.0. */
  costMultiple?: number;
  /** Minimum mean (yield) before an expensive template is flagged. Default 0.5. */
  minMean?: number;
  /** Minimum picks before a template can be flagged. Default 5. */
  minPicks?: number;
  devVesselImpulsesUrl?: string;
  dry_run?: boolean;
  maxEmits?: number;
  /** Test hook: use this snapshot instead of reading the file. */
  _snapshot?: SelectorSnapshot;
}

interface CostFinding {
  gap_id: string;
  subtype: "cost_expectation_miscalibrated" | "cost_inefficient_template";
  summary: string;
  metadata: Record<string, unknown>;
  posted: boolean;
  post_status?: number | "error";
}

const DEFAULT_STATE_PATH = "/workspace/state/boredom-selector-state.json";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_COST_MULTIPLE = 2.0;
const DEFAULT_MIN_MEAN = 0.5;
const DEFAULT_MIN_PICKS = 5;
const DEFAULT_MAX_EMITS = 25;

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

export async function resolveCostExpectationScan(
  pointer: CostExpectationScanPointer,
): Promise<ResolverResult> {
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const dryRun = pointer.dry_run === true;
  const maxEmits = pointer.maxEmits ?? DEFAULT_MAX_EMITS;
  const costMultiple = pointer.costMultiple ?? DEFAULT_COST_MULTIPLE;
  const minMean = pointer.minMean ?? DEFAULT_MIN_MEAN;
  const minPicks = pointer.minPicks ?? DEFAULT_MIN_PICKS;

  // 1. Load the selector snapshot the V30 cost model writes each cycle.
  let snap: SelectorSnapshot;
  if (pointer._snapshot) {
    snap = pointer._snapshot;
  } else {
    try {
      snap = JSON.parse(readFileSync(pointer.selectorStatePath ?? DEFAULT_STATE_PATH, "utf-8")) as SelectorSnapshot;
    } catch (err) {
      return {
        shape: "structuredError",
        body: { resolver: "cost_expectation_scan", detail: `selector snapshot unreadable: ${(err as Error).message}` },
      };
    }
  }

  const verdictMs = typeof snap.cost_model_verdict === "string" ? snap.cost_model_verdict : "cold";
  const verdictTok = typeof snap.cost_model_verdict_tokens === "string" ? snap.cost_model_verdict_tokens : "cold";
  const residualMs = num(snap.mean_cost_residual, NaN);
  const residualTok = num(snap.mean_cost_residual_tokens, NaN);
  const poolMedian = num(snap.pool_median_cost_ms, 0);
  const poolMedianTok = num(snap.pool_median_cost_tokens, 0);
  const templates: SnapshotTemplate[] = Array.isArray(snap.templates) ? (snap.templates as SnapshotTemplate[]) : [];

  const findings: CostFinding[] = [];

  // 2a. Model-level: cost expectations systematically wrong on EITHER dimension of
  // the cost vector (wall_ms or tokens). One gap citing whichever dimension drifted.
  const surprising: string[] = [];
  if (verdictMs === "surprising") surprising.push(`wall_ms(residual=${Number.isFinite(residualMs) ? residualMs.toFixed(3) : "?"})`);
  if (verdictTok === "surprising") surprising.push(`tokens(residual=${Number.isFinite(residualTok) ? residualTok.toFixed(3) : "?"})`);
  if (surprising.length > 0) {
    findings.push({
      gap_id: "cost-model-miscalibrated",
      subtype: "cost_expectation_miscalibrated",
      summary:
        `Cost model is miscalibrated on ${surprising.join(" + ")}: prediction error >0.5. The ` +
        `substrate's predictions about its own dispatch cost are systematically off — a detected ` +
        `constraint analogous to budget_exhausted at the model level. Likely a bimodal-cost ` +
        `template (fast hit / slow timeout, or a variable-length LLM draft) the expected-cost EWMA ` +
        `hasn't tracked.`,
      metadata: {
        gap_subtype: "cost_expectation_miscalibrated",
        dimensions: surprising,
        mean_cost_residual_ms: residualMs,
        mean_cost_residual_tokens: residualTok,
        pool_median_cost_ms: poolMedian,
        pool_median_cost_tokens: poolMedianTok,
        // Point the code-fix pipeline at the cost posterior that mispredicts.
        // cited_evidence → scenario.target_file_paths → patch-with-tools target.
        cited_evidence: ["repos/boredom-vessel/src/index.ts"],
        remediation_hint:
          "In repos/boredom-vessel/src/index.ts, the per-template cost posterior (recordCostByTemplate / " +
          "expectedCostMs) tracks only the mean, so a bimodal-cost template (fast hit vs slow timeout) " +
          "mispredicts. Make the cost posterior variance-aware: track the spread (e.g. keep recent samples " +
          "and use a robust/percentile estimate, or store mean+variance) so expectedCost reflects bimodality, " +
          "and have combinedCostAdj use it. Keep the [0.5,2.0] clamp and cold-start ∞ behavior intact.",
      },
      posted: false,
    });
  }

  // 2b. Per-template: productive but far more expensive than peers, on EITHER
  // dimension. Tier-refinement (§8.4) is the natural fix for an inefficient template.
  const flagInefficient = (dim: "ms" | "tokens", median: number) => {
    if (median <= 0) return;
    const get = (t: SnapshotTemplate) => (dim === "ms" ? num(t.expected_cost_ms) : num(t.expected_cost_tokens));
    const ranked = templates
      .filter((t) => num(t.picks) >= minPicks && num(t.mean) >= minMean && get(t) >= costMultiple * median)
      .sort((a, b) => get(b) - get(a));
    for (const t of ranked) {
      const tid = typeof t.template_id === "string" ? t.template_id : "";
      if (!tid) continue;
      const gid = `cost-inefficient-${dim}-${tid}`.replace(/[^a-zA-Z0-9._-]/g, "_");
      if (findings.some((f) => f.gap_id === gid)) continue;
      findings.push({
        gap_id: gid,
        subtype: "cost_inefficient_template",
        summary:
          `Template '${tid}' is cost-inefficient on ${dim}: expected=${get(t)} ` +
          `(≥ ${costMultiple}× pool median ${median}) at mean=${num(t.mean).toFixed(2)}, ` +
          `value_per_sec=${num(t.value_per_sec).toFixed(3)}. Useful work but far more expensive ` +
          `than peers — a candidate for a cheaper variant (§8.4 tier-refinement or narrower scope).`,
        metadata: {
          gap_subtype: "cost_inefficient_template",
          cost_dimension: dim,
          template_id: tid,
          expected_cost: get(t),
          pool_median: median,
          mean: num(t.mean),
          value_per_sec: num(t.value_per_sec),
          remediation_hint:
            "Profile the template's slowest/most-expensive task; collapse an llm/pattern-tier step " +
            "to deterministic where possible (§8.4), or draft a scoped variant. Re-measure.",
        },
        posted: false,
      });
      if (findings.length >= maxEmits) break;
    }
  };
  flagInefficient("ms", poolMedian);
  flagInefficient("tokens", poolMedianTok);

  // 3. Emit one substrateGap per finding (unless dry_run).
  const apiKey = process.env["METABOB_API_KEY"];
  const authHeader: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};
  if (!dryRun) {
    for (const f of findings) {
      const body = {
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: f.gap_id,
              category: "cost_constraint",
              source: "substrate_detected",
              summary: f.summary,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: f.metadata,
            },
          },
        },
      };
      try {
        const resp = await fetch(emitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        f.post_status = resp.status;
        f.posted = resp.ok;
      } catch {
        f.post_status = "error";
      }
    }
  }

  return {
    shape: "costExpectationReport",
    body: {
      cost_model_verdict: verdictMs,
      cost_model_verdict_tokens: verdictTok,
      mean_cost_residual: residualMs,
      mean_cost_residual_tokens: residualTok,
      pool_median_cost_ms: poolMedian,
      pool_median_cost_tokens: poolMedianTok,
      templates_evaluated: templates.length,
      finding_count: findings.length,
      findings,
      dry_run: dryRun,
      snapshot_generated_at: typeof snap.generated_at === "string" ? snap.generated_at : null,
      completed_at: new Date().toISOString(),
    },
  };
}
