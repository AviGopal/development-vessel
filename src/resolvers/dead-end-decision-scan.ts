/**
 * dead_end_decision_scan — the deterministic detector for the
 * decision-without-action defect class: a task PRODUCES a decision /
 * recommendation / selection impulse that NO downstream task in the same
 * trajectory CONSUMES. The canonical instance the operator found by hand is
 * slot-binding's `select_or_produce` (resolver `iteration`): it computes a
 * producer_selection impulse and emits it, but no later task takes that
 * impulse as input and actually dispatches the producer — the decision is
 * computed and discarded, so the work the decision was supposed to drive
 * never happens.
 *
 * This is intra-trajectory and purely structural: per `execution_trace_content`
 * row, for each task T at index i that produces output impulse ids, where a
 * later task exists (T is non-terminal), deadIds = T.output_impulse_ids minus
 * the union of input_impulse_ids of all tasks after T. T is an ACTIONABLE
 * DECISION when it is the kind of task whose output is meant to drive a
 * downstream action (resolver_id ∈ {iteration, activity_recommendation} OR a
 * select/recommend/rank/choose/forward_chain/producer/plan/propose/candidate
 * task_id) and it is NOT a terminal/observer (report/audit/write/sentinel/…).
 * When the ENTIRE produced set is dead, that's a decision-without-action
 * occurrence.
 *
 * Impulse ids carry no shape and there is no id→shape map, so the taxonomy is
 * keyed on (activity_id, task_id, resolver_id) — NOT on shape. Per-task
 * activity attribution is not available in execution_trace_content (activity_id
 * is uniformly NONE there), so the activity dimension degrades to "unknown"
 * and the task_id is the discriminating key — still stable and meaningful.
 *
 * Emits a `decision_without_action` substrateGap per systematic (activity_id,
 * task_id) class — only when total_occurrences ≥ min_occurrences AND
 * dead_end_fraction ≥ dead_end_threshold (systematic, not noise). The gap id
 * is STABLE (no timestamp) so it upserts. Same constitutional principle as the
 * other scan detectors (concept_9ldsmRgqSTd5): a measured defect class is an
 * opportunity to fix the loop, routed to the fix-drafter. This class is
 * recombination-fixable (add/modify a downstream task consuming the decision),
 * so it routes to draft-gap-closing-activity, NOT vessel-authoring.
 *
 * Reads execution_trace_content directly via SurrealDB /sql — the public
 * /v2/activities/execution-traces list does NOT return tasks[]. Deterministic;
 * no LLM.
 */

import type { ResolverResult } from "./types.js";

const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_SURREAL_URL = "http://127.0.0.1:8000";

/** Task_ids/resolver_ids whose output is meant to drive a downstream action. */
const ACTIONABLE_RESOLVERS = new Set<string>(["iteration", "activity_recommendation"]);
const ACTIONABLE_TASK_RE = /select|recommend|rank|choose|forward_chain|producer|plan|propose|candidate/i;
/** Terminal/observer tasks — their output is the report itself, not a decision
 *  meant to feed a later task. Excluded so we don't flag sinks. */
const TERMINAL_RE = /report|audit|health|write|sentinel|metric|snapshot|observ/i;

export interface DeadEndDecisionScanPointer {
  type: "dead_end_decision_scan";
  window_hours?: number;
  trace_limit?: number;
  /** Only emit a gap for a (activity_id, task_id) class seen at least this
   *  many times in the window (so it is systematic, not noise). */
  min_occurrences?: number;
  /** dead_end_fraction at or above this ⇒ decision-without-action candidate. */
  dead_end_threshold?: number;
  emit_gap?: boolean;
  metabobEndpoint?: string;
  devVesselImpulsesUrl?: string;
}

interface TaskRow {
  task_id?: string;
  resolver_id?: string;
  status?: string;
  success?: boolean;
  input_impulse_ids?: string[];
  output_impulse_ids?: string[];
}

interface ContentRow {
  execution_id?: string;
  activity_id?: string | null;
  tasks?: TaskRow[];
}

