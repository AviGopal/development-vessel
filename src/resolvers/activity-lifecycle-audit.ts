import type { ResolverResult } from "./types.js";

/**
 * activity_lifecycle_audit — horizon-detector (activity horizon).
 *
 * Stage 1.C of openspec change
 *   2026-06-03-pre-lift-bootstrap-and-architecture-aware-loop
 *
 * Extends template_invocation_history_report with state-signature-affinity
 * scoring. For each template, computes
 *
 *   combined_score = success_rate × recency_weight × signature_affinity
 *
 * Recommends:
 *   - LOAD (should_load_hot)        top N by combined_score with recent_count > 0
 *   - UNLOAD (should_unload)        bottom N by combined_score with recent_count > 0
 *   - PROMOTE (should_promote_proposed)
 *                                   proposed-tagged templates with recent_success >= threshold
 *
 * "Hot-set" recommendations feed into goal-host's catalogue loading
 * (currently goal-host loads everything; this surfaces the data needed for
 * lifecycle-hook activities Stage 4.3 will author).
 *
 * Immunity-pattern compliant: empty inputShapes, single resolver, no LLM.
 */

const DEFAULT_TEMPLATES_URL = "http://127.0.0.1:8080/v2/activities/templates";
const DEFAULT_TRACES_URL = "http://127.0.0.1:8080/v2/activities/execution-traces";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

export interface ActivityLifecycleAuditPointer {
  type: "activity_lifecycle_audit";
  templatesUrl?: string;
  tracesUrl?: string;
  devVesselImpulsesUrl?: string;
  /** Cap on templates pulled. Default 1000. */
  templateFetchCap?: number;
  /** Cap on traces pulled. Default 2000. */
  traceFetchCap?: number;
  /** Hot-set / cold-set size. Default 15. */
  hotSetSize?: number;
  /** Minimum recent_success for promote recommendation. Default 3. */
  promoteThreshold?: number;
  /** Emit cap. Default 5. */
  emitCap?: number;
  dry_run?: boolean;
}

interface TemplateRow {
  id?: unknown;
  tags?: unknown;
  created_at?: unknown;
  registered_at?: unknown;
  proposed?: unknown;
}

interface TraceRow {
  status?: unknown;
  occurred_at?: unknown;
  created_at?: unknown;
  metadata?: unknown;
  variant_id?: unknown;
  activity_id?: unknown;
}

function normalizeId(raw: string): string {
  return raw.replace(/^activity:⟨(.+)⟩$/, "$1");
}

function templateIdOf(t: TemplateRow): string {
  if (typeof t.id === "string" && t.id.length > 0) return normalizeId(t.id);
  return "unknown_template";
}

function traceTemplateId(t: TraceRow): string | null {
  const meta = t.metadata as { template_id?: unknown; state_signature?: unknown } | undefined;
  if (meta && typeof meta.template_id === "string" && meta.template_id.length > 0) {
    return normalizeId(meta.template_id);
  }
  if (typeof t.variant_id === "string" && t.variant_id.length > 0) return normalizeId(t.variant_id);
  if (typeof t.activity_id === "string" && t.activity_id.length > 0) return normalizeId(t.activity_id);
  return null;
}

function traceSignature(t: TraceRow): string | null {
  const meta = t.metadata as { state_signature?: unknown; signature_hash?: unknown } | undefined;
  if (meta && typeof meta.state_signature === "string") return meta.state_signature;
  if (meta && typeof meta.signature_hash === "string") return meta.signature_hash;
  return null;
}

function traceTimestamp(t: TraceRow): number | null {
  if (typeof t.occurred_at === "string") {
    const v = Date.parse(t.occurred_at);
    if (!Number.isNaN(v)) return v;
  }
  if (typeof t.created_at === "string") {
    const v = Date.parse(t.created_at);
    if (!Number.isNaN(v)) return v;
  }
  return null;
}

interface PerTemplateStats {
  template_id: string;
  recent_count: number;
  recent_success: number;
  recent_failure: number;
  success_rate: number;
  newest_trace_ms: number | null;
  recency_weight: number;
  distinct_signatures: number;
  signature_affinity: number;
  combined_score: number;
  is_proposed: boolean;
}

