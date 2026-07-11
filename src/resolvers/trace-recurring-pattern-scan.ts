import { promises as fs } from "node:fs";
import path from "node:path";
import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

/**
 * trace_recurring_pattern_scan (2026-06-14) — the NON-OBSIDIAN feeder for the
 * real-chain author `draft-activity-from-pattern`.
 *
 * The author consumes a `recurringPatternCluster` (an observed recurrent trace
 * topology). Its only prior feeder, `detect-recurring-pattern`, reads
 * `{{obsidian_vessel_endpoint}}/v1/episodes` — obsidian-coupled, so it cannot
 * run in the core boredom loop (an external app that may be disconnected must
 * not gate the self-development loop). This resolver sources the same cluster
 * contract from the substrate's OWN execution traces instead, so the author has
 * a self-contained, always-available stream of patterns to author clean chains
 * for.
 *
 * Mechanism (deterministic — no LLM, no business decision beyond dispatch):
 *   1. GET recent SUCCESS traces from activity-api.
 *   2. Exclude meta-activities (slot-binding / validator-dispatch /
 *      create-shape-provider-goal), deterministic tick/scan/audit wrappers, and
 *      gap-closing:* clones — none of those are topologies worth re-authoring.
 *   3. Group the rest by their output-impulse-shape signature; the signature
 *      that recurs >= minRecurrence times is the recurrent topology.
 *   4. Count contrast examples (failures over the same producing activities).
 *   5. Build a recurringPatternCluster carrying the SAME anti-scaffold guidance
 *      as vessel_gap_to_cluster (deny_list + topology_hint) so the author emits
 *      a genuine producing chain, NOT a read→analyse→write-a-Proposal clone.
 *   6. Write it to /workspace/patterns/<pattern_id>.json (where the author reads
 *      clusters by id) and optionally dispatch the author.
 *
 * pattern_id is a STABLE hash of the signature so the author's _dispatched.json
 * dedupe collapses back-to-back ticks on the same recurrent topology.
 */

const DEFAULT_PATTERNS_DIR = "/workspace/patterns";
const DEFAULT_GOAL_HOST = process.env["GOAL_HOST_ENDPOINT"] ?? "http://127.0.0.1:8210";
const DRAFTER_TEMPLATE_ID = "development-vessel:draft-activity-from-pattern";

// Activity ids that recur often but are NOT worth authoring a clean chain for:
// inner execution meta-activities (already framework-owned).
const META_ACTIVITY_IDS = new Set([
  "slot-binding",
  "validator-dispatch",
  "create-shape-provider-goal",
]);

// Deterministic single-resolver wrappers — already clean; authoring an
// LLM-chain "alternative" for them is waste.
const DETERMINISTIC_WRAPPER_RE = /-(tick|scan|audit|report|backfill)$|-observer-tick$/;

// The substrate's OWN machinery. Every `development-vessel:*` activity already
// IS a first-class template, so a recurrent dev-vessel topology is by definition
// already authored — re-authoring it is redundant. Excluding the whole prefix
// also prevents the self-reference loop where THIS feeder detects its own
// `recurringPatternCluster` output as the top recurrent pattern.
const SUBSTRATE_MACHINERY_PREFIX = "development-vessel:";

export interface TraceRecurringPatternScanPointer {
  type: "trace_recurring_pattern_scan";
  lookbackHours?: number; // sliding window; default 24
  minRecurrence?: number; // min distinct success traces for a signature; default 3
  limit?: number; // trace fetch cap; default 2000
  patternsDir?: string;
  goalHostEndpoint?: string;
  metabobEndpoint?: string;
  apiKey?: string;
  /** When true, dispatch draft-activity-from-pattern on the written cluster. */
  dispatch?: boolean;
  timeoutMs?: number;
}

interface TraceRow {
  execution_id?: string;
  id?: string;
  activity_id?: string;
  variant_id?: string;
  status?: string;
  success?: boolean;
  output_impulse_shapes?: string[] | null;
  executed_at?: string;
}