interface DeadEndClass {
  activity_id: string;
  task_id: string;
  resolver_id: string;
  total_occurrences: number; // times this (activity,task) appeared as actionable+non-terminal+produced output
  dead_end_occurrences: number; // of those, times the entire output was unconsumed
  examples: string[];
}

function normId(activityId: string | null | undefined): string {
  if (!activityId) return "unknown";
  let id = String(activityId).replace(/^activity:[⟨<]/, "").replace(/[⟩>]$/, "");
  id = id.replace(/-\d{6,}.*$/, "").replace(/-v\d+$/, "");
  return id || "unknown";
}

function basicAuthHeader(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

function isActionableDecision(t: TaskRow): boolean {
  const res = (t.resolver_id ?? "").toLowerCase();
  const task = t.task_id ?? "";
  if (ACTIONABLE_RESOLVERS.has(res)) return true;
  return ACTIONABLE_TASK_RE.test(task);
}

function isTerminalOrObserver(t: TaskRow): boolean {
  return TERMINAL_RE.test(t.resolver_id ?? "") || TERMINAL_RE.test(t.task_id ?? "");
}

/** Fetch execution_trace_content rows with >1 task in the window, via /sql.
 *  Fail-tolerant: returns [] on any error. */
async function fetchContentRows(
  surrealUrl: string,
  windowHours: number,
  traceLimit: number,
): Promise<ContentRow[]> {
  const ns = process.env["SURREALDB_NAMESPACE"] ?? "activity-system";
  const db = process.env["SURREALDB_DATABASE"] ?? "learning_loop";
  const user = process.env["SURREALDB_USERNAME"] ?? "root";
  const pass = process.env["SURREALDB_PASSWORD"] ?? process.env["SURREAL_PASS"] ?? "";
  if (!pass) return [];
  const windowSecs = Math.round(windowHours * 3600);
  const query =
    `SELECT execution_id, activity_id, tasks FROM execution_trace_content ` +
    `WHERE array::len(tasks ?? []) > 1 ` +
    `AND created_at > type::datetime(time::now() - ${windowSecs}s) ` +
    `LIMIT ${Math.max(1, Math.floor(traceLimit))};`;
  try {
    const res = await fetch(`${surrealUrl}/sql`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Accept": "application/json",
        "surreal-ns": ns,
        "surreal-db": db,
        "Authorization": basicAuthHeader(user, pass),
      },
      body: query,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as Array<{ status?: string; result?: ContentRow[] }>;
    const last = Array.isArray(j) ? j[j.length - 1] : undefined;
    return Array.isArray(last?.result) ? (last!.result as ContentRow[]) : [];
  } catch {
    return [];
  }
}

async function emitDecisionWithoutAction(
  emitUrl: string,
  apiKey: string,
  c: DeadEndClass,
  fraction: number,
): Promise<boolean> {
  const gapId =
    `decision-without-action-${normId(c.activity_id).replace(/[^a-zA-Z0-9]+/g, "_")}-${(c.task_id || "unknown").replace(/[^a-zA-Z0-9]+/g, "_")}`;
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: gapId,
          category: "decision_without_action",
          source: "substrate_detected",
          summary:
            `Decision task '${c.task_id}' (resolver ${c.resolver_id}) in ${c.activity_id} produced a ` +
            `decision/selection impulse that NO downstream task consumed in ${(fraction * 100).toFixed(0)}% ` +
            `of ${c.total_occurrences} occurrences — the decision is computed and discarded; the action it ` +
            `should drive never happens.`,
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            detector: "dead_end_decision_scan",
            gap_class: "decision_without_action",
            cited_concept_ids: ["concept_9ldsmRgqSTd5"],
            activity_id: c.activity_id,
            decision_task_id: c.task_id,
            decision_resolver_id: c.resolver_id,
            total_occurrences: c.total_occurrences,
            dead_end_fraction: fraction,
            example_execution_ids: c.examples.slice(0, 5),
            suggested_remediation:
              "Add/modify a downstream task whose input_impulse_ids include this task's output so the decision is acted on.",
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const r = await fetch(emitUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function resolveDeadEndDecisionScan(
  pointer: DeadEndDecisionScanPointer,
): Promise<ResolverResult> {
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const surrealUrl = (process.env["SURREALDB_URL"] ?? DEFAULT_SURREAL_URL).replace(/\/+$/, "");
  const windowHours = pointer.window_hours ?? 24;
  const traceLimit = pointer.trace_limit ?? 500;
  const minOccurrences = pointer.min_occurrences ?? 10;
  const deadEndThreshold = pointer.dead_end_threshold ?? 0.9;
  const emit = pointer.emit_gap === true;
  const apiKey = process.env["METABOB_API_KEY"] ?? "";

  const rows = await fetchContentRows(surrealUrl, windowHours, traceLimit);

  // Aggregate by (activity_id, task_id). resolver_id is carried for reporting.
  const classes = new Map<string, DeadEndClass>();
  let decisionTasksExamined = 0;

  for (const row of rows) {
    const tasks = Array.isArray(row.tasks) ? row.tasks : [];
    const n = tasks.length;
    if (n < 2) continue;
    const activity = normId(row.activity_id);

    // Precompute the union of input_impulse_ids for all tasks strictly after i.
    // Built suffix-wise so we don't re-scan for each i.
    const laterInputs: Set<string>[] = new Array(n);
    let acc = new Set<string>();
    for (let i = n - 1; i >= 0; i--) {
      // laterInputs[i] = union of inputs of tasks j > i
      laterInputs[i] = new Set(acc);
      for (const id of tasks[i]!.input_impulse_ids ?? []) acc.add(id);
    }

    for (let i = 0; i < n; i++) {
      const t = tasks[i]!;
      const produced = (t.output_impulse_ids ?? []).filter((x) => !!x);
      if (produced.length === 0) continue; // no output → nothing to be a dead end
      if (i === n - 1) continue; // terminal by position → output legitimately may sink
      if (!isActionableDecision(t)) continue;
      if (isTerminalOrObserver(t)) continue; // terminal/observer by role

      decisionTasksExamined += 1;
      const later = laterInputs[i]!;
      const dead = produced.filter((id) => !later.has(id));
      const entireOutputDead = dead.length === produced.length;

      const taskId = t.task_id ?? "unknown";
      const resolverId = t.resolver_id ?? "unknown";
      const key = `${activity} ${taskId}`;
      let cls = classes.get(key);
      if (!cls) {
        cls = {
          activity_id: activity,
          task_id: taskId,
          resolver_id: resolverId,
          total_occurrences: 0,
          dead_end_occurrences: 0,
          examples: [],
        };
        classes.set(key, cls);
      }
      cls.total_occurrences += 1;
      if (entireOutputDead) {
        cls.dead_end_occurrences += 1;
        if (row.execution_id && cls.examples.length < 5) cls.examples.push(row.execution_id);
      }
    }
  }

  const allClasses = Array.from(classes.values())
    .map((c) => ({ ...c, fraction: c.dead_end_occurrences / Math.max(1, c.total_occurrences) }))
    .sort((a, b) => b.dead_end_occurrences - a.dead_end_occurrences);

  const systematic = allClasses.filter(
    (c) => c.total_occurrences >= minOccurrences && c.fraction >= deadEndThreshold,
  );

  let gaps_emitted = 0;
  if (emit) {
    for (const c of systematic) {
      if (await emitDecisionWithoutAction(emitUrl, apiKey, c, c.fraction)) gaps_emitted += 1;
    }
  }

  return {
    shape: "deadEndDecisionReport",
    body: {
      window_hours: windowHours,
      traces_examined: rows.length,
      decision_tasks_examined: decisionTasksExamined,
      dead_end_task_classes: systematic.length,
      gaps_emitted,
      top_dead_ends: allClasses.slice(0, 10).map((c) => ({
        activity_id: c.activity_id,
        task_id: c.task_id,
        resolver_id: c.resolver_id,
        total_occurrences: c.total_occurrences,
        dead_end_fraction: Number(c.fraction.toFixed(3)),
      })),
      completed_at: new Date().toISOString(),
    },
  };
}
