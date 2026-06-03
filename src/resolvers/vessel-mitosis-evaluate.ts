import type { ResolverResult } from "./types.js";

/**
 * vessel_mitosis_evaluate — fetches recent traces from activity-api, segments
 * them by version_id (read from trace metadata), computes per-version
 * success_rate + failure_mode class set, and renders a verdict:
 *
 *   FAVORABLE       — mitosis success_rate ≥ base + threshold AND no new
 *                     failure_mode classes introduced.
 *   NEUTRAL         — within ±threshold either direction.
 *   UNFAVORABLE     — mitosis success_rate < base - threshold OR a new
 *                     failure_mode class appears.
 *   INSUFFICIENT_DATA — either side has fewer than min_traces_per_version.
 *
 * Version routing keys (in priority order, first present wins):
 *   metadata.version_id
 *   metadata.mitosis_version_id
 *   metadata.dispatch_target_template_id matching mitosis pattern
 *
 * Immunity-pattern: deterministic, no LLM, single resolver.
 */

export interface VesselMitosisEvaluatePointer {
  type: "vessel_mitosis_evaluate";
  base_version_id: string;
  mitosis_version_id: string;
  tracesUrl?: string;
  fetchLimit?: number;
  since?: string;
  min_traces_per_version?: number;
  success_rate_advantage_threshold?: number;
}

const DEFAULT_TRACES_URL = "http://127.0.0.1:8080/v2/activities/execution-traces";
const DEFAULT_FETCH_LIMIT = 200;
const DEFAULT_MIN_TRACES = 3;
const DEFAULT_THRESHOLD = 0.1;

interface TraceLike {
  execution_id?: unknown;
  id?: unknown;
  status?: unknown;
  failure_mode?: unknown;
  metadata?: unknown;
  executed_at?: unknown;
}

function versionIdOf(t: TraceLike, baseId: string, mitosisId: string): string | null {
  const md = (t.metadata ?? {}) as Record<string, unknown>;
  const candidates = [
    md["version_id"],
    md["mitosis_version_id"],
    md["dispatch_target_template_id"],
  ];
  for (const c of candidates) {
    if (typeof c === "string") {
      if (c === baseId || c === mitosisId) return c;
      if (c.includes(mitosisId)) return mitosisId;
      if (c.includes(baseId)) return baseId;
    }
  }
  return null;
}

function execIdOf(t: TraceLike): string {
  if (typeof t.execution_id === "string" && t.execution_id.length > 0) return t.execution_id;
  if (typeof t.id === "string") return t.id;
  return "unknown";
}

function failureModeTypeOf(t: TraceLike): string | null {
  const fm = t.failure_mode;
  if (!fm || typeof fm !== "object") return null;
  const type = (fm as { type?: unknown }).type;
  if (typeof type === "string" && type.length > 0) return type;
  return null;
}

interface VersionStats {
  version_id: string;
  total: number;
  succeeded: number;
  failed: number;
  success_rate: number;
  failure_mode_classes: string[];
  sample_trace_ids: string[];
}

function emptyStats(version_id: string): VersionStats {
  return {
    version_id,
    total: 0,
    succeeded: 0,
    failed: 0,
    success_rate: 0,
    failure_mode_classes: [],
    sample_trace_ids: [],
  };
}

