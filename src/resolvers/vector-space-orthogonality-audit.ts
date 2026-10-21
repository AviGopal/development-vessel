import type { ResolverResult } from "./types.js";
import { selfAuthHeaders, selfAuthKey } from "../lib/self-auth.js";

/**
 * vector_space_orthogonality_audit — substrate-detected novel-failure-mode
 * discovery via vector-space orthogonality against existing architectural
 * principles.
 *
 * Every architectural_pattern_principle concept in concept-db has an
 * embedding (MiniLM-L6-v2 384-dim). The substrate's detection coverage is
 * bounded by the union of those principles' vector subspaces. A failure
 * trace whose embedding has max cosine similarity < threshold against ALL
 * principles is orthogonal — a novel failure mode the substrate was not
 * taught to detect.
 *
 * We approximate the per-trace nearest-principle similarity by submitting
 * the trace's summary text to /concepts/search?source_type=architectural_
 * pattern_principle and reading the top hit's score. concept-db's dense
 * pipeline already computes cosine similarity server-side and returns the
 * scored row; we just read it.
 *
 * Clustering uses a deterministic group-by-(activity_id, failure_mode_type)
 * key — same shape as trace_failure_pattern_report. For each cluster ≥
 * min_failure_traces, emit one substrateGap with category=
 * novel_failure_mode_detected. Closes the meta-recursion: substrate detects
 * what it wasn't taught to detect, drafter authors the missing principle.
 *
 * EVERY ROW CARRIES THE READING IT WAS FILED ON (classification_metadata.detector_reading,
 * the form substrate-gap.ts detectorReadingCheck reads). A filed row names no check, no
 * edit site and no file, so without it the row is born unarmable. The reading is this
 * resolver re-read under the row's own scope: input.cluster_key limits the answer to that
 * one cluster, the window/threshold/minimum/limit are the ones the filing run used, and
 * emit_gap is false because the judge resolves the check live and a check must never file.
 * Its field, cluster_count, counts the clusters that still meet the filing criterion (1 at
 * filing, 0 once a principle covers the cluster or its failures stop recurring), so the core
 * arms it as a zero_field. A run that could not read the trace store says measured:false,
 * which the judge reads as unknown, so an outage never reads as the defect gone.
 */

const DEFAULT_METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const DEFAULT_CONCEPT_DB_URL = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

export interface VectorSpaceOrthogonalityAuditPointer {
  type: "vector_space_orthogonality_audit";
  trace_window_hours?: number;
  similarity_threshold?: number;
  min_failure_traces?: number;
  emit_gap?: boolean;
  metabobEndpoint?: string;
  conceptDbUrl?: string;
  devVesselImpulsesUrl?: string;
  trace_limit?: number;
  /** Scope the answer to one cluster (its `<activity_id>|<failure_mode_type>` key): the row's own re-read. */
  cluster_key?: string;
}

interface ExecutionTrace {
  id?: string;
  activity_id?: string;
  status?: string;
  failure_mode?: { type?: string; reason?: string } | null;
  executed_at?: string;
  tasks?: Array<{ task_id?: string; success?: boolean }>;
}

interface OrthogonalCluster {
  cluster_key: string;
  representative_trace_ids: string[];
  centroid_summary: string;
  closest_principle_id: string | null;
  closest_principle_name: string | null;
  closest_similarity: number;
  trace_count: number;
}

function stripActivityWrap(id: string): string {
  return id.replace(/^activity:⟨/, "").replace(/⟩$/, "");
}

/** The cluster a trace falls in: `<activity_id>|<failure_mode_type>`. */
function clusterKeyOf(t: ExecutionTrace): string {
  return `${stripActivityWrap(t.activity_id ?? "unknown")}|${t.failure_mode?.type ?? "unknown"}`;
}

function summarizeTrace(t: ExecutionTrace): string {
  const aid = stripActivityWrap(t.activity_id ?? "unknown_activity");
  const fmType = t.failure_mode?.type ?? "unknown_failure";
  const fmReason = (t.failure_mode?.reason ?? "").slice(0, 200);
  const firstFailed = t.tasks?.find((x) => x.success !== true)?.task_id ?? "no_task";
  return `${aid} ${fmType} ${firstFailed} ${fmReason}`.replace(/\s+/g, " ").trim();
}

