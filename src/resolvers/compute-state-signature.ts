import { readFile } from "fs/promises";
import { createHash } from "crypto";
import type { ResolverResult } from "./types.js";

/**
 * compute_state_signature — first state-space signature for the substrate.
 *
 * Threads through goal-host dispatches so every trace carries the environment
 * in which the dispatch was decided. Conditioning learning on this lets the
 * substrate distinguish "this template failed under load anomaly" from
 * "this template just fails."
 *
 * Output shape: stateSpaceSignature. Hash is sha1(JSON.stringify(rounded
 * load + counters + catalogue)) → first 8 chars (base32-ish via base36).
 *
 * Performance: must complete in < 3s; called on every dispatch. /proc reads
 * are sub-ms. The two HTTP fetches each have a 1500ms AbortController so the
 * worst case is ~3s even when activity-api is slow.
 *
 * If a fetch fails or times out, the resolver substitutes zero-counts rather
 * than throwing — a degraded signature is still useful (its hash will differ
 * from any healthy-state signature, surfacing the degradation as a feature).
 */

export interface ComputeStateSignaturePointer {
  type: "compute_state_signature";
  /** Window in minutes over which recent_traces is aggregated. Default 30. */
  window_minutes?: number;
  /** Override activity-api endpoint (test injection). */
  activityApiEndpoint?: string;
  /** Override API key (test injection). */
  apiKey?: string;
  /** Override fetch timeout per HTTP call in ms. Default 1500. */
  httpTimeoutMs?: number;
}

const DEFAULT_ACTIVITY_API = "http://127.0.0.1:8080";
const DEFAULT_STATEFUL_UI = "http://127.0.0.1:8270";
const DEFAULT_WINDOW_MINUTES = 30;
const DEFAULT_HTTP_TIMEOUT_MS = 1500;
const STATEFUL_UI_TIMEOUT_MS = 500;

interface ProcLoadResult {
  load_avg_1m: number;
}

interface ProcMemResult {
  mem_used_pct: number;
}

async function readLoadAvg(): Promise<ProcLoadResult> {
  try {
    const buf = await readFile("/proc/loadavg", "utf-8");
    const first = buf.split("\n", 1)[0] ?? "";
    const parts = first.split(/\s+/);
    const load1m = parts[0] !== undefined ? parseFloat(parts[0]) : NaN;
    return { load_avg_1m: Number.isFinite(load1m) ? load1m : 0 };
  } catch {
    return { load_avg_1m: 0 };
  }
}

async function readMemInfo(): Promise<ProcMemResult> {
  try {
    const buf = await readFile("/proc/meminfo", "utf-8");
    let total: number | null = null;
    let avail: number | null = null;
    for (const line of buf.split("\n")) {
      if (line.startsWith("MemTotal:")) {
        const v = parseFloat(line.trim().split(/\s+/)[1] ?? "");
        if (Number.isFinite(v)) total = v;
      } else if (line.startsWith("MemAvailable:")) {
        const v = parseFloat(line.trim().split(/\s+/)[1] ?? "");
        if (Number.isFinite(v)) avail = v;
      }
      if (total !== null && avail !== null) break;
    }
    if (total === null || avail === null || total === 0) return { mem_used_pct: 0 };
    return { mem_used_pct: ((total - avail) / total) * 100 };
  } catch {
    return { mem_used_pct: 0 };
  }
}

async function readCgroupMemPct(): Promise<number | undefined> {
  try {
    const [cur, max] = await Promise.all([
      readFile("/sys/fs/cgroup/memory.current", "utf-8").catch(() => ""),
      readFile("/sys/fs/cgroup/memory.max", "utf-8").catch(() => ""),
    ]);
    const curN = parseInt((cur ?? "").trim(), 10);
    const maxRaw = (max ?? "").trim();
    if (!Number.isFinite(curN) || maxRaw === "" || maxRaw === "max") return undefined;
    const maxN = parseInt(maxRaw, 10);
    if (!Number.isFinite(maxN) || maxN === 0) return undefined;
    return (curN / maxN) * 100;
  } catch {
    return undefined;
  }
}

interface TraceLike {
  status?: unknown;
  success?: unknown;
  duration_ms?: unknown;
  task_count?: unknown;
  executed_at?: unknown;
  failure_mode?: unknown;
}

interface RecentTracesAgg {
  total: number;
  success_rate: number;
  phantom_count: number;
  precondition_count: number;
  top_failure_mode_type?: string;
  avg_duration_ms: number;
}