async function fetchJson<T>(url: string, apiKey: string, timeoutMs: number): Promise<T | null> {
  const headers: Record<string, string> = {};
  const jwt = process.env["CONCEPT_DB_JWT"] ?? process.env["METABOB_JWT"] ?? "";
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  else if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

function isProposed(t: TemplateRow): boolean {
  if (t.proposed === true) return true;
  if (Array.isArray(t.tags)) {
    for (const tag of t.tags) {
      if (typeof tag === "string" && (tag === "proposed" || tag === "phase:proposed")) {
        return true;
      }
    }
  }
  return false;
}

async function emitGap(
  emitUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number | "error" }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const resp = await fetch(emitUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: resp.ok, status: resp.status };
  } catch {
    return { ok: false, status: "error" };
  }
}

export async function resolveActivityLifecycleAudit(
  pointer: ActivityLifecycleAuditPointer,
): Promise<ResolverResult> {
  const templatesUrl = pointer.templatesUrl ?? DEFAULT_TEMPLATES_URL;
  const tracesUrl = pointer.tracesUrl ?? DEFAULT_TRACES_URL;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const templateFetchCap = pointer.templateFetchCap ?? 1000;
  const traceFetchCap = pointer.traceFetchCap ?? 2000;
  const hotSetSize = pointer.hotSetSize ?? 15;
  const promoteThreshold = pointer.promoteThreshold ?? 3;
  const emitCap = pointer.emitCap ?? 5;
  const dryRun = pointer.dry_run === true;
  const apiKey = process.env["METABOB_API_KEY"] ?? "";

  // Templates.
  const templates: TemplateRow[] = [];
  let offset = 0;
  const pageSize = 100;
  while (templates.length < templateFetchCap) {
    const url = `${templatesUrl}?limit=${pageSize}&offset=${offset}`;
    const json = await fetchJson<{ templates?: unknown }>(url, apiKey, 15_000);
    const rows = Array.isArray(json?.templates) ? (json?.templates as TemplateRow[]) : [];
    if (rows.length === 0) break;
    templates.push(...rows);
    if (rows.length < pageSize) break;
    offset += rows.length;
  }

  // Traces.
  const tracesJson = await fetchJson<{ executions?: unknown; traces?: unknown }>(
    `${tracesUrl}?limit=${traceFetchCap}`,
    apiKey,
    20_000,
  );
  const traces: TraceRow[] = Array.isArray(tracesJson?.executions)
    ? (tracesJson?.executions as TraceRow[])
    : Array.isArray(tracesJson?.traces)
      ? (tracesJson?.traces as TraceRow[])
      : [];

  // Group traces by template_id.
  interface Bucket {
    total: number;
    success: number;
    failure: number;
    newest: number | null;
    signatures: Set<string>;
  }
  const buckets = new Map<string, Bucket>();
  for (const t of traces) {
    const tid = traceTemplateId(t);
    if (!tid) continue;
    let bucket = buckets.get(tid);
    if (!bucket) {
      bucket = { total: 0, success: 0, failure: 0, newest: null, signatures: new Set() };
      buckets.set(tid, bucket);
    }
    bucket.total++;
    if (t.status === "success" || t.status === "completed") bucket.success++;
    else if (t.status === "failure") bucket.failure++;
    const ts = traceTimestamp(t);
    if (ts !== null && (bucket.newest === null || ts > bucket.newest)) bucket.newest = ts;
    const sig = traceSignature(t);
    if (sig) bucket.signatures.add(sig);
  }

  // Per-template stats.
  const now = Date.now();
  const stats: PerTemplateStats[] = [];
  for (const tpl of templates) {
    const tid = templateIdOf(tpl);
    const bucket = buckets.get(tid);
    if (!bucket) {
      stats.push({
        template_id: tid,
        recent_count: 0,
        recent_success: 0,
        recent_failure: 0,
        success_rate: 0,
        newest_trace_ms: null,
        recency_weight: 0,
        distinct_signatures: 0,
        signature_affinity: 0,
        combined_score: 0,
        is_proposed: isProposed(tpl),
      });
      continue;
    }
    const successRate = bucket.total > 0 ? bucket.success / bucket.total : 0;
    // Recency weight: 1.0 for traces in last 24h, decays to ~0.1 over 14 days.
    const ageDays = bucket.newest !== null ? (now - bucket.newest) / (24 * 3600 * 1000) : 14;
    const recency = Math.max(0, Math.min(1, Math.exp(-ageDays / 5)));
    // Signature affinity: more distinct signatures the template runs across =
    // more "general purpose"; few signatures = "niche/specialised".
    const sigAffinity = Math.min(1, bucket.signatures.size / 5);
    const combined = successRate * recency * (0.5 + 0.5 * sigAffinity);
    stats.push({
      template_id: tid,
      recent_count: bucket.total,
      recent_success: bucket.success,
      recent_failure: bucket.failure,
      success_rate: Math.round(successRate * 1000) / 1000,
      newest_trace_ms: bucket.newest,
      recency_weight: Math.round(recency * 1000) / 1000,
      distinct_signatures: bucket.signatures.size,
      signature_affinity: Math.round(sigAffinity * 1000) / 1000,
      combined_score: Math.round(combined * 1000) / 1000,
      is_proposed: isProposed(tpl),
    });
  }

  const withTraces = stats.filter((s) => s.recent_count > 0);
  const sortedAsc = [...withTraces].sort((a, b) => a.combined_score - b.combined_score);
  const sortedDesc = [...withTraces].sort((a, b) => b.combined_score - a.combined_score);

  // A ranking over a population smaller than twice the slice size carries no
  // information: the two slices overlap, and once withTraces.length <= hotSetSize
  // they are literally the SAME SET. Measured 2026-09-04: 7 templates with traces
  // against the default hotSetSize of 15 produced should_load_hot and should_unload
  // identical 7/7, and the eviction candidates had success_rate 1 with zero failures.
  // Emitting that is worse than emitting nothing, because it reaches the gap store as
  // a real eviction candidate set. Refuse to rank when the population cannot support
  // it; the existing `shouldUnload.length > 0` guard below then emits no finding.
  // Rank a slice that FITS the population instead of refusing to rank. Top-k and
  // bottom-k of n are disjoint whenever k <= floor(n/2), so this can never again
  // return the same template as both hottest and coldest — the defect measured on
  // 2026-09-04, when 7 templates against a hotSetSize of 15 produced identical 7/7
  // sets whose eviction candidates had success_rate 1 with zero failures.
  // The earlier fix gated on withTraces.length >= 2 * hotSetSize, but the audit
  // samples 100 traces across ~4,000 arms and sees 5-7 templates, so that threshold
  // was never met and the audit emitted nothing at all. An odd population leaves its
  // middle element unranked, which is the honest outcome for an ambiguous middle.
  const rankSize = Math.min(hotSetSize, Math.floor(withTraces.length / 2));
  const shouldLoadHot = sortedDesc.slice(0, rankSize);
  const shouldUnload = sortedAsc.slice(0, rankSize);
  const shouldPromoteProposed = stats
    .filter((s) => s.is_proposed && s.recent_success >= promoteThreshold)
    .sort((a, b) => b.combined_score - a.combined_score)
    .slice(0, hotSetSize);

  // Emit findings: one substrateGap per shouldPromoteProposed and one
  // aggregate gap for shouldUnload (so the substrate sees the activity-
  // lifecycle work as a single decision target).
  const findings: Array<{ subtype: string; detail: string; gap_id: string; emitted: boolean; emit_status?: number | "error" | "skipped" }> = [];

  for (const p of shouldPromoteProposed.slice(0, Math.max(1, emitCap - 1))) {
    findings.push({
      subtype: "should_promote_proposed",
      detail: `proposed template ${p.template_id} has ${p.recent_success} recent successes; promote candidate`,
      gap_id: `activity-lifecycle-promote-${p.template_id}-${Date.now()}`,
      emitted: false,
    });
  }
  if (shouldUnload.length > 0) {
    findings.push({
      subtype: "should_unload_cold_set",
      detail:
        `${shouldUnload.length} templates have combined_score=0 over recent window — ` +
        `candidates for hot-set eviction.`,
      gap_id: `activity-lifecycle-unload-${Date.now()}`,
      emitted: false,
    });
  }

  if (!dryRun) {
    for (const f of findings.slice(0, emitCap)) {
      const result = await emitGap(emitUrl, apiKey, {
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: f.gap_id,
              category: "activity_lifecycle",
              source: "substrate_detected",
              summary: f.detail,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: {
                detector: "activity_lifecycle_audit",
                subtype: f.subtype,
              },
            },
          },
        },
      });
      f.emitted = result.ok;
      f.emit_status = result.status;
    }
  } else {
    for (const f of findings) f.emit_status = "skipped";
  }

  return {
    shape: "activityLifecycleAudit",
    body: {
      total_templates: templates.length,
      templates_with_traces: withTraces.length,
      traces_scanned: traces.length,
      should_load_hot: shouldLoadHot,
      should_unload: shouldUnload,
      should_promote_proposed: shouldPromoteProposed,
      findings,
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}
