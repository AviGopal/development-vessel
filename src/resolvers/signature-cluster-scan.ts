/**
 * signature_cluster_scan — the GENERIC, PARAMETERIZED detector body.
 *
 * Every detector the substrate authors for a newly-uncovered problem class is a
 * one-task activity that binds THIS resolver to a `match` signature. That is
 * what makes detector-authoring autonomous: a new detector needs no new resolver
 * code deployed — only a new config (the signature) bound by the drafter. The
 * generalization of detect-phantom-success-trace / detect-precondition-rejection
 * / detect-service-oom-cascade into one body parameterized by signature.
 *
 * Scans recent traces, counts those matching the signature, and (if recurrence
 * meets threshold) emits a substrateGap of the configured class citing examples.
 * That gap routes to the existing fix-drafter exactly like any hand-authored
 * detector's output — same process.
 */

import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

export interface SignatureMatch {
  status?: string | null;
  failure_type?: string | null;
  activity_id_prefix?: string | null;
  /** Substring that must appear anywhere in activity_id (e.g. "{{" for an
   *  uninterpolated-placeholder leak). Complements activity_id_prefix. */
  activity_id_contains?: string | null;
  output_shapes_include?: string[] | null;
}

export interface SignatureClusterScanPointer {
  type: "signature_cluster_scan";
  match: SignatureMatch;
  min_recurrence?: number;
  emit_gap_class: string;
  emit_summary?: string;
  window_hours?: number;
  trace_limit?: number;
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
}

function matches(tr: ExecutionTrace, m: SignatureMatch): boolean {
  if (m.status && tr.status !== m.status && !(m.status === "failure" && tr.status === "failed")) return false;
  if (m.failure_type && (tr.failure_mode?.type ?? "") !== m.failure_type) return false;
  if (m.activity_id_prefix) {
    const id = tr.activity_id ?? "";
    if (!id.startsWith(m.activity_id_prefix)) return false;
  }
  if (m.activity_id_contains) {
    const id = tr.activity_id ?? "";
    if (!id.includes(m.activity_id_contains)) return false;
  }
  if (m.output_shapes_include && m.output_shapes_include.length > 0) {
    const have = new Set(tr.output_impulse_shapes ?? []);
    if (!m.output_shapes_include.every((s) => have.has(s))) return false;
  }
  return true;
}

export async function resolveSignatureClusterScan(pointer: SignatureClusterScanPointer): Promise<ResolverResult> {
  const endpoint = pointer.metabobEndpoint ?? METABOB_ENDPOINT;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const windowHours = pointer.window_hours ?? 48;
  const traceLimit = pointer.trace_limit ?? 300;
  const minRecurrence = pointer.min_recurrence ?? 3;
  const emit = pointer.emit_gap !== false;
  const apiKey = process.env["METABOB_API_KEY"] ?? METABOB_API_KEY;
  const gapClass = pointer.emit_gap_class;

  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  let traces: ExecutionTrace[] = [];
  try {
    const r = await fetch(`${endpoint}/v2/activities/execution-traces?limit=${traceLimit}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (r.ok) { const j = await r.json() as { executions?: ExecutionTrace[] }; traces = j.executions ?? []; }
  } catch { /* tolerant */ }

  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const matched = traces.filter((tr) => {
    if (tr.executed_at) { const t = Date.parse(tr.executed_at); if (!isNaN(t) && t < cutoff) return false; }
    return matches(tr, pointer.match);
  });
  const exampleIds = matched.map((t) => t.id).filter((x): x is string => !!x).slice(0, 8);
  const reasons = Array.from(new Set(matched.map((t) => t.failure_mode?.reason).filter((x): x is string => !!x))).slice(0, 3);

  let emitted = false;
  if (emit && matched.length >= minRecurrence) {
    const summary = (pointer.emit_summary ?? `Observed {count}× occurrences of ${gapClass}.`).replace("{count}", String(matched.length));
    const body = {
      impulse: { pointer: { type: "substrateGap_write", gap: {
        id: `${gapClass}-${new Date().toISOString().slice(0, 10)}`,
        category: gapClass,
        source: "substrate_detected",
        summary,
        detected_at: new Date().toISOString(),
        status: "open",
        classification_metadata: {
          detector: `detect-${gapClass}`,
          gap_class: gapClass,
          cited_concept_ids: ["concept_9ldsmRgqSTd5"],
          occurrence_count: matched.length,
          failure_examples: exampleIds,
          evidence_snippets: reasons,
          match_signature: pointer.match,
        },
      } } },
    };
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) h["Authorization"] = `ApiKey ${apiKey}`;
    try { const r = await fetch(emitUrl, { method: "POST", headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }); emitted = r.ok; } catch { /* tolerant */ }
  }

  return {
    shape: "substrateGap",
    body: {
      gap_class: gapClass,
      traces_examined: traces.length,
      matched: matched.length,
      min_recurrence: minRecurrence,
      gap_emitted: emitted,
      information_yield: matched.length >= minRecurrence ? "productive" : "idle",
      examples: exampleIds,
      completed_at: new Date().toISOString(),
    },
  };
}
