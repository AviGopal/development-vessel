import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

/**
 * phantom_trace_scan — deterministic phantom-success-trace detector + emitter.
 *
 * A phantom-success trace is an execution row with status="success" AND
 * task_count=0 (or empty tasks[]). The substrate accumulates these when
 * pre-flight rejection at the engine level marks the trace successful even
 * though no task body ran. Validator-dispatch is the dominant producer
 * (9367+ phantoms observed 2026-05-30); they pollute Thompson posteriors
 * because the trace-write path credits success without a real positive
 * signal.
 *
 * Why one resolver does the whole flow (mirrors stale_pointer_emit):
 *   - the prior 5-task design would itself be vulnerable to the F25 abort
 *     pattern (multi-task template + downstream LLM-shaped resolver dispatch
 *     ⇒ engine aborts after task 1)
 *   - filter+emit are trivially deterministic; iteration adds no value
 *   - one server-side step has one trace, with a real task body
 *
 * Flow:
 *   1. GET {METABOB_ENDPOINT}/v2/activities/execution-traces?limit=N
 *   2. For each row where status==="success" AND (task_count===0 OR
 *      tasks.length===0), build a substrateGap_write body.
 *   3. POST gaps to dev-vessel /v2/impulses/resolve (idempotent by gap_id).
 *   4. Return phantomTraceReport summary.
 *
 * Constitutional principle: every bug class we observe is an opportunity
 * to author a detection template, not just patch the instance. The
 * underlying validator-dispatch task_count=0 bug is NOT fixed here; this
 * resolver makes the bug-class observable so future analysis activities
 * can act on it.
 *
 * See: concept_9ldsmRgqSTd5 (substrate_self_detection_principle),
 *      concept_qcctOLBT5-CL (F25 phantom-success pattern).
 */

export interface PhantomTraceScanPointer {
  type: "phantom_trace_scan";
  /** Override traces URL. Default: METABOB_ENDPOINT/v2/activities/execution-traces */
  tracesUrl?: string;
  /** Override dev-vessel impulses URL. Default: http://127.0.0.1:8090/v2/impulses/resolve */
  devVesselImpulsesUrl?: string;
  /** Page size for the trace fetch. Default 200, max 500. */
  limit?: number;
  /** dry_run = true: scan + report but do not POST gaps. */
  dry_run?: boolean;
  /** Cap on emitted gaps per invocation. Default 50. */
  maxEmits?: number;
}

const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_EMITS = 50;
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

interface TraceRow {
  id?: unknown;
  execution_id?: unknown;
  status?: unknown;
  task_count?: unknown;
  tasks?: unknown;
  activity_template_id?: unknown;
  activity_id?: unknown;
  duration_ms?: unknown;
  created_at?: unknown;
  failure_mode?: unknown;
}

interface PhantomEntry {
  exec_id: string;
  template_id: string;
  duration_ms: number | null;
  status: string;
  task_count: number;
  gap_id: string;
  posted: boolean;
  post_status?: number | "error";
  post_error?: string;
}

function extractExecId(t: TraceRow): string | null {
  if (typeof t.execution_id === "string" && t.execution_id.length > 0) return t.execution_id;
  if (typeof t.id === "string" && t.id.length > 0) return t.id;
  // Some surreal record refs render as ⟨table:hash⟩ — accept those too.
  if (t.id != null) return String(t.id);
  return null;
}

function extractTemplateId(t: TraceRow): string {
  if (typeof t.activity_template_id === "string" && t.activity_template_id.length > 0) {
    return t.activity_template_id;
  }
  if (typeof t.activity_id === "string" && t.activity_id.length > 0) {
    return t.activity_id;
  }
  return "unknown";
}

