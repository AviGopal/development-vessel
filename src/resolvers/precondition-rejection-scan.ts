import type { ResolverResult } from "./types.js";

/**
 * precondition_rejection_scan — deterministic detector + emitter for
 * execution traces that fail at engine pre-flight.
 *
 * The pattern (F25, concept_qcctOLBT5-CL): the recommend handler returns a
 * template whose declared inputShapes aren't satisfiable from the pool, and
 * the engine rejects the dispatch before any task runs. Trace signature is
 * unmistakable: status="failure", duration_ms < ~500ms, task_count === 0.
 * The D2 demo confirmed drain-pending-substrate-gaps fails this way on every
 * dispatch — the autonomous-loop gap-consumer is structurally broken by
 * exactly this class.
 *
 * Why one resolver does the whole flow (mirroring stale_pointer_emit):
 *   1. iteration has no conditional-execution mode, so a chained iterate→post
 *      template would emit per-trace rather than per-affected-template.
 *   2. Grouping is the load-bearing operation. A template can have many
 *      failing instances; we want one gap per template_id with
 *      instance_count, not 270 duplicate gaps.
 *   3. Single-resolver = single-task template = no inputShapes to declare,
 *      so the detector itself can't pre-flight-reject (the meta-irony from
 *      D2 — the detector for pre-flight rejection MUST not pre-flight).
 *
 * Spec: this resolver's seed template wraps it in a single task; no LLM call,
 * no iteration over the pool, no variables to seed.
 */

export interface PreconditionRejectionScanPointer {
  type: "precondition_rejection_scan";
  /** Override activity-api traces URL. */
  tracesUrl?: string;
  /** Override dev-vessel impulses URL. */
  devVesselImpulsesUrl?: string;
  /** dry_run = true: scan + report but do not POST gaps. */
  dry_run?: boolean;
  /** Cap on emitted gaps per invocation (= unique affected templates). */
  maxEmits?: number;
  /**
   * Maximum trace duration in ms to qualify as a pre-flight rejection.
   * Default 500 — D2 observed 33-270ms for drain-pending-substrate-gaps.
   */
  durationThresholdMs?: number;
  /** Trace fetch limit. Default 200. */
  fetchLimit?: number;
}

const DEFAULT_TRACES_URL = "http://127.0.0.1:8080/v2/activities/execution-traces";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_MAX_EMITS = 50;
const DEFAULT_DURATION_THRESHOLD_MS = 500;
const DEFAULT_FETCH_LIMIT = 200;

interface TraceLike {
  execution_id?: unknown;
  id?: unknown;
  status?: unknown;
  success?: unknown;
  duration_ms?: unknown;
  task_count?: unknown;
  tasks?: unknown;
  activity_id?: unknown;
  variant_id?: unknown;
  metadata?: unknown;
}

interface AffectedTemplate {
  template_id: string;
  instance_count: number;
  sample_exec_ids: string[];
  min_duration_ms: number;
  max_duration_ms: number;
  gap_id: string;
  posted: boolean;
  post_status?: number | "error";
  post_error?: string;
}

function templateIdOf(t: TraceLike): string {
  // Prefer metadata.template_id (the dispatched template id), then variant_id, then activity_id.
  const meta = t.metadata as { template_id?: unknown } | undefined;
  if (meta && typeof meta.template_id === "string" && meta.template_id.length > 0) {
    return meta.template_id;
  }
  if (typeof t.variant_id === "string" && t.variant_id.length > 0) return t.variant_id;
  if (typeof t.activity_id === "string" && t.activity_id.length > 0) return t.activity_id;
  return "unknown_template";
}

function execIdOf(t: TraceLike): string {
  if (typeof t.execution_id === "string" && t.execution_id.length > 0) return t.execution_id;
  if (typeof t.id === "string") return t.id;
  return "unknown";
}

function isFailure(t: TraceLike): boolean {
  if (t.status === "failure") return true;
  if (t.success === false) return true;
  return false;
}

function taskCountOf(t: TraceLike): number {
  if (typeof t.task_count === "number") return t.task_count;
  if (Array.isArray(t.tasks)) return (t.tasks as unknown[]).length;
  return -1; // unknown — treat as not matching (we require known-zero)
}

