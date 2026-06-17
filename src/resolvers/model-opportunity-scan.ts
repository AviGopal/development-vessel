import type { ResolverResult } from "./types.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * model_opportunity_scan — lever-3 meta-detector that GROWS the detectability
 * surface. The richest way to detect gaps is the predict→validate→residual
 * template (cost_expectation_scan is the exemplar: predict dispatch cost → compare
 * to actual → residual = gap). Every quantity the substrate learns to PREDICT
 * becomes a free residual-detector. So instead of hand-adding threshold scans one
 * at a time, this scans for QUANTITIES THE SUBSTRATE RECORDS BUT DOES NOT PREDICT
 * — forward-model opportunities (predict the value before acting) and backward-model
 * opportunities (explain an observed outcome from its causes) — and emits a
 * substrateGap proposing each model, so the modeling work routes into the same
 * gap→drafter→cutover loop.
 *
 * A quantity counts as "modeled" iff its model writes a state file under
 * /workspace/state/. The catalog below is the curated set of high-value modelable
 * pipeline quantities; modeled ones (cost) are negative controls that self-resolve
 * once a model exists. Deterministic, no LLM. Extend CATALOG to widen the surface.
 */

interface ModelCandidate {
  quantity: string;
  kind: "forward" | "backward";
  state_file: string;       // under /workspace/state/ — exists iff a model writes it
  state_key?: string;       // optional: a key that must be present in the state file
  proposed_model: string;   // the predict→validate model to build
  residual_detector: string;// the detector the residual enables (the payoff)
  cited_evidence?: string[];
}

const CATALOG: ModelCandidate[] = [
  // Negative controls — already modeled (predict→validate live), self-resolving.
  { quantity: "dispatch_wallclock_cost", kind: "forward", state_file: "boredom-selector-state.json", state_key: "pool_median_cost_ms",
    proposed_model: "V30 cost posterior (live)", residual_detector: "cost_expectation_scan (live)" },
  { quantity: "dispatch_token_cost", kind: "forward", state_file: "boredom-selector-state.json", state_key: "pool_median_cost_tokens",
    proposed_model: "V31 token posterior (live)", residual_detector: "cost_expectation_scan (live)" },
  // Forward-model opportunities — predict BEFORE acting; residual = surprise = gap.
  { quantity: "patch_convergence_probability", kind: "forward", state_file: "patch-convergence-model.json",
    proposed_model: "P(patch_with_tools converges to a verified edit | proposal features: single-site vs multi-site, target-file LOC, has required_code_modifications, prior outcome on this file). Predict before dispatching apply.",
    residual_detector: "convergence-miscalibration scan + lets apply skip/deprioritize proposals predicted un-convergeable (kills the no_op churn before it burns a turn budget)",
    cited_evidence: ["repos/development-vessel/src/resolvers/apply-proposal-as-patch.ts"] },
  { quantity: "mitosis_evaluate_verdict", kind: "forward", state_file: "mitosis-verdict-model.json",
    proposed_model: "P(vessel_mitosis_evaluate returns FAVORABLE | staged-change features: lines changed, typecheck-clean-on-stage, scope) — predict before staging/cutover dispatch.",
    residual_detector: "verdict-miscalibration scan; lets the loop avoid staging changes predicted UNFAVORABLE",
    cited_evidence: ["repos/development-vessel/src/resolvers/vessel-mitosis-evaluate.ts"] },
  { quantity: "drafter_actionability", kind: "forward", state_file: "drafter-actionability-model.json",
    proposed_model: "P(draft-gap-closing-activity emits a non-empty patch_proposal | scenario features: target_file_paths present?, mode_class, category). Predict before dispatching the drafter on a scenario.",
    residual_detector: "lets pick_priority skip scenarios predicted to yield empty/analytic proposals (the activity_lifecycle no-op case), concentrating drafter cycles on code-fix scenarios",
    cited_evidence: ["repos/development-vessel/src/resolvers/pick-priority-scenario.ts"] },
  // Backward-model opportunity — explain an observed outcome from its causes.
  { quantity: "gap_landability", kind: "backward", state_file: "gap-landability-model.json",
    proposed_model: "Explain landed-vs-not for closed/churned gaps from features (remediation already present?, single-file?, category) → a landability score per OPEN gap. Backward model over the gap→cutover outcome history.",
    residual_detector: "predict gap landability → skip/auto-close gaps whose fix is un-landable (directly prevents the stale-open/churn class gap_lifecycle_scan currently cleans up reactively)",
    cited_evidence: ["repos/development-vessel/src/resolvers/gap-lifecycle-scan.ts"] },
];

export interface ModelOpportunityScanPointer {
  type: "model_opportunity_scan";
  stateDir?: string;         // default /workspace/state
  devVesselImpulsesUrl?: string;
  dry_run?: boolean;
  maxEmits?: number;
}

const DEFAULT_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

export async function resolveModelOpportunityScan(p: ModelOpportunityScanPointer): Promise<ResolverResult> {
  const stateDir = p.stateDir ?? "/workspace/state";
  const dryRun = p.dry_run === true;
  const maxEmits = p.maxEmits ?? 6;
  const emitUrl = p.devVesselImpulsesUrl ?? DEFAULT_URL;

  const modeled = (c: ModelCandidate): boolean => {
    const f = join(stateDir, c.state_file);
    if (!existsSync(f)) return false;
    if (!c.state_key) return true;
    try { const j = JSON.parse(readFileSync(f, "utf-8")); return c.state_key in j && j[c.state_key] != null; }
    catch { return false; }
  };

  const opportunities = CATALOG.filter((c) => !modeled(c));
  const covered = CATALOG.filter(modeled).map((c) => c.quantity);

  const findings = opportunities.map((c) => ({
    gap_id: `model-opportunity-${c.quantity}`.replace(/[^a-zA-Z0-9._-]/g, "_"),
    quantity: c.quantity,
    kind: c.kind,
    summary:
      `${c.kind === "forward" ? "Forward" : "Backward"}-model opportunity: '${c.quantity}' is acted on / observed but NOT predicted. ` +
      `Proposed model: ${c.proposed_model} Payoff: ${c.residual_detector}. ` +
      `Adding it follows the predict→validate→residual template (like the live cost model) — every prediction becomes a free residual-detector, widening detectability.`,
    metadata: {
      gap_subtype: "model_opportunity",
      model_kind: c.kind,
      quantity: c.quantity,
      proposed_model: c.proposed_model,
      residual_detector: c.residual_detector,
      cited_evidence: c.cited_evidence ?? [],
    },
    posted: false as boolean,
    post_status: null as number | "error" | null,
  }));

  const apiKey = process.env["METABOB_API_KEY"];
  const authHeader: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};
  if (!dryRun) {
    for (const f of findings.slice(0, maxEmits)) {
      try {
        const resp = await fetch(emitUrl, {
          method: "POST", headers: { "Content-Type": "application/json", ...authHeader },
          body: JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap: {
            id: f.gap_id, category: "architectural_pattern", source: "substrate_detected",
            summary: f.summary, detected_at: new Date().toISOString(), status: "open",
            classification_metadata: f.metadata,
          } } } }),
          signal: AbortSignal.timeout(8_000),
        });
        f.post_status = resp.status; f.posted = resp.ok;
      } catch { f.post_status = "error"; }
    }
  }

  return {
    shape: "modelOpportunityReport",
    body: {
      catalog_size: CATALOG.length,
      modeled_quantities: covered,
      opportunity_count: opportunities.length,
      findings,
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}