function isPhantom(t: TraceRow): { phantom: boolean; taskCount: number } {
  const status = typeof t.status === "string" ? t.status : "";
  if (status !== "success" && status !== "completed") {
    return { phantom: false, taskCount: -1 };
  }
  // Prefer explicit task_count when present.
  let taskCount = -1;
  if (typeof t.task_count === "number") {
    taskCount = t.task_count;
  } else if (Array.isArray(t.tasks)) {
    taskCount = t.tasks.length;
  } else if (t.tasks == null) {
    taskCount = 0;
  }
  return { phantom: taskCount === 0, taskCount };
}

export async function resolvePhantomTraceScan(
  pointer: PhantomTraceScanPointer,
): Promise<ResolverResult> {
  const limit = Math.min(Math.max(pointer.limit ?? DEFAULT_LIMIT, 1), 500);
  const tracesUrl =
    pointer.tracesUrl ?? `${METABOB_ENDPOINT}/v2/activities/execution-traces?limit=${limit}`;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const dryRun = pointer.dry_run === true;
  const maxEmits = pointer.maxEmits ?? DEFAULT_MAX_EMITS;

  const authHeader: Record<string, string> = METABOB_API_KEY
    ? { Authorization: `ApiKey ${METABOB_API_KEY}` }
    : {};

  // 1. Fetch traces.
  let traces: TraceRow[] = [];
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
          resolver: "phantom_trace_scan",
          detail: `activity-api traces returned ${resp.status}`,
        },
      };
    }
    const json = (await resp.json()) as {
      traces?: unknown;
      executions?: unknown;
    };
    if (Array.isArray(json.traces)) {
      traces = json.traces as TraceRow[];
    } else if (Array.isArray(json.executions)) {
      traces = json.executions as TraceRow[];
    }
    scanned = traces.length;
  } catch (err) {
    return {
      shape: "structuredError",
      body: {
        resolver: "phantom_trace_scan",
        detail: `activity-api fetch failed: ${(err as Error).message}`,
      },
    };
  }

  // 2. Filter phantoms.
  const phantoms: PhantomEntry[] = [];
  let successCount = 0;
  for (const t of traces) {
    const { phantom, taskCount } = isPhantom(t);
    const status = typeof t.status === "string" ? t.status : "";
    if (status === "success" || status === "completed") successCount += 1;
    if (!phantom) continue;
    const execId = extractExecId(t);
    if (execId === null) continue;
    const templateId = extractTemplateId(t);
    const durationMs = typeof t.duration_ms === "number" ? t.duration_ms : null;
    phantoms.push({
      exec_id: execId,
      template_id: templateId,
      duration_ms: durationMs,
      status,
      task_count: taskCount,
      gap_id: `phantom-success-${execId}`,
      posted: false,
    });
    if (phantoms.length >= maxEmits) break;
  }

  // 3. Emit gaps (unless dry_run).
  if (!dryRun) {
    for (const entry of phantoms) {
      const body = {
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: entry.gap_id,
              category: "trace_quality",
              source: "substrate_detected",
              summary:
                `Phantom-success trace ${entry.exec_id}: status=${entry.status} ` +
                `but task_count=${entry.task_count} (template=${entry.template_id}, ` +
                `duration_ms=${entry.duration_ms ?? "null"}). ` +
                `Engine pre-flight rejection credits success without a real task body, ` +
                `polluting Thompson posteriors.`,
              detected_at: new Date().toISOString(),
              status: "open",
              fix_priors: ["concept_qcctOLBT5-CL"],
              classification_metadata: {
                gap_subtype: "phantom_success_trace",
                gap_class: "phantom_success_trace",
                exec_id: entry.exec_id,
                template_id: entry.template_id,
                duration_ms: entry.duration_ms,
                trace_status: entry.status,
                task_count: entry.task_count,
                detection_principle: "concept_9ldsmRgqSTd5",
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
    shape: "phantomTraceReport",
    body: {
      scanned,
      success_traces: successCount,
      phantoms_detected: phantoms.length,
      phantoms_posted: phantoms.filter((p) => p.posted).length,
      dry_run: dryRun,
      phantom_entries: phantoms,
      completed_at: new Date().toISOString(),
    },
  };
}
