/**
 * detector_coverage_scan — detect recurring problem classes that NO existing
 * detector covers, and emit a detector_coverage_gap so the substrate can author
 * a detector for that class itself.
 *
 * This is the recursion the operator has been running by hand: every existing
 * detect-X-template (detect-phantom-success-trace, detect-service-oom-cascade,
 * detect-precondition-rejection, ...) was authored by an operator after noticing
 * a recurring bug class. This resolver makes "a recurring bug class has no
 * detector" itself observable as a substrateGap, so the same drafter loop that
 * authors activities can author the next detector — closing SUBSTRATE_AS_MDP
 * §9.3 limit-8 (detection-recursion truncated at the operator boundary).
 *
 * Coverage test (self-calibrating, no hardcoded class list): a problem cluster
 * is COVERED iff its member traces are already cited by an existing substrateGap
 * (via classification_metadata.failure_examples / exemplar_trace_ids). A
 * recurring cluster (count >= minRecurrence) whose traces are essentially
 * un-cited is UNCOVERED — no detector is watching it.
 *
 * Constitutional principle (concept_9ldsmRgqSTd5): every observed bug class is
 * an opportunity to author a detection. Here the bug class is "we have no
 * detector for this bug class."
 */

import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

export interface DetectorCoverageScanPointer {
  type: "detector_coverage_scan";
  window_hours?: number;
  trace_limit?: number;
  min_recurrence?: number;
  /** A cluster is "covered" if at least this fraction of its traces are cited
   *  by an existing substrateGap. Below it ⇒ uncovered ⇒ emit. */
  coverage_threshold?: number;
  emit_gap?: boolean;
  metabobEndpoint?: string;
  devVesselImpulsesUrl?: string;
}

interface ExecutionTrace {
  id?: string;
  activity_id?: string;
  status?: string;
  failure_mode?: { type?: string; reason?: string } | null;
  output_impulse_shapes?: string[];
  executed_at?: string;
  metadata?: { information_yield?: string } | null;
}

interface ProblemCluster {
  gap_class: string;
  failure_type: string;
  activity_prefix: string;
  trace_ids: string[];
  count: number;
  cited_count: number;
  example_reasons: string[];
}

// Lifecycle meta-activities whose "failures" are phantom-success / pre-flight
// rejection traces — already covered by detect-phantom-success-trace and
// detect-precondition-rejection. Excluding them keeps authored detectors
// semantically valid (no redundant detector for already-covered noise). Mirrors
// the exclusion in trace_recurring_pattern_scan / capability_gap_audit.
const META_ACTIVITY_SUBSTRINGS = ["validator-dispatch", "slot-binding", "create-shape-provider-goal"];

function isMetaActivity(activityId: string | undefined): boolean {
  if (!activityId) return false;
  return META_ACTIVITY_SUBSTRINGS.some((m) => activityId.includes(m));
}

function activityPrefix(activityId: string | undefined): string {
  if (!activityId) return "unknown";
  // development-vessel:foo-1780... → development-vessel:foo  (strip trailing -<digits> exec marker)
  const colon = activityId.indexOf(":");
  const vessel = colon >= 0 ? activityId.slice(0, colon) : "";
  let name = colon >= 0 ? activityId.slice(colon + 1) : activityId;
  name = name.replace(/_exec_[a-z0-9]+$/i, "").replace(/-\d{6,}.*$/, "").replace(/-v\d+$/, "");
  return vessel ? `${vessel}:${name}` : name;
}

function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase().replace(/^_+|_+$/g, "");
}

interface CoverageStats {
  cited: Set<string>;
  detector_coverage_gaps_open: number;
  detector_coverage_gaps_closed: number;
}

/** Pull every trace id cited by an existing substrateGap (so we can tell which
 *  clusters already have a detector watching them) AND the detection-coverage
 *  metric (§9.4): how many detector_coverage_gaps are open vs closed — the
 *  autonomous-closure signal for the detector-authoring recursion. */
