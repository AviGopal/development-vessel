import type { ResolverResult } from "./types.js";

/**
 * trace_outcome_validity_audit — substrate inspects its OWN trace records for
 * tail_shape/status mismatches (e.g. tail=structuredError + status=success).
 * Clusters matches by signature; emits substrateGap (category=
 * trace_outcome_inconsistency) for each cluster >= min_inconsistencies. Closes
 * the meta-recursion that operator log-scraping closed for the apply-proposal-
 * as-patch echo chamber (commit a0f9f593).
 */

const DEFAULT_METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

export interface TraceOutcomeValidityAuditPointer {
  type: "trace_outcome_validity_audit";
  window_hours?: number;
  min_inconsistencies?: number;
  emit_gap?: boolean;
  metabobEndpoint?: string;
  devVesselImpulsesUrl?: string;
  trace_limit?: number;
}

interface ExecutionTrace {
  id?: string;
  activity_id?: string;
  status?: string;
  executed_at?: string;
  output_impulse_shapes?: string[];
}

const RULES: ReadonlyArray<{
  signature: string;
  tail_shape: string;
  status_match: ReadonlySet<string>;
  derived: "no_op" | "failure";
  reason: string;
  fix: string;
}> = [
  {
    signature: "structuredError_recorded_as_success",
    tail_shape: "structuredError",
    status_match: new Set(["success", "completed"]),
    derived: "no_op",
    reason: "tail shape=structuredError + trace.status=success — resolver reported a structured no_op (e.g. no_eligible_work) yet boredom-vessel counted it as a Thompson win.",
    fix: "boredom-vessel recordOutcome should treat tail_shape=structuredError as no_op regardless of HTTP status.",
  },
  {
    signature: "mitosisStaged_recorded_as_success",
    tail_shape: "mitosisStaged",
    status_match: new Set(["success", "completed"]),
    derived: "no_op",
    reason: "tail shape=mitosisStaged + status=success — many emissions carry dispatched:null (dry-run / nothing to stage), inflating the producer's posterior without substantive work.",
    fix: "Distinguish dispatched:null from real-dispatch via a separate shape (e.g. mitosisNoOp) so boredom-vessel sees the absence of work.",
  },
  {
    signature: "variantPromoteResult_recorded_as_success",
    tail_shape: "variantPromoteResult",
    status_match: new Set(["success", "completed"]),
    derived: "no_op",
    reason: "tail shape=variantPromoteResult + status=success — common case admitted_count:0 (gate rejected all candidates) still recorded as Thompson win.",
    fix: "Emit shape=variantPromoteNoOp when admitted_count===0.",
  },
];

async function fetchTraces(endpoint: string, apiKey: string, limit: number): Promise<ExecutionTrace[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const resp = await fetch(`${endpoint}/v2/activities/execution-traces?limit=${limit}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) return [];
    const json = (await resp.json()) as { executions?: ExecutionTrace[] };
    return json.executions ?? [];
  } catch { return []; }
}

async function emitGap(emitUrl: string, apiKey: string, signature: string, hits: Array<{ trace: ExecutionTrace; status: string }>, derived: string, reason: string, fix: string): Promise<{ ok: boolean; status: number | "error" }> {
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: `trace-outcome-inconsistency-${signature}-${Date.now()}`,
          category: "trace_outcome_inconsistency",
          source: "substrate_detected",
          summary: `Trace recording mismatch: ${hits.length} traces with ${signature}. Recorded as ${hits[0]!.status} but substantive outcome was ${derived}. boredom-vessel's recordOutcome doesn't inspect body shape, inflating Thompson posteriors and trapping selection in echo chambers.`,
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            detector: "trace_outcome_validity_audit",
            cite_principle: "outcomes_must_reflect_substantive_work",
            cited_evidence: ["repos/boredom-vessel/src/index.ts:1922-1931"],
            vessel_name: "boredom-vessel",
            target_file_path: "src/index.ts",
            signature,
            suggested_remediation: fix,
            discrepancy_reason: reason,
            inconsistency_examples: hits.slice(0, 3).map((h) => ({
              execution_id: h.trace.id ?? null,
              activity_id: h.trace.activity_id ?? null,
              recorded_status: h.status,
              derived_substantive_outcome: derived,
              output_shapes: h.trace.output_impulse_shapes ?? [],
            })),
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const resp = await fetch(emitUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return { ok: resp.ok, status: resp.status };
  } catch { return { ok: false, status: "error" }; }
}

export async function resolveTraceOutcomeValidityAudit(pointer: TraceOutcomeValidityAuditPointer): Promise<ResolverResult> {
  const endpoint = pointer.metabobEndpoint ?? DEFAULT_METABOB_ENDPOINT;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const windowHours = pointer.window_hours ?? 4;
  const minInconsistencies = pointer.min_inconsistencies ?? 3;
  const emit = pointer.emit_gap !== false;
  const apiKey = process.env["METABOB_API_KEY"] ?? "";
  const cutoff = Date.now() - windowHours * 3600 * 1000;

  const traces = (await fetchTraces(endpoint, apiKey, pointer.trace_limit ?? 200)).filter((t) => {
    if (!t.executed_at) return true;
    const ts = Date.parse(t.executed_at);
    return Number.isFinite(ts) ? ts >= cutoff : true;
  });

  const clusters = new Map<string, Array<{ trace: ExecutionTrace; status: string }>>();
  for (const t of traces) {
    const shapes = t.output_impulse_shapes;
    if (!Array.isArray(shapes) || shapes.length === 0) continue;
    const tail = shapes[shapes.length - 1];
    const status = String(t.status ?? "");
    for (const rule of RULES) {
      if (tail !== rule.tail_shape || !rule.status_match.has(status)) continue;
      const arr = clusters.get(rule.signature) ?? [];
      arr.push({ trace: t, status });
      clusters.set(rule.signature, arr);
    }
  }

  const cluster_summaries: Array<{ signature: string; count: number; proposed_fix: string }> = [];
  const emissions: Array<{ signature: string; status: number | "error" }> = [];
  let gaps_emitted = 0;

  for (const [signature, hits] of clusters.entries()) {
    const rule = RULES.find((r) => r.signature === signature)!;
    cluster_summaries.push({ signature, count: hits.length, proposed_fix: rule.fix });
    if (emit && hits.length >= minInconsistencies) {
      const r = await emitGap(emitUrl, apiKey, signature, hits, rule.derived, rule.reason, rule.fix);
      emissions.push({ signature, status: r.status });
      if (r.ok) gaps_emitted += 1;
    }
  }

  return {
    shape: "traceOutcomeValidityResult",
    body: {
      traces_examined: traces.length,
      rules_evaluated: RULES.length,
      window_hours: windowHours,
      min_inconsistencies: minInconsistencies,
      cluster_summaries,
      gaps_emitted,
      emissions,
      completed_at: new Date().toISOString(),
    },
  };
}