export async function resolvePreconditionRejectionScan(
  pointer: PreconditionRejectionScanPointer,
): Promise<ResolverResult> {
  const fetchLimit = pointer.fetchLimit ?? DEFAULT_FETCH_LIMIT;
  const tracesUrl =
    (pointer.tracesUrl ?? DEFAULT_TRACES_URL) + `?limit=${fetchLimit}`;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const dryRun = pointer.dry_run === true;
  const maxEmits = pointer.maxEmits ?? DEFAULT_MAX_EMITS;
  const durationThreshold = pointer.durationThresholdMs ?? DEFAULT_DURATION_THRESHOLD_MS;

  const apiKey = process.env["METABOB_API_KEY"];
  const authHeader: Record<string, string> = apiKey
    ? { Authorization: `ApiKey ${apiKey}` }
    : {};

  // 1. Fetch recent traces.
  let traces: TraceLike[] = [];
  let scanned = 0;
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
          resolver: "precondition_rejection_scan",
          detail: `activity-api traces returned ${resp.status}`,
        },
      };
    }
    const json = (await resp.json()) as { executions?: unknown };
    if (Array.isArray(json.executions)) {
      traces = json.executions as TraceLike[];
    }
    scanned = traces.length;
  } catch (err) {
    return {
      shape: "structuredError",
      body: {
        resolver: "precondition_rejection_scan",
        detail: `traces fetch failed: ${(err as Error).message}`,
      },
    };
  }

  // 2. Filter for pre-flight rejection signature: failure + short + zero tasks.
  // Group by template_id.
  const grouped = new Map<
    string,
    { exec_ids: string[]; durations: number[] }
  >();
  let rejectionsTotal = 0;
  for (const t of traces) {
    if (!isFailure(t)) continue;
    const dur = typeof t.duration_ms === "number" ? t.duration_ms : -1;
    if (dur < 0 || dur >= durationThreshold) continue;
    const taskCount = taskCountOf(t);
    if (taskCount !== 0) continue;
    // Pre-flight rejection match.
    rejectionsTotal += 1;
    const tid = templateIdOf(t);
    const entry = grouped.get(tid) ?? { exec_ids: [], durations: [] };
    if (entry.exec_ids.length < 3) entry.exec_ids.push(execIdOf(t));
    entry.durations.push(dur);
    grouped.set(tid, entry);
  }

  // 3. Materialize affected-template summaries.
  const today = new Date().toISOString().slice(0, 10);
  const affected: AffectedTemplate[] = [];
  for (const [tid, agg] of grouped.entries()) {
    if (affected.length >= maxEmits) break;
    const min = Math.min(...agg.durations);
    const max = Math.max(...agg.durations);
    affected.push({
      template_id: tid,
      instance_count: agg.durations.length,
      sample_exec_ids: agg.exec_ids,
      min_duration_ms: min,
      max_duration_ms: max,
      gap_id: `precondition-rejection-${tid}-${today}`,
      posted: false,
    });
  }

  // Sort by instance_count desc so the highest-impact templates get priority
  // under maxEmits.
  affected.sort((a, b) => b.instance_count - a.instance_count);

  // 4. Emit gaps (unless dry_run).
  if (!dryRun) {
    for (const entry of affected) {
      const body = {
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: entry.gap_id,
              category: "missing_concept",
              source: "substrate_detected",
              summary:
                `Template ${entry.template_id} pre-flight-rejected ${entry.instance_count} ` +
                `time(s): duration ${entry.min_duration_ms}-${entry.max_duration_ms}ms, ` +
                `tasks_completed=0. Likely cause: unsatisfiable inputShapes (F25).`,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: {
                gap_subtype: "precondition_rejection_pattern",
                template_id: entry.template_id,
                instance_count: entry.instance_count,
                sample_exec_ids: entry.sample_exec_ids,
                min_duration_ms: entry.min_duration_ms,
                max_duration_ms: entry.max_duration_ms,
                detection_threshold_ms: durationThreshold,
                fix_priors: ["concept_qcctOLBT5-CL"],
              },
            },
          },
        },
      };
      try {
        const resp = await fetch(emitUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeader,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        entry.post_status = resp.status;
        entry.posted = resp.ok;
        if (!resp.ok) {
          entry.post_error = (await resp.text()).slice(0, 200);
        }
      } catch (err) {
        entry.post_status = "error";
        entry.post_error = (err as Error).message;
      }
    }
  }

  return {
    shape: "preconditionRejectionReport",
    body: {
      scanned,
      rejections_total: rejectionsTotal,
      affected_template_count: affected.length,
      affected_templates: affected,
      duration_threshold_ms: durationThreshold,
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}
