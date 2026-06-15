/**
 * cyclic_flow_scan — the deterministic, discrete analogue of the Helmholtz–Hodge
 * cyclic (zero-work) component of the substrate's dispatch flow.
 *
 * Honest scope: this is NOT the continuous Hodge decomposition (SUBSTRATE_AS_MDP
 * §8.3 / §11 frontier — no continuous manifold is assumed). It is the discrete,
 * trace-grounded measure the geometry points at: a dispatch is "zero-work" if it
 * completes (or fails) WITHOUT moving the posterior — information_yield in
 * {idle, error}, or a failure, or no output shapes produced. A template whose
 * dispatches are mostly zero-work is circulating without closing a learning
 * cycle — the validator-dispatch livelock signature, generalized and measured.
 *
 * Per-template cyclic_fraction = zero_work / total. The substrate-level
 * cyclic_flow_fraction (aggregate) is the stability scalar: lower = less churn =
 * more stable. It complements detector_coverage's autonomous_closure_ratio
 * (growth axis) to give "growing AND stabilizing" a measurable two-axis read.
 *
 * Emits a wastedCycle substrateGap per genuinely-actionable high-cyclic template
 * (excludes lifecycle meta-activities already covered by phantom/precondition
 * detectors + the validator-dispatch ablation). Same constitutional principle
 * (concept_9ldsmRgqSTd5): a measured wasted-cycle class is an opportunity to fix
 * the loop, routed to the fix-drafter like any other detector's output.
 */

import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const META_ACTIVITY_SUBSTRINGS = ["validator-dispatch", "slot-binding", "create-shape-provider-goal"];

export interface CyclicFlowScanPointer {
  type: "cyclic_flow_scan";
  window_hours?: number;
  trace_limit?: number;
  /** Only emit a wastedCycle gap for templates dispatched at least this many
   *  times in the window (so it is actually consuming cycles). */
  min_dispatches?: number;
  /** cyclic_fraction at or above this ⇒ wasted-cycle candidate. */
  cyclic_threshold?: number;
  emit_gap?: boolean;
  metabobEndpoint?: string;
  devVesselImpulsesUrl?: string;
}

interface ExecutionTrace {
  id?: string;
  activity_id?: string;
  status?: string;
  output_impulse_shapes?: string[];
  executed_at?: string;
  metadata?: { information_yield?: string } | null;
}

interface TemplateFlow {
  template: string;
  total: number;
  zero_work: number;
  examples: string[];
}

function normId(activityId: string | undefined): string {
  if (!activityId) return "unknown";
  // strip record-ref wrapping activity:⟨…⟩ and trailing exec markers
  let id = activityId.replace(/^activity:[⟨<]/, "").replace(/[⟩>]$/, "");
  id = id.replace(/-\d{6,}.*$/, "").replace(/-v\d+$/, "");
  return id;
}

function isMeta(activityId: string | undefined): boolean {
  if (!activityId) return false;
  return META_ACTIVITY_SUBSTRINGS.some((m) => activityId.includes(m));
}

/** Zero-work = completed/failed without moving the posterior. Relies on
 *  information_yield + status, NOT on output_impulse_shapes presence — dev-vessel
 *  ticks have transient/null output shapes in traces even on success (known
 *  recording artifact, finding_2026_06_12), so the no-output heuristic would
 *  over-count successful ticks as zero-work. A successful dispatch with no
 *  explicit yield label is treated as productive (not zero-work). */
function isZeroWork(tr: ExecutionTrace): boolean {
  const iy = tr.metadata?.information_yield;
  if (iy === "idle" || iy === "error") return true;
  if (iy === "productive") return false;
  if (tr.status === "failure" || tr.status === "failed") return true;
  return false; // success without explicit yield → productive
}

async function emitWastedCycle(emitUrl: string, apiKey: string, f: TemplateFlow, frac: number): Promise<boolean> {
  const cls = "wasted_cycle";
  const body = {
    impulse: { pointer: { type: "substrateGap_write", gap: {
      id: `wasted-cycle-${normId(f.template).replace(/[^a-zA-Z0-9]+/g, "_")}`,
      category: "wasted_cycle",
      source: "substrate_detected",
      summary: `Template ${f.template} dispatched ${f.total}× with ${(frac * 100).toFixed(0)}% zero-work (idle/error/failure/no-output) — circulating without closing a learning cycle.`,
      detected_at: new Date().toISOString(),
      status: "open",
      classification_metadata: {
        detector: "cyclic_flow_scan",
        gap_class: cls,
        cited_concept_ids: ["concept_9ldsmRgqSTd5"],
        template: f.template,
        cyclic_fraction: frac,
        total_dispatches: f.total,
        zero_work_dispatches: f.zero_work,
        failure_examples: f.examples.slice(0, 5),
        suggested_remediation: "Diagnose why this template circulates without producing useful output; fix or deprecate it. High cyclic flow is wasted sample budget.",
      },
    } } },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try { const r = await fetch(emitUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }); return r.ok; } catch { return false; }
}

