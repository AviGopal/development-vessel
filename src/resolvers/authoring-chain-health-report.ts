import type { ResolverResult } from "./types.js";

/**
 * authoring_chain_health_report — classifies recent trace failures
 * affecting the substrate's authoring chain.
 *
 * Both substrate authoring paths can fail in distinct, distinguishable ways.
 * Without explicit classification, an operator (or a downstream substrate
 * activity) sees a stream of status=failure traces and cannot tell whether
 * authoring is broken structurally (both paths down), at one path
 * (degraded), or working (a draft made it to gh_pr_create).
 *
 * Categories:
 *   - preflight_rejection: status=failure, duration_ms < 500, task_count=0.
 *     Engine rejected dispatch before any task ran (#140, F25, concept_qcctOLBT5-CL).
 *   - chain_truncation: status=failure AND tasks>=2 AND every task success=true
 *     AND failure_mode is null/absent. Tasks ran fine; goal failed because the
 *     declared output shapes weren't produced (fm-51, LLM parse drop).
 *   - authoring_completed: output_impulse_shapes includes git_push, gh_pr_create,
 *     gh_pr_merge, or git_commit. The chain reached publication.
 *   - other_failure: any other status=failure trace.
 *   - success: status=success traces in the window (denominator).
 *
 * Returns counts per category + sample exec_ids + the resulting health verdict
 * (HEALTHY | DEGRADED | BLOCKED) based on whether any path completed.
 *
 * Single-resolver-no-LLM-no-iteration (immunity-pattern, like
 * precondition_rejection_scan and phantom_trace_scan), so the detector itself
 * cannot pre-flight-reject.
 */

export interface AuthoringChainHealthReportPointer {
  type: "authoring_chain_health_report";
  tracesUrl?: string;
  fetchLimit?: number;
  /** ISO timestamp; only traces with executed_at >= since are considered. */
  since?: string;
}

const DEFAULT_TRACES_URL = "http://127.0.0.1:8080/v2/activities/execution-traces";
const DEFAULT_FETCH_LIMIT = 100;
const PREFLIGHT_DURATION_MS_THRESHOLD = 500;

const AUTHORING_OUTPUT_SHAPES = new Set([
  "git_push",
  "gh_pr_create",
  "gh_pr_merge",
  "git_commit",
]);

interface TraceLike {
  execution_id?: unknown;
  id?: unknown;
  status?: unknown;
  duration_ms?: unknown;
  task_count?: unknown;
  tasks?: unknown;
  activity_id?: unknown;
  variant_id?: unknown;
  executed_at?: unknown;
  failure_mode?: unknown;
  output_impulse_shapes?: unknown;
}

interface CategorySummary {
  count: number;
  sample_exec_ids: string[];
  sample_template_ids: string[];
}

interface PerTemplateBreakdown {
  template_id: string;
  preflight_rejection: number;
  chain_truncation: number;
  authoring_completed: number;
  other_failure: number;
  success: number;
}

function execIdOf(t: TraceLike): string {
  if (typeof t.execution_id === "string" && t.execution_id.length > 0) return t.execution_id;
  if (typeof t.id === "string") return t.id;
  return "unknown";
}

function templateIdOf(t: TraceLike): string {
  if (typeof t.variant_id === "string" && t.variant_id.length > 0) return t.variant_id;
  if (typeof t.activity_id === "string" && t.activity_id.length > 0) return t.activity_id;
  return "unknown_template";
}

function taskListOf(t: TraceLike): unknown[] {
  if (Array.isArray(t.tasks)) return t.tasks as unknown[];
  return [];
}

function taskCountOf(t: TraceLike): number {
  if (typeof t.task_count === "number" && t.task_count >= 0) return t.task_count;
  return taskListOf(t).length;
}

function outputShapesOf(t: TraceLike): string[] {
  if (!Array.isArray(t.output_impulse_shapes)) return [];
  return (t.output_impulse_shapes as unknown[]).filter(
    (s): s is string => typeof s === "string",
  );
}

function allTasksSucceeded(tasks: unknown[]): boolean {
  if (tasks.length === 0) return false;
  for (const t of tasks) {
    if (typeof t !== "object" || t === null) return false;
    const success = (t as { success?: unknown }).success;
    if (success !== true) return false;
  }
  return true;
}

type Category =
  | "preflight_rejection"
  | "chain_truncation"
  | "authoring_completed"
  | "other_failure"
  | "success";

function classify(t: TraceLike): Category {
  const status = t.status === "success" ? "success" : t.status === "failure" ? "failure" : null;
  const outputs = outputShapesOf(t);
  const hasAuthoringOutput = outputs.some((s) => AUTHORING_OUTPUT_SHAPES.has(s));

  if (hasAuthoringOutput) return "authoring_completed";

  if (status === "success") return "success";
  if (status !== "failure") return "other_failure";

  const dur = typeof t.duration_ms === "number" ? t.duration_ms : -1;
  const taskCount = taskCountOf(t);

  if (dur >= 0 && dur < PREFLIGHT_DURATION_MS_THRESHOLD && taskCount === 0) {
    return "preflight_rejection";
  }

  const tasks = taskListOf(t);
  const failureMode = t.failure_mode;
  const failureModeAbsent =
    failureMode === null || failureMode === undefined;
  if (tasks.length >= 2 && allTasksSucceeded(tasks) && failureModeAbsent) {
    return "chain_truncation";
  }

  return "other_failure";
}