function stableHash(s: string): string {
  // Deterministic FNV-1a 32-bit → 8 hex chars. No Math.random / Date dependence.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Strip the `activity:⟨…⟩` record-ref wrapping (incl. the doubled-prefix
 * artifact, ≈800 such ids in the registry) so prefix/meta exclusion sees the
 * bare template id. Without this, a wrapped `activity:⟨development-vessel:…⟩`
 * slips past the dev-vessel-machinery filter and the feeder re-detects its own
 * (or the author's) output.
 */
export function normalizeActivityId(raw: string): string {
  return raw.replace(/activity:⟨/g, "").replace(/⟩/g, "");
}

function isMeta(activityId: string): boolean {
  const id = normalizeActivityId(activityId);
  return (
    META_ACTIVITY_IDS.has(id) ||
    DETERMINISTIC_WRAPPER_RE.test(id) ||
    id.startsWith("gap-closing:") ||
    id.startsWith(SUBSTRATE_MACHINERY_PREFIX)
  );
}

function isSuccess(t: TraceRow): boolean {
  return t.success === true || t.status === "success" || t.status === "completed";
}

function buildCluster(args: {
  patternId: string;
  signature: string[];
  recurrence: number;
  producingActivities: string[];
  exampleTraceIds: string[];
  nContrast: number;
  contrastTraceIds: string[];
  windowStart: string;
  windowEnd: string;
}): Record<string, unknown> {
  const {
    patternId,
    signature,
    recurrence,
    producingActivities,
    exampleTraceIds,
    nContrast,
    contrastTraceIds,
    windowStart,
    windowEnd,
  } = args;
  const shapeList = signature.join(", ");
  return {
    pattern_id: patternId,
    summary:
      `The substrate has successfully produced the output-shape combination [${shapeList}] ` +
      `${recurrence} times in the observation window via these EXISTING activities: ${producingActivities.join(", ")}. ` +
      `Capture this recurrent topology as a reusable composite by COMPOSING those existing activities — ` +
      `author a chain whose tasks set "resolver" to one of the existing activity ids listed above ` +
      `(activities-as-resolvers), so executing it dispatches them and forms genuine composition edges. ` +
      `Do NOT re-implement their work with leaf resolvers, and do NOT author a meta-activity. ` +
      `Reuse the existing producers; only mint new leaf work for a shape that has no producer.`,
    observation_window: `${windowStart}/${windowEnd}`,
    n_observations: recurrence,
    n_contrast_examples: nContrast,
    // The recurrent topology the author must reproduce as a clean chain.
    expected_outputs: signature,
    example_trace_ids: exampleTraceIds,
    contrast_trace_ids: contrastTraceIds,
    producing_activities: producingActivities,
    topology_hint:
      `COMPOSE the existing producers via activities-as-resolvers. For each composing task, set the ` +
      `task's "resolver" field to the EXACT activity id string of one of these existing activities: ` +
      `[${producingActivities.join(", ")}] — e.g. {"id":"t1","resolver":"${producingActivities[0] ?? "<existing-activity-id>"}","outputShapes":[...]}. ` +
      `The engine reads the "resolver" VALUE ITSELF as the activity to dispatch (getTemplate(task.resolver) ` +
      `→ dispatchCompose), forming one genuine composition edge per task. Do NOT set resolver to the word ` +
      `"activity" and do NOT put the activity id in config — the id MUST be the resolver value. Chain them ` +
      `so the LAST task emits one of [${shapeList}]. ONLY fall back to a leaf resolver (http_fetch, ` +
      `json_path_extract, fs_write, concept_create_write) for a needed shape that has NO existing producer. ` +
      `Use the {{<task>_json}} form to thread a prior task's output into the next. Do NOT author a ` +
      `read_scenario → analyse → write-a-Proposal scaffold; emit no *Proposal output.`,
    deny_list: ["fs_read of a scenario file", "activityTemplateProposal", "patch_proposal", "read_scenario"],
    bridge_source: "trace_recurring_pattern_scan",
  };
}

async function dispatchAuthor(
  goalHost: string,
  apiKey: string,
  patternId: string,
  patternsDir: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${goalHost.replace(/\/+$/, "")}/run-goal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` },
      body: JSON.stringify({
        goal: `author an activity from recurring trace pattern ${patternId}`,
        targetTemplateId: DRAFTER_TEMPLATE_ID,
        variables: { pattern_id: patternId, patterns_dir: patternsDir, source: "trace_recurring_pattern_scan" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { ok: res.ok, detail: text.slice(0, 200) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message.slice(0, 120) : "dispatch error" };
  }
}

export async function resolveTraceRecurringPatternScan(
  pointer: TraceRecurringPatternScanPointer,
): Promise<ResolverResult> {
  const metabob = pointer.metabobEndpoint ?? METABOB_ENDPOINT;
  const apiKey = pointer.apiKey ?? METABOB_API_KEY;
  const goalHost = pointer.goalHostEndpoint ?? DEFAULT_GOAL_HOST;
  const patternsDir = pointer.patternsDir ?? DEFAULT_PATTERNS_DIR;
  const lookbackHours = pointer.lookbackHours ?? 24;
  const minRecurrence = pointer.minRecurrence ?? 3;
  const fetchLimit = pointer.limit ?? 2000;
  const timeoutMs = pointer.timeoutMs ?? 8000;
  const windowEnd = new Date().toISOString();
  const windowStart = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();

  if (!apiKey) {
    return { shape: "recurringPatternCluster", body: { has_pattern: false, error: "missing_api_key", generated_at: windowEnd } };
  }

  const PAGE_SIZE = 100;
  const traces: TraceRow[] = [];
  let offset = 0;
  const authHeaders = { Authorization: `ApiKey ${apiKey}` };
  const windowStartMs = new Date(windowStart).getTime();
  try {
    while (traces.length < fetchLimit) {
      const res = await fetch(
        `${metabob.replace(/\/+$/, "")}/v2/activities/execution-traces?limit=${PAGE_SIZE}&offset=${offset}&order=desc`,
        { headers: authHeaders, signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!res.ok) {
        return { shape: "recurringPatternCluster", body: { has_pattern: false, error: `traces fetch ${res.status}`, generated_at: windowEnd } };
      }
      const json = (await res.json()) as { traces?: TraceRow[]; executions?: TraceRow[] } | TraceRow[];
      const page: TraceRow[] = Array.isArray(json) ? json : (json.traces ?? json.executions ?? []);
      let exhausted = false;
      for (const trace of page) {
        if (traces.length >= fetchLimit) break;
        const startedAt = (trace as TraceRow & { started_at?: string }).started_at;
        if (startedAt && new Date(startedAt).getTime() < windowStartMs) { exhausted = true; break; }
        traces.push(trace);
      }
      if (exhausted || page.length < PAGE_SIZE || traces.length >= fetchLimit) break;
      offset += PAGE_SIZE;
    }
  } catch (err) {
    return { shape: "recurringPatternCluster", body: { has_pattern: false, error: err instanceof Error ? err.message.slice(0, 120) : "fetch error", generated_at: windowEnd } };
  }

  // Group SUCCESS traces by output-shape signature, excluding meta/deterministic.
  const groups = new Map<string, { exec_ids: string[]; activities: Set<string> }>();
  for (const t of traces) {
    if (!isSuccess(t)) continue;
    const actId = normalizeActivityId(t.activity_id ?? t.variant_id ?? "");
    if (!actId || isMeta(actId)) continue;
    const shapes = (t.output_impulse_shapes ?? []).filter(Boolean);
    if (shapes.length === 0) continue;
    const sig = [...shapes].sort().join("+");
    const execId = t.execution_id ?? t.id ?? "";
    let g = groups.get(sig);
    if (!g) {
      g = { exec_ids: [], activities: new Set() };
      groups.set(sig, g);
    }
    if (execId) g.exec_ids.push(execId);
    g.activities.add(actId);
  }

  // Top recurrent signature meeting the threshold.
  let best: { sig: string; exec_ids: string[]; activities: string[] } | null = null;
  for (const [sig, g] of groups) {
    if (g.exec_ids.length < minRecurrence) continue;
    if (!best || g.exec_ids.length > best.exec_ids.length) {
      best = { sig, exec_ids: g.exec_ids, activities: [...g.activities] };
    }
  }

  if (!best) {
    return {
      shape: "recurringPatternCluster",
      body: { has_pattern: false, scanned: traces.length, candidate_signatures: groups.size, min_recurrence: minRecurrence, generated_at: windowEnd },
    };
  }

  // Contrast: failures produced by the same activities in-window.
  const activitySet = new Set(best.activities);
  const contrastIds: string[] = [];
  for (const t of traces) {
    if (isSuccess(t)) continue;
    const actId = normalizeActivityId(t.activity_id ?? t.variant_id ?? "");
    if (activitySet.has(actId)) {
      const execId = t.execution_id ?? t.id ?? "";
      if (execId) contrastIds.push(execId);
    }
  }

  const signature = best.sig.split("+");
  const patternId = `trace-pattern-${stableHash(best.sig)}`;
  const cluster = buildCluster({
    patternId,
    signature,
    recurrence: best.exec_ids.length,
    producingActivities: best.activities,
    exampleTraceIds: best.exec_ids.slice(0, 5),
    nContrast: contrastIds.length,
    contrastTraceIds: contrastIds.slice(0, 3),
    windowStart,
    windowEnd,
  });

  let clusterPath = "";
  let writeError: string | null = null;
  try {
    await fs.mkdir(patternsDir, { recursive: true });
    clusterPath = path.join(patternsDir, `${patternId}.json`);
    await fs.writeFile(clusterPath, JSON.stringify(cluster, null, 2), "utf8");
  } catch (err) {
    writeError = err instanceof Error ? err.message.slice(0, 120) : "write error";
  }

  let dispatched: { ok: boolean; detail: string } | null = null;
  if (pointer.dispatch && !writeError) {
    dispatched = await dispatchAuthor(goalHost, apiKey, patternId, patternsDir, timeoutMs);
  }

  return {
    shape: "recurringPatternCluster",
    body: {
      has_pattern: true,
      pattern_id: patternId,
      signature,
      recurrence: best.exec_ids.length,
      producing_activities: best.activities,
      n_contrast_examples: contrastIds.length,
      cluster_path: clusterPath || null,
      scanned: traces.length,
      generated_at: windowEnd,
      ...(writeError ? { write_error: writeError } : {}),
      ...(dispatched ? { dispatched_to_author: dispatched.ok, dispatch_detail: dispatched.detail } : {}),
    },
  };
}