async function fetchCoverageStats(emitUrl: string, apiKey: string): Promise<CoverageStats> {
  const stats: CoverageStats = { cited: new Set(), detector_coverage_gaps_open: 0, detector_coverage_gaps_closed: 0 };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const r = await fetch(emitUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ impulse: { pointer: { type: "substrateGap", limit: 500 } } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return stats;
    const j = await r.json() as { body?: { gaps?: Array<{ category?: string; status?: string; classification_metadata?: Record<string, unknown> }> } };
    for (const g of j.body?.gaps ?? []) {
      const m = g.classification_metadata ?? {};
      for (const key of ["failure_examples", "exemplar_trace_ids", "trace_ids", "examples"]) {
        const v = m[key];
        if (Array.isArray(v)) for (const id of v) if (typeof id === "string") stats.cited.add(id);
      }
      if (g.category === "detector_coverage_gap") {
        if (g.status === "closed") stats.detector_coverage_gaps_closed += 1;
        else if (g.status === "open") stats.detector_coverage_gaps_open += 1;
      }
    }
  } catch { /* tolerant */ }
  return stats;
}

/** Count substrate-authored detectors (templates tagged substrate.authored).
 *  The growth signal of the recursion. */
async function fetchAuthoredDetectorCount(endpoint: string, apiKey: string): Promise<number> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  // Query the boredom pool (authored detectors carry boredom_target_template)
  // and filter by the substrate.authored tag client-side — FTS tokenizes the
  // dotted tag so a direct q on it misses.
  try {
    const r = await fetch(`${endpoint}/v2/activities/templates?q=boredomtargettemplate&limit=400`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return 0;
    const j = await r.json() as { templates?: Array<{ tags?: string[] }> };
    return (j.templates ?? []).filter((t) => (t.tags ?? []).some((tag) => tag === "substrate.authored" || tag === "substrateauthored")).length;
  } catch { return 0; }
}

