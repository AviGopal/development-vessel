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
  /**
   * Optional list of concept ids that were loaded as priors for the dispatch
   * decision (e.g. via concept_select_for_prompt). Folded into the signature
   * hash so the substrate can distinguish "this template fired with concept
   * priors X loaded" from "fired blind" — concept-conditioned learning.
   * Empty/missing → treated as zero loaded concepts. Optional for back-compat.
   */
  loaded_concept_ids?: string[];
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

/**
 * Bucket a non-negative integer onto a coarse log-spaced scale:
 *   0 → 0, 1-9 → 1, 10-49 → 2, 50-199 → 3, 200-499 → 4, 500+ → 5
 * Used to collapse trace-count-like inputs so the signature is stable
 * across the operational classes (idle, light, busy, saturated).
 */
function bucketLog(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < 10) return 1;
  if (n < 50) return 2;
  if (n < 200) return 3;
  if (n < 500) return 4;
  return 5;
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

  // ACTIVITY-CLASS AXIS (signature widening, 2026-06-07).
  // Observation: with only 5 hash fields (load/mem/sr/op/lcc) the substrate
  // collapsed to 2 distinct signatures over 4h, meaning the pool exists in
  // bimodal operation (drafter-heavy vs observer-heavy) without distinguishing
  // which one. Add a coarse axis describing the DOMINANT recent activity class
  // so Thompson can learn separate posteriors per operational mode without
  // breaking the coarsening discipline (still discrete; still few classes).
  //
  // Five operational classes mapped from template id substrings:
  //   1=drafter, 2=mitosis, 3=apply, 4=observer, 5=audit, 0=mixed/idle
  // Derived from the top-K most-executed templates in the recent_traces window.
  let dominantActivityClass = 0;
  if (tracesResp && typeof tracesResp === "object") {
    const obj = tracesResp as Record<string, unknown>;
    const traces = (obj.executions ?? obj.traces ?? []) as Array<Record<string, unknown>>;
    if (Array.isArray(traces) && traces.length > 0) {
      const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      const now = Date.now();
      const cutoff = now - windowMs;
      for (const t of traces) {
        const ts = typeof t.executed_at === "string" ? Date.parse(t.executed_at) : 0;
        if (ts !== 0 && ts < cutoff) continue;
        const tid = typeof t.template_id === "string" ? t.template_id : "";
        if (tid.includes("draft") || tid.includes("dispatch-latest-auto-draft")) counts[1]! += 1;
        else if (tid.includes("mitosis")) counts[2]! += 1;
        else if (tid.includes("apply-proposal") || tid.includes("apply_proposal")) counts[3]! += 1;
        else if (tid.includes("observer-tick") || tid.includes("dropped")) counts[4]! += 1;
        else if (tid.includes("audit-tick") || tid.includes("health-tick")) counts[5]! += 1;
      }
      let topClass = 0;
      let topCount = 0;
      for (const k of [1, 2, 3, 4, 5]) {
        if ((counts[k] ?? 0) > topCount) { topClass = k; topCount = counts[k] ?? 0; }
      }
      dominantActivityClass = topClass;
    }
  }

  // Round numeric fields for hash determinism.
  const loadRounded = Math.round(loadRes.load_avg_1m * 10) / 10;
  const memRounded = Math.round(memRes.mem_used_pct);
  const cgroupRounded = cgroupMemPct !== undefined ? Math.round(cgroupMemPct) : undefined;
  const successRateRounded = Math.round(recent.success_rate * 100) / 100;

  // BUCKETING (signature coarsening, 2026-06-04) — observation at
  // `validation/findings/self-improvement-loop-2026-06-04` showed signature
  // changed nearly every tick, so (signature, goal_idx) cells never reached
  // ≥3 samples and Thompson degraded to round_robin every cycle. Coarsen
  // each high-entropy input to an operational class so similar substrate
  // loadouts collapse to the same signature.
  const bucketTotal = bucketLog(recent.total);          // {0, 1-9, 10-49, 50-199, 200-499, 500+}
  const bucketTmpl = Math.floor(totalTemplates / 100);  // every 100 templates
  const bucketProp = Math.floor(proposedCount / 10);    // every 10 proposed
  const bucketSa = Math.floor(substrateAuthoredCount / 10);
  const bucketUie = Math.floor(uiEvents / 5);
  // Load tier — collapse 1m loadavg to a 4-class operational class.
  //   0 = idle (<1.0), 1 = light (1-3), 2 = busy (3-8), 3 = saturated (>=8)
  // Substrate sees load_avg_1m fluctuate wildly under work (5-15 range), so
  // raw 0.5-increments still produced a fresh hash every call. Class collapse
  // makes signature stable across moment-to-moment load drift while still
  // distinguishing operational regimes.
  const bucketLoad =
    loadRes.load_avg_1m < 1 ? 0 :
    loadRes.load_avg_1m < 3 ? 1 :
    loadRes.load_avg_1m < 8 ? 2 : 3;
  // Mem tier — same idea. 25% buckets collapse minor heap fluctuation.
  const bucketMem = Math.floor(memRes.mem_used_pct / 25) * 25;
  // Success-rate tier — 0.25 buckets capture healing/oscillating/stalled regimes.
  const bucketSr = Math.round(recent.success_rate * 4) / 4;
  // cgroup mem tier — same 25% buckets.
  const bucketCgroup = cgroupMemPct !== undefined ? Math.floor(cgroupMemPct / 25) * 25 : undefined;

  // Concept priors — deduplicated, sorted for hash stability. Empty list when
  // no priors are loaded (default) → contributes [] to the hash so empty-prior
  // and absent-input states collapse to the same signature class.
  const loadedConceptIds = Array.isArray(pointer.loaded_concept_ids)
    ? Array.from(new Set(pointer.loaded_concept_ids.filter((s): s is string => typeof s === "string"))).sort()
    : [];
  const loadedConceptCount = loadedConceptIds.length;

  // Hash payload uses BUCKETED values throughout (see "BUCKETING" comment
  // above). The signature represents the substrate's operational state class,
  // not its exact moment. We drop the raw concept-id list (`lci`) from the
  // hash — it was the highest-entropy contributor; the bucketed count `lcc`
  // is enough class-discrimination for state-conditioned learning. Phantom
  // and precondition counts are also bucketed so trace-by-trace fluctuation
  // doesn't shift signature classes.
  // SIGNATURE COARSENING v2 (2026-06-04 Part B). Observation: even after v1
  // bucketing each cycle still produced a fresh hex signature, so per-cell
  // Thompson never accumulated ≥3 samples and goal-level state-conditioned
  // selection degraded to round_robin on every dispatch. v2 drops fields
  // that represent rate/count drift rather than operational state class:
  //   - `total` (trace-count bucket): churned even within stable load class
  //   - `top_failure_mode_type` (free string): differs per most-recent failure
  //   - `tmpl`, `sa`, `prop`: monotone-increasing as substrate authors
  //     templates; would shift signature class permanently after each batch
  //   - `ph` / `pr`: phantom / precondition counters; noisy
  //   - per-call UI ages: bucketed to operator-present (any signal) vs absent
  // Retain only inputs that map to genuine operational classes:
  //   - load tier (idle / light / busy)
  //   - memory pressure tier
  //   - success-rate tier (healing / oscillating / stalled)
  //   - operator-presence binary (uie buckets to {0, ≥1})
  //   - concept-prior bucket (no priors / few / many)
  // Goal: across a stable substrate window, ≤5 distinct signatures.
  const opPresenceTier =
    bucketUie > 0 || uiAssertsPending > 0 || uiPanelsOpen > 0 ? 1 : 0;
  // Rhythm/cadence axis fetch (dev-vessel's own pool store). Degrades to empty
  // list on any failure so the signature stays defined.
  type RhythmImpulse = {
    id?: string;
    shape?: string;
    body?: {
      axis?: string;
      axis_code?: number;
      family?: string;
      budget?: number;
      alpha?: number;
      beta?: number;
      staleness?: number;
    };
  };
  let rhythmImpulses: RhythmImpulse[] = [];
  try {
    const rCtrl = new AbortController();
    const rTimer = setTimeout(() => rCtrl.abort(), 800);
    try {
      const rResp = await fetch("http://127.0.0.1:8090/v2/impulses/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          impulse: {
            type: "poolImpulse",
            shape: "timeShapedRhythm",
            limit: 50,
          },
        }),
        signal: rCtrl.signal,
      });
      if (rResp.ok) {
        const rJson = (await rResp.json()) as {
          body?: { impulses?: RhythmImpulse[] };
        } | null;
        const arr = rJson?.body?.impulses;
        if (Array.isArray(arr)) rhythmImpulses = arr;
      }
    } finally {
      clearTimeout(rTimer);
    }
  } catch {
    rhythmImpulses = [];
  }
  const rhythmScored = rhythmImpulses.map((r) => {
    const b = r.body ?? {};
    const alpha = typeof b.alpha === "number" ? b.alpha : 1;
    const beta = typeof b.beta === "number" ? b.beta : 1;
    const staleness = typeof b.staleness === "number" ? b.staleness : 0;
    const budget = typeof b.budget === "number" ? b.budget : 1;
    const denom = alpha + beta > 0 ? alpha + beta : 1;
    const due_score = (alpha / denom) * staleness / Math.max(budget, 0.05);
    const affordableBudget = budget <= 1 - bucketLoad / 3;
    const presenceOk = b.axis === "presence" ? opPresenceTier === 1 : true;
    const affordable = affordableBudget && presenceOk;
    return {
      id: typeof r.id === "string" ? r.id : "",
      axis: typeof b.axis === "string" ? b.axis : "",
      axis_code: typeof b.axis_code === "number" ? b.axis_code : 0,
      family: typeof b.family === "string" ? b.family : "",
      due_score,
      affordable,
    };
  });
  const affordableRhythms = rhythmScored.filter((r) => r.affordable);
  const dueCount = affordableRhythms.filter((r) => r.due_score >= 1.0).length;
  const cadenceDueTier = dueCount === 0 ? 0 : dueCount <= 2 ? 1 : 2;
  let dominantRhythmAxis = 0;
  let dominantRhythmFamily = "";
  let bestScore = -Infinity;
  for (const r of affordableRhythms) {
    if (r.due_score > bestScore) {
      bestScore = r.due_score;
      dominantRhythmAxis = r.axis_code;
      dominantRhythmFamily = r.family;
    }
  }
  if (affordableRhythms.length === 0) {
    dominantRhythmAxis = 0;
    dominantRhythmFamily = "";
  }

  const hashPayload: Record<string, unknown> = {
    load: bucketLoad,
    mem: bucketMem,
    ...(bucketCgroup !== undefined ? { cmem: bucketCgroup } : {}),
    sr: bucketSr,
    // operator presence — collapsed to binary class
    op: opPresenceTier,
    cad: cadenceDueTier,
    rhy: dominantRhythmAxis,
    // concept-prior bucket (no priors / few / many)
    lcc: Math.floor(loadedConceptCount / 5),
    // activity-class axis (V16 widening 2026-06-07) — discrete 0-5
    act: dominantActivityClass,
  };
  // Reference unused buckets so lint stays clean — they're retained in the
  // observability body even though they no longer affect the hash.
  void bucketTotal;
  void bucketTmpl;
  void bucketProp;
  void bucketSa;
  void bucketUie;
  void uiAsksAgeSec;
  // Suppress unused-vars warnings while preserving the original rounded
  // values in the response body below.
  void loadRounded; void memRounded; void cgroupRounded; void successRateRounded;

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
      concept_priors: {
        loaded_concept_count: loadedConceptCount,
        // Surface a sample for inspection. Full list is in the hash payload.
        loaded_concept_ids_sample: loadedConceptIds.slice(0, 5),
      },
      rhythm: {
        due_count: dueCount,
        cadence_due_tier: cadenceDueTier,
        dominant_rhythm_axis: dominantRhythmAxis,
        dominant_rhythm_family: dominantRhythmFamily,
        rhythms: rhythmScored
          .slice(0, 8)
          .map((r) => ({ id: r.id, family: r.family, due_score: Math.round(r.due_score * 100) / 100 })),
      },
      dominant_activity_class: dominantActivityClass,
      signature_hash,
    },
  };
}