function aggregateTraces(traces: TraceLike[], windowMs: number): RecentTracesAgg {
  const now = Date.now();
  const cutoff = now - windowMs;
  let total = 0;
  let success = 0;
  let phantoms = 0;
  let precondition = 0;
  let durationSum = 0;
  let durationCount = 0;
  const failureModes: Record<string, number> = {};

  for (const t of traces) {
    let ts = 0;
    if (typeof t.executed_at === "string") {
      const parsed = Date.parse(t.executed_at);
      if (Number.isFinite(parsed)) ts = parsed;
    }
    if (ts !== 0 && ts < cutoff) continue;
    total += 1;
    const status = t.status === "success" || t.success === true ? "success" : "failure";
    const taskCount = typeof t.task_count === "number" ? t.task_count : 0;
    const duration = typeof t.duration_ms === "number" ? t.duration_ms : 0;
    if (status === "success") {
      success += 1;
      if (taskCount === 0) phantoms += 1;
    } else {
      if (taskCount === 0 && duration < 500) precondition += 1;
      const fm = t.failure_mode;
      if (fm && typeof fm === "object") {
        const fmType = (fm as Record<string, unknown>).type;
        if (typeof fmType === "string") {
          failureModes[fmType] = (failureModes[fmType] ?? 0) + 1;
        }
      }
    }
    if (duration > 0) {
      durationSum += duration;
      durationCount += 1;
    }
  }

  let topFailureMode: string | undefined;
  let topCount = 0;
  for (const [k, v] of Object.entries(failureModes)) {
    if (v > topCount) { topFailureMode = k; topCount = v; }
  }

  return {
    total,
    success_rate: total === 0 ? 0 : success / total,
    phantom_count: phantoms,
    precondition_count: precondition,
    top_failure_mode_type: topFailureMode,
    avg_duration_ms: durationCount === 0 ? 0 : Math.round(durationSum / durationCount),
  };
}