async function fetchFailureTraces(
  endpoint: string,
  apiKey: string,
  limit: number,
): Promise<{ traces: ExecutionTrace[]; read: boolean }> {
  const url = `${endpoint}/v2/activities/execution-traces?limit=${limit}`;
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  // A read that failed is not a read of zero failures: the caller reports it as measured:false.
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) return { traces: [], read: false };
    const json = (await resp.json()) as { executions?: ExecutionTrace[] };
    return { traces: (json.executions ?? []).filter((t) => t.status === "failure"), read: true };
  } catch {
    return { traces: [], read: false };
  }
}

/** The parameters a filing run used: the input its rows' readings re-read the audit with. */
export interface AuditParams {
  trace_window_hours: number;
  similarity_threshold: number;
  min_failure_traces: number;
  trace_limit: number;
}

/** The reading a row is filed on (substrate-gap.ts detectorReadingCheck): this audit, scoped to the row's cluster,
 *  with the filing run's parameters and emit_gap false; cluster_count is 1 when the cluster meets the criterion. */
export function orthogonalClusterReading(clusterKey: string, params: AuditParams): Record<string, unknown> {
  return {
    shape: "vector_space_orthogonality_audit",
    input: { cluster_key: clusterKey, ...params, emit_gap: false },
    field: "cluster_count",
    value: 1,
  };
}

interface PrincipleHit {
  id?: string;
  name?: string;
  _dense_score?: number;
  fts_score?: number;
}

async function nearestPrincipleSimilarity(
  conceptDbUrl: string,
  apiKey: string,
  query: string,
): Promise<{ id: string | null; name: string | null; sim: number }> {
  const url =
    `${conceptDbUrl}/concepts/search?query=${encodeURIComponent(query.slice(0, 300))}` +
    `&source_type=architectural_pattern_principle&limit=3`;
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return { id: null, name: null, sim: 0 };
    const json = (await resp.json()) as { concepts?: PrincipleHit[] };
    const top = (json.concepts ?? [])[0];
    if (!top) return { id: null, name: null, sim: 0 };
    const sim = Number(top._dense_score ?? top.fts_score ?? 0);
    return { id: top.id ?? null, name: top.name ?? null, sim };
  } catch {
    return { id: null, name: null, sim: 0 };
  }
}

async function emitGap(
  emitUrl: string,
  apiKey: string,
  cluster: OrthogonalCluster,
  params: AuditParams,
): Promise<{ status: number | "error"; ok: boolean }> {
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: `novel-failure-${cluster.cluster_key}-${Date.now()}`,
          category: "novel_failure_mode_detected",
          source: "substrate_detected",
          summary:
            `${cluster.trace_count} failure traces (${cluster.cluster_key}) orthogonal ` +
            `to all architectural principles (max sim=${cluster.closest_similarity.toFixed(3)} ` +
            `vs '${cluster.closest_principle_name ?? "<none>"}'). ` +
            `Centroid: ${cluster.centroid_summary}`,
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            detector: "vector_space_orthogonality_audit",
            cluster_key: cluster.cluster_key,
            representative_trace_ids: cluster.representative_trace_ids,
            closest_principle_id: cluster.closest_principle_id,
            closest_principle_name: cluster.closest_principle_name,
            closest_similarity: cluster.closest_similarity,
            trace_count: cluster.trace_count,
            centroid_summary: cluster.centroid_summary,
            proposed_action:
              "synthesize new architectural_pattern_principle covering this vector subspace",
            detector_reading: orthogonalClusterReading(cluster.cluster_key, params),
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json", ...selfAuthHeaders(emitUrl, DEFAULT_DEV_VESSEL_URL) };
  try {
    const resp = await fetch(emitUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: resp.status, ok: resp.ok };
  } catch {
    return { status: "error", ok: false };
  }
}

