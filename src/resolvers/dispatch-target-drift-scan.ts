import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

/**
 * dispatch_target_drift_scan — detector for dispatch-target-drift.
 *
 * The bug class: a caller invokes `run_goal target_template_id=X` (via MCP,
 * via direct POST to goal-host /run-goal, or via the impulse-resolver
 * goal_execution path). The caller's intent is "execute X exactly". But by
 * the time a trace is written, the only fields on the row are
 * `activity_id` / `variant_id` (the *selected* template). The originally-
 * requested target is nowhere on the trace.
 *
 * What this resolver tries to do, in order:
 *   1. GET {METABOB_ENDPOINT}/v2/activities/execution-traces?limit=N
 *   2. Inspect the schema of the first trace row to determine whether any
 *      target-recording field exists. Candidate field names probed:
 *      `target_template_id`, `dispatch_target_template_id`,
 *      `requested_template_id`. Any present-and-non-null value enables
 *      direct drift detection.
 *   3a. If the field IS present: scan rows where the requested target
 *       differs from the selected `activity_id`/`variant_id`, and emit
 *       one substrateGap per drift with gap_subtype=`dispatch_target_drift`.
 *   3b. If the field is ABSENT on every probed row: emit a SINGLE
 *       high-priority substrateGap with gap_subtype=
 *       `instrumentation_gap_dispatch_target_not_recorded`. The gap states
 *       that to detect dispatch-target-drift, activity-api must record the
 *       requested target_template_id on trace creation. This is itself
 *       a chained gap: a detection of detection-impossibility.
 *
 * Constitutional principle (concept_9ldsmRgqSTd5,
 * substrate_self_detection_principle): every bug class we observe is an
 * opportunity to author a detection template. When the data needed to
 * detect a bug is itself missing, the FIRST detection emitted is the
 * instrumentation gap that blocks the second.
 *
 * Mirrors phantom_trace_scan's idiom: single resolver, no multi-task
 * chain, no LLM, idempotent gap_ids.
 */

export interface DispatchTargetDriftScanPointer {
  type: "dispatch_target_drift_scan";
  /** Override traces URL. Default: METABOB_ENDPOINT/v2/activities/execution-traces */
  tracesUrl?: string;
  /** Override dev-vessel impulses URL. Default: http://127.0.0.1:8090/v2/impulses/resolve */
  devVesselImpulsesUrl?: string;
  /** Page size for the trace fetch. Default 200, max 500. */
  limit?: number;
  /** dry_run = true: scan + report but do not POST gaps. */
  dry_run?: boolean;
  /** Cap on per-drift gap emissions (does not cap the instrumentation gap). */
  maxEmits?: number;
}

const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_EMITS = 50;
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

/** Candidate field names a trace MIGHT use to record the requested target. */
const TARGET_FIELD_CANDIDATES = [
  "target_template_id",
  "dispatch_target_template_id",
  "requested_template_id",
] as const;

interface TraceRow {
  id?: unknown;
  execution_id?: unknown;
  activity_id?: unknown;
  variant_id?: unknown;
  activity_template_id?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

interface DriftEntry {
  exec_id: string;
  requested: string;
  selected: string;
  field_name: string;
  gap_id: string;
  posted: boolean;
  post_status?: number | "error";
  post_error?: string;
}

function extractExecId(t: TraceRow): string | null {
  if (typeof t.execution_id === "string" && t.execution_id.length > 0) return t.execution_id;
  if (typeof t.id === "string" && t.id.length > 0) return t.id;
  if (t.id != null) return String(t.id);
  return null;
}

function extractSelected(t: TraceRow): string {
  if (typeof t.activity_id === "string" && t.activity_id.length > 0) return t.activity_id;
  if (typeof t.variant_id === "string" && t.variant_id.length > 0) return t.variant_id;
  if (typeof t.activity_template_id === "string" && t.activity_template_id.length > 0) {
    return t.activity_template_id;
  }
  return "unknown";
}

/**
 * Read a candidate field from a row, transparently unwrapping the
 * activity-api `metadata` envelope. Activity-api stores all non-canonical
 * extras under `row.metadata` (a free-form bag declared in
 * `ExecutionRecordSchema.metadata`); top-level recording would require a
 * SCHEMAFULL column migration, which is out-of-scope. Looking inside
 * `metadata` first, then top-level, lets the detector recognise either
 * shape — schema-free instrumentation today, schema-pinned later if and
 * when activity-api promotes the field. See ias-executor-ts
 * `activity-api-trace-sink.ts` for the producer side.
 */
function readCandidate(row: TraceRow, field: string): string | null {
  const meta = (row as { metadata?: unknown }).metadata;
  if (meta && typeof meta === "object") {
    const v = (meta as Record<string, unknown>)[field];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const top = row[field];
  if (typeof top === "string" && top.length > 0) return top;
  return null;
}

/**
 * Probe every row for any of the candidate target-recording fields. Return
 * the first field name that appears with a non-null string value on any
 * row (either top-level or nested under `metadata`), or null if none of
 * them are present anywhere.
 */
function detectTargetField(rows: TraceRow[]): string | null {
  for (const field of TARGET_FIELD_CANDIDATES) {
    for (const row of rows) {
      if (readCandidate(row, field) !== null) return field;
    }
  }
  return null;
}

async function postGap(
  url: string,
  authHeader: Record<string, string>,
  body: unknown,
): Promise<{ ok: boolean; status: number | "error"; error?: string }> {
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) return { ok: true, status: resp.status };
    return { ok: false, status: resp.status, error: (await resp.text()).slice(0, 200) };
  } catch (err) {
    return { ok: false, status: "error", error: (err as Error).message };
  }
}