async function fetchJsonWithTimeout(
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: apiKey ? { Authorization: `ApiKey ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    const text = await resp.text();
    try { await resp.body?.cancel(); } catch { /* swallow */ }
    if (!resp.ok) return null;
    try { return JSON.parse(text); } catch { return null; }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function computeHash(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const h = createHash("sha1").update(json).digest("hex");
  // Truncate to first 8 hex chars (≈32 bits — sufficient for grouping).
  return h.slice(0, 8);
}

export async function resolveComputeStateSignature(
  pointer: ComputeStateSignaturePointer,
): Promise<ResolverResult> {
  const windowMinutes = pointer.window_minutes ?? DEFAULT_WINDOW_MINUTES;
  const apiEndpoint = pointer.activityApiEndpoint
    ?? process.env["ACTIVITY_API_ENDPOINT"]
    ?? DEFAULT_ACTIVITY_API;
  const apiKey = pointer.apiKey ?? process.env["METABOB_API_KEY"] ?? "";
  const httpTimeout = pointer.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const windowMs = windowMinutes * 60_000;

  // /proc reads — sub-ms each, run in parallel.
  const [loadRes, memRes, cgroupMemPct] = await Promise.all([
    readLoadAvg(),
    readMemInfo(),
    readCgroupMemPct(),
  ]);

  // HTTP fetches in parallel.
  const statefulUiEndpoint = process.env["STATEFUL_UI_VESSEL_ENDPOINT"] ?? DEFAULT_STATEFUL_UI;
  const [tracesResp, templatesResp, uiInputsResp] = await Promise.all([
    fetchJsonWithTimeout(
      `${apiEndpoint}/v2/activities/execution-traces?limit=200`,
      apiKey,
      httpTimeout,
    ),
    fetchJsonWithTimeout(
      `${apiEndpoint}/v2/activities/templates?limit=500`,
      apiKey,
      httpTimeout,
    ),
    fetchJsonWithTimeout(
      `${statefulUiEndpoint}/api/signature-inputs`,
      "", // stateful-ui endpoint is unauthenticated for this read
      STATEFUL_UI_TIMEOUT_MS,
    ),
  ]);

  // UI signature inputs — fold operator-presence into the substrate's
  // state-space signature. Default to zeros on failure (degraded reading
  // still produces a stable hash for the "operator silent" state).
  let uiEvents = 0;
  let uiAsksAgeP95 = 0;
  let uiAssertsPending = 0;
  let uiPanelsOpen = 0;
  if (uiInputsResp && typeof uiInputsResp === "object") {
    const u = uiInputsResp as Record<string, unknown>;
    if (typeof u.recent_interactor_events_count === "number") uiEvents = u.recent_interactor_events_count;
    if (typeof u.unanswered_asks_age_ms_p95 === "number") uiAsksAgeP95 = u.unanswered_asks_age_ms_p95;
    if (typeof u.operator_assertion_pending_count === "number") uiAssertsPending = u.operator_assertion_pending_count;
    if (typeof u.panels_open_count === "number") uiPanelsOpen = u.panels_open_count;
  }
  // Bucket the p95 age to seconds; otherwise tiny clock drift would
  // change the hash every call.
  const uiAsksAgeSec = Math.round(uiAsksAgeP95 / 1000);

  // Aggregate traces.
  let recent: RecentTracesAgg = {
    total: 0, success_rate: 0, phantom_count: 0, precondition_count: 0,
    avg_duration_ms: 0,
  };
  if (tracesResp && typeof tracesResp === "object") {
    const obj = tracesResp as Record<string, unknown>;
    const traces = (obj.executions ?? obj.traces ?? []) as TraceLike[];
    if (Array.isArray(traces)) recent = aggregateTraces(traces, windowMs);
  }

  // Aggregate templates.
  let totalTemplates = 0;
  let proposedCount = 0;
  let substrateAuthoredCount = 0;
  if (templatesResp && typeof templatesResp === "object") {
    const obj = templatesResp as Record<string, unknown>;
    const templates = (obj.templates ?? []) as Array<Record<string, unknown>>;
    if (Array.isArray(templates)) {
      totalTemplates = templates.length;
      for (const t of templates) {
        if (t.proposed === true) proposedCount += 1;
        const id = typeof t.id === "string" ? t.id : "";
        // Substrate-authored = ids matching `gap-closing:auto-...`
        // (handles both raw and `activity:⟨…⟩`-wrapped forms).
        if (id.includes("gap-closing:auto-")) substrateAuthoredCount += 1;
      }
    }
  }

  // Round numeric fields for hash determinism.
  const loadRounded = Math.round(loadRes.load_avg_1m * 10) / 10;
  const memRounded = Math.round(memRes.mem_used_pct);
  const cgroupRounded = cgroupMemPct !== undefined ? Math.round(cgroupMemPct) : undefined;
  const successRateRounded = Math.round(recent.success_rate * 100) / 100;

  const hashPayload: Record<string, unknown> = {
    load: loadRounded,
    mem: memRounded,
    ...(cgroupRounded !== undefined ? { cmem: cgroupRounded } : {}),
    total: recent.total,
    sr: successRateRounded,
    ph: recent.phantom_count,
    pr: recent.precondition_count,
    ...(recent.top_failure_mode_type ? { fm: recent.top_failure_mode_type } : {}),
    tmpl: totalTemplates,
    prop: proposedCount,
    sa: substrateAuthoredCount,
    w: windowMinutes,
    // UI / interactor presence — third-level recursion: operator presence is
    // part of the substrate's environment.
    uie: uiEvents,
    uia: uiAsksAgeSec,
    uip: uiAssertsPending,
    uio: uiPanelsOpen,
  };

  const signature_hash = computeHash(hashPayload);

  return {
    shape: "stateSpaceSignature",
    body: {
      computed_at: new Date().toISOString(),
      window_minutes: windowMinutes,
      load: {
        load_avg_1m: loadRounded,
        mem_used_pct: memRounded,
        ...(cgroupRounded !== undefined ? { cgroup_mem_pct: cgroupRounded } : {}),
      },
      recent_traces: {
        total: recent.total,
        success_rate: successRateRounded,
        phantom_count: recent.phantom_count,
        precondition_count: recent.precondition_count,
        ...(recent.top_failure_mode_type ? { top_failure_mode_type: recent.top_failure_mode_type } : {}),
        avg_duration_ms: recent.avg_duration_ms,
      },
      catalogue: {
        total_templates: totalTemplates,
        proposed_count: proposedCount,
        substrate_authored_count: substrateAuthoredCount,
      },
      ui: {
        recent_interactor_events_count: uiEvents,
        unanswered_asks_age_ms_p95: uiAsksAgeP95,
        operator_assertion_pending_count: uiAssertsPending,
        panels_open_count: uiPanelsOpen,
      },
      signature_hash,
    },
  };
}