export async function resolveVectorSpaceOrthogonalityAudit(
  pointer: VectorSpaceOrthogonalityAuditPointer,
): Promise<ResolverResult> {
  const metabobEndpoint = pointer.metabobEndpoint ?? DEFAULT_METABOB_ENDPOINT;
  const conceptDbUrl = pointer.conceptDbUrl ?? DEFAULT_CONCEPT_DB_URL;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const windowHours = pointer.trace_window_hours ?? 4;
  const threshold = pointer.similarity_threshold ?? 0.45;
  const minFailures = pointer.min_failure_traces ?? 3;
  const emitGapsFlag = pointer.emit_gap !== false;
  const traceLimit = pointer.trace_limit ?? 200;
  const apiKey = process.env["METABOB_API_KEY"] ?? "";

  const scope = typeof pointer.cluster_key === "string" && pointer.cluster_key.trim() !== "" ? pointer.cluster_key.trim() : null;
  const params: AuditParams = { trace_window_hours: windowHours, similarity_threshold: threshold, min_failure_traces: minFailures, trace_limit: traceLimit };

  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const fetched = await fetchFailureTraces(metabobEndpoint, selfAuthKey(metabobEndpoint, DEFAULT_METABOB_ENDPOINT), traceLimit);
  const traces = fetched.traces.filter((t) => {
    if (!t.executed_at) return true;
    const ts = Date.parse(t.executed_at);
    return Number.isFinite(ts) ? ts >= cutoff : true;
  }).filter((t) => scope === null || clusterKeyOf(t) === scope); // a scoped read scores only its cluster's traces

  // 1. Score each trace against nearest principle.
  const scored = await Promise.all(
    traces.map(async (t) => {
      const summary = summarizeTrace(t);
      const nearest = await nearestPrincipleSimilarity(conceptDbUrl, selfAuthKey(conceptDbUrl, DEFAULT_CONCEPT_DB_URL), summary);
      return { trace: t, summary, nearest };
    }),
  );
  let principles_consulted = 0;
  for (const s of scored) {
    if (s.nearest.id !== null) principles_consulted = Math.max(principles_consulted, 1);
  }

  // 2. Filter to orthogonal.
  const orthogonal = scored.filter((s) => s.nearest.sim < threshold);

  // 3. Cluster by (activity_id, failure_mode_type).
  const clusters = new Map<
    string,
    {
      traces: typeof orthogonal;
      key: string;
    }
  >();
  for (const s of orthogonal) {
    const key = clusterKeyOf(s.trace);
    const existing = clusters.get(key);
    if (existing) existing.traces.push(s);
    else clusters.set(key, { key, traces: [s] });
  }

  // 4. Build cluster summaries; emit gaps for those above threshold.
  const out: OrthogonalCluster[] = [];
  for (const c of clusters.values()) {
    if (c.traces.length < minFailures) continue;
    // Choose top-similarity nearest as the cluster's closest principle.
    const best = c.traces.reduce(
      (acc, x) => (x.nearest.sim > acc.sim ? x.nearest : acc),
      { id: null as string | null, name: null as string | null, sim: 0 },
    );
    const reps = c.traces
      .slice(0, 5)
      .map((x) => x.trace.id)
      .filter((x): x is string => typeof x === "string");
    const cluster: OrthogonalCluster = {
      cluster_key: c.key,
      representative_trace_ids: reps,
      centroid_summary: c.traces[0]!.summary.slice(0, 240),
      closest_principle_id: best.id,
      closest_principle_name: best.name,
      closest_similarity: best.sim,
      trace_count: c.traces.length,
    };
    out.push(cluster);
  }

  let gaps_emitted = 0;
  const emissions: Array<{ cluster_key: string; status: number | "error" }> = [];
  if (emitGapsFlag) {
    for (const cl of out) {
      const r = await emitGap(emitUrl, apiKey, cl, params);
      emissions.push({ cluster_key: cl.cluster_key, status: r.status });
      if (r.ok) gaps_emitted += 1;
    }
  }

  return {
    shape: "vectorSpaceOrthogonalityResult",
    body: {
      measured: fetched.read,
      ...(scope !== null ? { cluster_key: scope } : {}),
      cluster_count: out.length,
      traces_examined: traces.length,
      orthogonal_traces: orthogonal.length,
      principles_consulted_per_trace: principles_consulted > 0,
      similarity_threshold: threshold,
      window_hours: windowHours,
      clusters: out,
      gaps_emitted,
      emissions,
      completed_at: new Date().toISOString(),
    },
  };
}