async function emitGap(emitUrl: string, apiKey: string, c: ProblemCluster, minRecurrence: number): Promise<boolean> {
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: `detector-coverage-gap-${c.gap_class}`,
          category: "detector_coverage_gap",
          source: "substrate_detected",
          summary: `Recurring problem class "${c.gap_class}" observed ${c.count}× (${c.cited_count} cited by existing detectors) — no detector covers it. Author detect-${c.gap_class}.`,
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            detector: "detector_coverage_scan",
            gap_class: "detector_coverage_gap",
            cite_principle: "substrate_authors_detectors_for_uncovered_problem_classes",
            cited_concept_ids: ["concept_9ldsmRgqSTd5"],
            // The signature an authored detector binds the generic
            // signature_cluster_scan body to:
            target_signature: {
              match: {
                status: "failure",
                failure_type: c.failure_type === "unclassified_failure" ? null : c.failure_type,
                activity_id_prefix: c.activity_prefix === "unknown" ? null : c.activity_prefix,
              },
              min_recurrence: minRecurrence,
              emit_gap_class: c.gap_class,
              emit_summary: `Observed {count}× occurrences of problem class ${c.gap_class}.`,
            },
            occurrence_count: c.count,
            failure_examples: c.trace_ids.slice(0, 8),
            evidence_snippets: c.example_reasons.slice(0, 3),
            suggested_remediation: "Dispatch draft-detector-activity against this gap to author detect-" + c.gap_class + " (binds signature_cluster_scan to target_signature).",
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const r = await fetch(emitUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch { return false; }
}

export async function resolveDetectorCoverageScan(pointer: DetectorCoverageScanPointer): Promise<ResolverResult> {
  const endpoint = pointer.metabobEndpoint ?? METABOB_ENDPOINT;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const windowHours = pointer.window_hours ?? 48;
  const traceLimit = pointer.trace_limit ?? 300;
  const minRecurrence = pointer.min_recurrence ?? 3;
  const coverageThreshold = pointer.coverage_threshold ?? 0.2;
  const emit = pointer.emit_gap !== false;
  const apiKey = process.env["METABOB_API_KEY"] ?? METABOB_API_KEY;

  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  let traces: ExecutionTrace[] = [];
  try {
    const r = await fetch(`${endpoint}/v2/activities/execution-traces?limit=${traceLimit}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (r.ok) { const j = await r.json() as { executions?: ExecutionTrace[] }; traces = j.executions ?? []; }
  } catch { /* tolerant */ }

  const coverageStats = await fetchCoverageStats(emitUrl, apiKey);
  const cited = coverageStats.cited;
  const authoredDetectorCount = await fetchAuthoredDetectorCount(endpoint, apiKey);

  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const failures = traces.filter((tr) => {
    const failed = tr.status === "failure" || tr.status === "failed";
    if (!failed) return false;
    if (isMetaActivity(tr.activity_id)) return false; // covered by phantom/precondition detectors
    if (tr.executed_at) { const t = Date.parse(tr.executed_at); if (!isNaN(t) && t < cutoff) return false; }
    return true;
  });

  // Cluster by (failure_type, activity_prefix). gap_class derived from both.
  const groups = new Map<string, ProblemCluster>();
  for (const tr of failures) {
    const ftype = tr.failure_mode?.type || "unclassified_failure";
    const prefix = activityPrefix(tr.activity_id);
    const key = `${ftype}::${prefix}`;
    const gapClass = snake(`${ftype}_${prefix.replace(/[^a-zA-Z0-9]+/g, "_")}`);
    let g = groups.get(key);
    if (!g) { g = { gap_class: gapClass, failure_type: ftype, activity_prefix: prefix, trace_ids: [], count: 0, cited_count: 0, example_reasons: [] }; groups.set(key, g); }
    g.count += 1;
    if (tr.id) { if (g.trace_ids.length < 20) g.trace_ids.push(tr.id); if (cited.has(tr.id)) g.cited_count += 1; }
    const reason = tr.failure_mode?.reason;
    if (reason && g.example_reasons.length < 5 && !g.example_reasons.includes(reason)) g.example_reasons.push(reason);
  }

  const clusters = Array.from(groups.values());
  const uncovered = clusters
    .filter((c) => c.count >= minRecurrence && (c.cited_count / Math.max(1, c.count)) < coverageThreshold)
    .sort((a, b) => b.count - a.count);

  let gaps_emitted = 0;
  if (emit) for (const c of uncovered) { if (await emitGap(emitUrl, apiKey, c, minRecurrence)) gaps_emitted += 1; }

  return {
    shape: "detectorCoverageReport",
    body: {
      window_hours: windowHours,
      traces_examined: traces.length,
      failures_examined: failures.length,
      clusters_found: clusters.length,
      covered_clusters: clusters.length - uncovered.length,
      // Honesty: clusters below the recurrence floor are NOT watched by any
      // detector; they were silently folded into "covered". Report separately.
      below_recurrence_clusters: clusters.filter((c) => c.count < minRecurrence).length,
      uncovered_clusters: uncovered.length,
      gaps_emitted,
      // §9.4 detection-coverage observable — measurable growth + stability of
      // the detector-authoring recursion.
      detection_coverage: {
        authored_detector_count: authoredDetectorCount,
        detector_coverage_gaps_open: coverageStats.detector_coverage_gaps_open,
        detector_coverage_gaps_closed: coverageStats.detector_coverage_gaps_closed,
        autonomous_closure_ratio: (() => {
          const tot = coverageStats.detector_coverage_gaps_open + coverageStats.detector_coverage_gaps_closed;
          return tot > 0 ? coverageStats.detector_coverage_gaps_closed / tot : null;
        })(),
      },
      information_yield: uncovered.length > 0 ? "productive" : "idle",
      uncovered: uncovered.slice(0, 10).map((c) => ({ gap_class: c.gap_class, count: c.count, cited: c.cited_count, failure_type: c.failure_type, activity_prefix: c.activity_prefix })),
      completed_at: new Date().toISOString(),
    },
  };
}