export async function resolveVesselMitosisEvaluate(
  pointer: VesselMitosisEvaluatePointer,
): Promise<ResolverResult> {
  const baseId = pointer.base_version_id;
  const mitosisId = pointer.mitosis_version_id;
  if (!baseId || !mitosisId) {
    return {
      shape: "structuredError",
      body: {
        resolver: "vessel_mitosis_evaluate",
        detail: "base_version_id and mitosis_version_id are required",
      },
    };
  }
  const minTraces = pointer.min_traces_per_version ?? DEFAULT_MIN_TRACES;
  const threshold = pointer.success_rate_advantage_threshold ?? DEFAULT_THRESHOLD;
  const fetchLimit = pointer.fetchLimit ?? DEFAULT_FETCH_LIMIT;
  const url = (pointer.tracesUrl ?? DEFAULT_TRACES_URL) + `?limit=${fetchLimit}`;

  const apiKey = process.env["METABOB_API_KEY"];
  const headers: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};

  let traces: TraceLike[] = [];
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      return {
        shape: "structuredError",
        body: {
          resolver: "vessel_mitosis_evaluate",
          detail: `activity-api traces returned ${resp.status}`,
        },
      };
    }
    const json = (await resp.json()) as { executions?: unknown; traces?: unknown };
    const arr = Array.isArray(json.executions)
      ? json.executions
      : Array.isArray(json.traces)
        ? json.traces
        : [];
    traces = arr as TraceLike[];
  } catch (err) {
    return {
      shape: "structuredError",
      body: {
        resolver: "vessel_mitosis_evaluate",
        detail: `traces fetch failed: ${(err as Error).message}`,
      },
    };
  }

  const since = pointer.since;
  if (since) {
    traces = traces.filter((t) => {
      const ts = typeof t.executed_at === "string" ? t.executed_at : "";
      return ts >= since;
    });
  }

  const base = emptyStats(baseId);
  const mitosis = emptyStats(mitosisId);
  const baseFMs = new Set<string>();
  const mitosisFMs = new Set<string>();

  for (const t of traces) {
    const vid = versionIdOf(t, baseId, mitosisId);
    if (vid !== baseId && vid !== mitosisId) continue;
    const target = vid === baseId ? base : mitosis;
    const fmSet = vid === baseId ? baseFMs : mitosisFMs;
    target.total += 1;
    if (t.status === "success") target.succeeded += 1;
    else if (t.status === "failure") target.failed += 1;
    const fmType = failureModeTypeOf(t);
    if (fmType) fmSet.add(fmType);
    if (target.sample_trace_ids.length < 5) target.sample_trace_ids.push(execIdOf(t));
  }

  base.success_rate = base.total > 0 ? base.succeeded / base.total : 0;
  mitosis.success_rate = mitosis.total > 0 ? mitosis.succeeded / mitosis.total : 0;
  base.failure_mode_classes = Array.from(baseFMs).sort();
  mitosis.failure_mode_classes = Array.from(mitosisFMs).sort();

  let verdict: "FAVORABLE" | "NEUTRAL" | "UNFAVORABLE" | "INSUFFICIENT_DATA";
  let verdict_reason: string;
  const cited_trace_ids: string[] = [...base.sample_trace_ids, ...mitosis.sample_trace_ids];

  if (base.total < minTraces || mitosis.total < minTraces) {
    verdict = "INSUFFICIENT_DATA";
    verdict_reason = `need ≥${minTraces} traces per version (base=${base.total}, mitosis=${mitosis.total})`;
  } else {
    const newFailureClasses = mitosis.failure_mode_classes.filter(
      (c) => !baseFMs.has(c),
    );
    const advantage = mitosis.success_rate - base.success_rate;
    if (newFailureClasses.length > 0) {
      verdict = "UNFAVORABLE";
      verdict_reason = `mitosis introduces new failure_mode class(es): ${newFailureClasses.join(", ")}`;
    } else if (advantage >= threshold) {
      verdict = "FAVORABLE";
      verdict_reason = `mitosis success_rate ${mitosis.success_rate.toFixed(3)} beats base ${base.success_rate.toFixed(3)} by ≥${threshold}`;
    } else if (advantage <= -threshold) {
      verdict = "UNFAVORABLE";
      verdict_reason = `mitosis success_rate ${mitosis.success_rate.toFixed(3)} trails base ${base.success_rate.toFixed(3)} by ≥${threshold}`;
    } else {
      verdict = "NEUTRAL";
      verdict_reason = `success_rate delta ${advantage.toFixed(3)} within ±${threshold}; no failure class regression`;
    }
  }

  return {
    shape: "vesselMitosisEvaluation",
    body: {
      base_version_id: baseId,
      mitosis_version_id: mitosisId,
      verdict,
      verdict_reason,
      threshold,
      min_traces_per_version: minTraces,
      base_success_rate: base.success_rate,
      mitosis_success_rate: mitosis.success_rate,
      base,
      mitosis,
      cited_trace_ids,
      scanned: traces.length,
      window_since: since ?? "(no since filter)",
      evaluated_at: new Date().toISOString(),
    },
  };
}