export async function resolveAuthoringChainHealthReport(
  pointer: AuthoringChainHealthReportPointer,
): Promise<ResolverResult> {
  const fetchLimit = pointer.fetchLimit ?? DEFAULT_FETCH_LIMIT;
  const tracesUrl = (pointer.tracesUrl ?? DEFAULT_TRACES_URL) + `?limit=${fetchLimit}`;
  const since = pointer.since;
  const apiKey = process.env["METABOB_API_KEY"];
  const authHeader: Record<string, string> = apiKey
    ? { Authorization: `ApiKey ${apiKey}` }
    : {};

  let traces: TraceLike[] = [];
  try {
    const resp = await fetch(tracesUrl, {
      method: "GET",
      headers: { ...authHeader },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      return {
        shape: "structuredError",
        body: {
          resolver: "authoring_chain_health_report",
          detail: `activity-api traces returned ${resp.status}`,
        },
      };
    }
    const json = (await resp.json()) as { executions?: unknown };
    if (Array.isArray(json.executions)) {
      traces = json.executions as TraceLike[];
    }
  } catch (err) {
    return {
      shape: "structuredError",
      body: {
        resolver: "authoring_chain_health_report",
        detail: `traces fetch failed: ${(err as Error).message}`,
      },
    };
  }

  if (since) {
    traces = traces.filter((t) => {
      const ts = typeof t.executed_at === "string" ? t.executed_at : "";
      return ts >= since;
    });
  }

  const categories: Record<Category, CategorySummary> = {
    preflight_rejection: { count: 0, sample_exec_ids: [], sample_template_ids: [] },
    chain_truncation: { count: 0, sample_exec_ids: [], sample_template_ids: [] },
    authoring_completed: { count: 0, sample_exec_ids: [], sample_template_ids: [] },
    other_failure: { count: 0, sample_exec_ids: [], sample_template_ids: [] },
    success: { count: 0, sample_exec_ids: [], sample_template_ids: [] },
  };
  const perTemplate = new Map<string, PerTemplateBreakdown>();

  for (const t of traces) {
    const cat = classify(t);
    const eid = execIdOf(t);
    const tid = templateIdOf(t);
    const summary = categories[cat];
    summary.count += 1;
    if (summary.sample_exec_ids.length < 5) summary.sample_exec_ids.push(eid);
    if (!summary.sample_template_ids.includes(tid) && summary.sample_template_ids.length < 5) {
      summary.sample_template_ids.push(tid);
    }
    let row = perTemplate.get(tid);
    if (!row) {
      row = {
        template_id: tid,
        preflight_rejection: 0,
        chain_truncation: 0,
        authoring_completed: 0,
        other_failure: 0,
        success: 0,
      };
      perTemplate.set(tid, row);
    }
    row[cat] += 1;
  }

  const completed = categories.authoring_completed.count;
  const preflight = categories.preflight_rejection.count;
  const truncation = categories.chain_truncation.count;
  const failuresOnAuthoringPaths = preflight + truncation;

  let health: "HEALTHY" | "DEGRADED" | "BLOCKED";
  let verdict_reason: string;
  if (completed > 0 && failuresOnAuthoringPaths === 0) {
    health = "HEALTHY";
    verdict_reason = "authoring chain reaching publication; no preflight/truncation failures in window";
  } else if (completed > 0 && failuresOnAuthoringPaths > 0) {
    health = "DEGRADED";
    verdict_reason = `authoring reaching publication (${completed}) but ${failuresOnAuthoringPaths} preflight/truncation failures observed`;
  } else if (completed === 0 && failuresOnAuthoringPaths > 0) {
    health = "BLOCKED";
    verdict_reason = `zero publications in window; ${preflight} preflight rejections + ${truncation} chain truncations`;
  } else {
    health = "HEALTHY";
    verdict_reason = "no authoring activity in window; no failure pattern observed";
  }

  const blockedTemplates: PerTemplateBreakdown[] = [];
  for (const row of perTemplate.values()) {
    if (
      row.authoring_completed === 0 &&
      (row.preflight_rejection > 0 || row.chain_truncation > 0)
    ) {
      blockedTemplates.push(row);
    }
  }
  blockedTemplates.sort(
    (a, b) =>
      b.preflight_rejection + b.chain_truncation -
      (a.preflight_rejection + a.chain_truncation),
  );

  return {
    shape: "authoringChainHealthReport",
    body: {
      scanned: traces.length,
      window_since: since ?? "(no since filter)",
      categories: {
        preflight_rejection: categories.preflight_rejection,
        chain_truncation: categories.chain_truncation,
        authoring_completed: categories.authoring_completed,
        other_failure: categories.other_failure,
        success: categories.success,
      },
      health_verdict: health,
      verdict_reason,
      blocked_template_count: blockedTemplates.length,
      blocked_templates_top10: blockedTemplates.slice(0, 10),
      completed_at: new Date().toISOString(),
    },
  };
}