export async function resolveDispatchTargetDriftScan(
  pointer: DispatchTargetDriftScanPointer,
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
          resolver: "dispatch_target_drift_scan",
          detail: `activity-api traces returned ${resp.status}`,
        },
      };
    }
    const json = (await resp.json()) as { traces?: unknown; executions?: unknown };
    if (Array.isArray(json.traces)) traces = json.traces as TraceRow[];
    else if (Array.isArray(json.executions)) traces = json.executions as TraceRow[];
    scanned = traces.length;
  } catch (err) {
    return {
      shape: "structuredError",
      body: {
        resolver: "dispatch_target_drift_scan",
        detail: `activity-api fetch failed: ${(err as Error).message}`,
      },
    };
  }

  // 2. Probe schema for target-recording field.
  const targetField = detectTargetField(traces);

  // 3a. Field absent → emit ONE instrumentation gap and return.
  if (targetField === null) {
    const instrumentationGap = {
      impulse: {
        pointer: {
          type: "substrateGap_write",
          gap: {
            id: "instrumentation-gap-dispatch-target-not-recorded",
            category: "missing_concept",
            source: "substrate_detected",
            summary:
              "activity-api execution traces do not record the dispatch's originally-" +
              "requested target_template_id. Detector probed " +
              TARGET_FIELD_CANDIDATES.join(", ") +
              ` across ${scanned} recent rows and found none. Without this field, ` +
              "dispatch-target-drift (caller says X, Thompson/recommend selects Y) is " +
              "structurally invisible to the substrate. Fix path: extend AET schema + " +
              "trace-write path in repos/metabob-activity-api so goal-host can persist " +
              "the requested target alongside the selected variant_id.",
            detected_at: new Date().toISOString(),
            status: "open",
            fix_priors: ["concept_9ldsmRgqSTd5"],
            classification_metadata: {
              gap_subtype: "instrumentation_gap_dispatch_target_not_recorded",
              gap_class: "instrumentation_gap",
              detection_principle: "concept_9ldsmRgqSTd5",
              probed_fields: [...TARGET_FIELD_CANDIDATES],
              rows_probed: scanned,
              affected_paths: [
                "repos/metabob-activity-api/src/models/schemas.ts",
                "repos/goal-host-vessel/src/index.ts",
                "repos/ias-executor-ts/src/hosts/goal-host.ts",
              ],
              chained_detection_blocked: "dispatch_target_drift",
            },
          },
        },
      },
    };

    let instrumentationPosted = false;
    let instrumentationStatus: number | "error" | undefined;
    let instrumentationError: string | undefined;
    if (!dryRun) {
      const r = await postGap(emitUrl, authHeader, instrumentationGap);
      instrumentationPosted = r.ok;
      instrumentationStatus = r.status;
      instrumentationError = r.error;
    }

    return {
      shape: "dispatchTargetDriftReport",
      body: {
        scanned,
        target_field_detected: null,
        drifts_detected: 0,
        drifts_posted: 0,
        instrumentation_gap_emitted: !dryRun,
        instrumentation_gap_posted: instrumentationPosted,
        instrumentation_gap_status: instrumentationStatus,
        instrumentation_gap_error: instrumentationError,
        dry_run: dryRun,
        completed_at: new Date().toISOString(),
        note:
          "Detector ran as a stub because the data shape to detect " +
          "dispatch-target-drift directly is not yet recorded on traces. The single " +
          "emitted gap is the chained-prerequisite for the real detection.",
      },
    };
  }

  // 3b. Field present → scan for drifts.
  const drifts: DriftEntry[] = [];
  for (const t of traces) {
    const requested = readCandidate(t, targetField);
    if (requested === null) continue;
    const selected = extractSelected(t);
    if (selected === "unknown") continue;
    if (requested === selected) continue;
    const execId = extractExecId(t);
    if (execId === null) continue;
    drifts.push({
      exec_id: execId,
      requested,
      selected,
      field_name: targetField,
      gap_id: `dispatch-target-drift-${execId}`,
      posted: false,
    });
    if (drifts.length >= maxEmits) break;
  }

  // Emit a substrateGap per drift unless dry-run.
  if (!dryRun) {
    for (const entry of drifts) {
      const body = {
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: entry.gap_id,
              category: "trace_quality",
              source: "substrate_detected",
              summary:
                `Dispatch-target-drift on exec ${entry.exec_id}: caller requested ` +
                `'${entry.requested}' but execution recorded selected template ` +
                `'${entry.selected}'. The target_template_id parameter is decorative ` +
                `on this dispatch path — the caller's intent was silently overridden.`,
              detected_at: new Date().toISOString(),
              status: "open",
              fix_priors: ["concept_9ldsmRgqSTd5"],
              classification_metadata: {
                gap_subtype: "dispatch_target_drift",
                gap_class: "dispatch_target_drift",
                exec_id: entry.exec_id,
                requested_template_id: entry.requested,
                selected_template_id: entry.selected,
                target_field: entry.field_name,
                detection_principle: "concept_9ldsmRgqSTd5",
              },
            },
          },
        },
      };
      const r = await postGap(emitUrl, authHeader, body);
      entry.posted = r.ok;
      entry.post_status = r.status;
      if (r.error) entry.post_error = r.error;
    }
  }

  return {
    shape: "dispatchTargetDriftReport",
    body: {
      scanned,
      target_field_detected: targetField,
      drifts_detected: drifts.length,
      drifts_posted: drifts.filter((d) => d.posted).length,
      instrumentation_gap_emitted: false,
      instrumentation_gap_posted: false,
      dry_run: dryRun,
      drift_entries: drifts,
      completed_at: new Date().toISOString(),
    },
  };
}