export async function resolveCyclicFlowScan(pointer: CyclicFlowScanPointer): Promise<ResolverResult> {
  const endpoint = pointer.metabobEndpoint ?? METABOB_ENDPOINT;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const windowHours = pointer.window_hours ?? 24;
  const traceLimit = pointer.trace_limit ?? 400;
  const minDispatches = pointer.min_dispatches ?? 5;
  const cyclicThreshold = pointer.cyclic_threshold ?? 0.8;
  const emit = pointer.emit_gap !== false;
  const apiKey = process.env["METABOB_API_KEY"] ?? METABOB_API_KEY;

  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  let traces: ExecutionTrace[] = [];
  try {
    const r = await fetch(`${endpoint}/v2/activities/execution-traces?limit=${traceLimit}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (r.ok) { const j = await r.json() as { executions?: ExecutionTrace[] }; traces = j.executions ?? []; }
  } catch { /* tolerant */ }

  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const inWindow = traces.filter((tr) => { if (tr.executed_at) { const t = Date.parse(tr.executed_at); if (!isNaN(t) && t < cutoff) return false; } return true; });

  // Aggregate (all templates, incl. meta — honest total churn) AND non-meta
  // (the learning-stability scalar: excludes structural lifecycle noise like
  // validator-dispatch that is already ablated/covered).
  let aggTotal = 0, aggZero = 0, nonMetaTotal = 0, nonMetaZero = 0;
  const flows = new Map<string, TemplateFlow>();
  for (const tr of inWindow) {
    aggTotal += 1;
    const zw = isZeroWork(tr);
    if (zw) aggZero += 1;
    if (isMeta(tr.activity_id)) continue; // excluded from per-template gap emission (already covered)
    nonMetaTotal += 1;
    if (zw) nonMetaZero += 1;
    const id = normId(tr.activity_id);
    let f = flows.get(id);
    if (!f) { f = { template: id, total: 0, zero_work: 0, examples: [] }; flows.set(id, f); }
    f.total += 1;
    if (zw) { f.zero_work += 1; if (tr.id && f.examples.length < 5) f.examples.push(tr.id); }
  }

  const wasted = Array.from(flows.values())
    .map((f) => ({ ...f, fraction: f.zero_work / Math.max(1, f.total) }))
    .filter((f) => f.total >= minDispatches && f.fraction >= cyclicThreshold)
    .sort((a, b) => b.zero_work - a.zero_work);

  let gaps_emitted = 0;
  if (emit) for (const f of wasted) { if (await emitWastedCycle(emitUrl, apiKey, f, f.fraction)) gaps_emitted += 1; }

  const aggregateFraction = aggTotal > 0 ? aggZero / aggTotal : 0;
  const nonMetaFraction = nonMetaTotal > 0 ? nonMetaZero / nonMetaTotal : 0;

  return {
    shape: "cyclicFlowReport",
    body: {
      window_hours: windowHours,
      dispatches_examined: aggTotal,
      // Total churn incl. structural lifecycle noise (validator-dispatch etc.).
      cyclic_flow_fraction: Number(aggregateFraction.toFixed(4)),
      // The LEARNING-stability scalar — non-meta dispatch flow only. This is the
      // one to trend for "stabilizing while growing"; lower is more stable.
      cyclic_flow_fraction_nonmeta: Number(nonMetaFraction.toFixed(4)),
      nonmeta_dispatches: nonMetaTotal,
      zero_work_dispatches: aggZero,
      wasted_cycle_templates: wasted.length,
      gaps_emitted,
      information_yield: wasted.length > 0 ? "productive" : "idle",
      top_wasted: wasted.slice(0, 10).map((f) => ({ template: f.template, dispatches: f.total, zero_work: f.zero_work, fraction: Number(f.fraction.toFixed(3)) })),
      completed_at: new Date().toISOString(),
    },
  };
}
