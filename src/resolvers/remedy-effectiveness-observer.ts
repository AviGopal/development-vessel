import { readFileSync } from "fs";
import { join } from "path";
import { WORKSPACE_ROOT } from "../config.js";
import type { ResolverResult } from "./types.js";

/**
 * remedy_effectiveness_observer — closes the law-6 blind spot where a gap's
 * remedy dispatches green but its downstream execution aborts, so the gap is
 * silently re-dispatched forever (the trace-store-reconcile livelock: the
 * remedy 500'd on every run for 7 days while the gap-drain loop treated the
 * goal-host 202 ACK as success).
 *
 * The detector reads the drain log the gap-drain-observer writes
 * (`WORKSPACE_ROOT/pool/drain-log.jsonl`) — each `action:"dispatched"` line
 * records the gap_id, category, remedy (impulse_type/target/goal) and the
 * dispatch's ok/http_status. The load-bearing signal is NOT that ACK: for the
 * goal-host target path the ACK is 202/ok:true even when the remedy aborts.
 * The signal is REPEATED re-dispatch of the same gap_id with no movement of its
 * target metric — a working remedy closes its gap and stops being re-emitted.
 *
 * For `trace_store_reconciliation` it cross-checks the target metric directly:
 * if activity-api's `GET /metrics/db` still reports the trace store over cap,
 * the reconcile provably did not move row_count and the re-dispatch is a
 * livelock. For any other category the repeated re-dispatch itself is the
 * evidence (metric movement unknown, so not proven-moved).
 *
 * When a gap crosses `min_dispatches` re-dispatches inside `window_hours` with
 * no proven metric movement, it emits a `substrateGap`
 * (category `remedy_livelock`, route `dispatchable`) naming the failing remedy,
 * the observed http statuses, and the abort count, so the loop ESCALATES
 * (walks an investigation goal) instead of re-dispatching in silence.
 *
 * Pure read + best-effort emit; never throws into the caller; honors dry_run.
 */
export interface RemedyEffectivenessObserverPointer {
  type: "remedy_effectiveness_observer";
  /** dev-vessel impulses url for substrateGap_write. Default :8090/v2/impulses/resolve. */
  dev_vessel_impulses_url?: string;
  /** activity-api base url for the trace-store metric cross-check. Default :8080. */
  activity_api_url?: string;
  /** override the drain-log path. Default WORKSPACE_ROOT/pool/drain-log.jsonl. */
  drain_log_path?: string;
  /** lookback window (hours) for counting re-dispatches of one gap. Default 6. */
  window_hours?: number;
  /** re-dispatch count of one gap (no metric movement) that trips a livelock. Default 3. */
  min_dispatches?: number;
  /** if true, report only — do not emit a substrateGap. Default false. */
  dry_run?: boolean;
}

const DEFAULT_EMIT = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_API = "http://127.0.0.1:8080";

interface DrainEntry {
  action?: string;
  gap_id?: string;
  category?: string;
  impulse_type?: string;
  remedy?: string;
  ok?: boolean;
  http_status?: number | string;
  recorded_at?: string;
}

interface LivelockGroup {
  gap_id: string;
  category: string;
  remedy: string;
  dispatch_count: number;
  abort_count: number;
  statuses: Set<string>;
  last_at: string;
}

interface LivelockReport {
  gap_id: string;
  remedy: string;
  category: string;
  dispatch_count: number;
  abort_count: number;
  observed_statuses: string[];
  metric_moved: boolean | null;
  gap_emitted: boolean;
  gap_emit_status: number | string | null;
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
}

export async function resolveRemedyEffectivenessObserver(
  pointer: RemedyEffectivenessObserverPointer,
): Promise<ResolverResult> {
  const emitUrl = pointer.dev_vessel_impulses_url ?? DEFAULT_EMIT;
  const apiBase = pointer.activity_api_url ?? process.env["ACTIVITY_API_URL"] ?? DEFAULT_API;
  const drainPath = pointer.drain_log_path ?? join(WORKSPACE_ROOT, "pool", "drain-log.jsonl");
  const windowHours = pointer.window_hours ?? 6;
  const minDispatches = pointer.min_dispatches ?? 3;
  const dryRun = pointer.dry_run ?? false;

  // 1. Read the drain log the gap-drain-observer appends to. Best-effort: a
  // missing/unreadable log means "no signal", not an error.
  let raw: string | null = null;
  let readError: string | null = null;
  try {
    raw = readFileSync(drainPath, "utf8");
  } catch (e) {
    readError = e instanceof Error ? e.message : String(e);
  }

  if (raw === null) {
    return {
      shape: "remedyEffectivenessReport",
      body: {
        available: false,
        read_error: readError,
        drain_log_path: drainPath,
        generated_at: new Date().toISOString(),
      },
    };
  }

  const cutoff = Date.now() - windowHours * 3_600_000;
  const groups = new Map<string, LivelockGroup>();
  let scanned = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: DrainEntry;
    try {
      entry = JSON.parse(trimmed) as DrainEntry;
    } catch {
      continue;
    }
    if (entry.action !== "dispatched") continue;
    const gapId = typeof entry.gap_id === "string" ? entry.gap_id : "";
    if (!gapId) continue;
    const category = typeof entry.category === "string" ? entry.category : "unknown";
    // Never scan our own escalation gaps — that would flag the detector on itself.
    if (category === "remedy_livelock") continue;
    const recordedAt = typeof entry.recorded_at === "string" ? entry.recorded_at : "";
    const ts = recordedAt ? Date.parse(recordedAt) : NaN;
    if (Number.isFinite(ts) && ts < cutoff) continue;
    scanned++;

    const remedy =
      (typeof entry.impulse_type === "string" && entry.impulse_type) ||
      (typeof entry.remedy === "string" && entry.remedy) ||
      category;
    const g = groups.get(gapId) ?? {
      gap_id: gapId,
      category,
      remedy,
      dispatch_count: 0,
      abort_count: 0,
      statuses: new Set<string>(),
      last_at: recordedAt,
    };
    g.dispatch_count++;
    const httpStatus = entry.http_status;
    const statusNum = typeof httpStatus === "number" ? httpStatus : Number(httpStatus);
    // An abort is an observed non-2xx/2xx-masked failure. ok:false OR http>=500
    // (500s the ACK path hides show up here when the direct path is used).
    const aborted = entry.ok === false || (Number.isFinite(statusNum) && statusNum >= 500);
    if (aborted) g.abort_count++;
    if (httpStatus !== undefined && httpStatus !== null) g.statuses.add(String(httpStatus));
    if (recordedAt && recordedAt > g.last_at) g.last_at = recordedAt;
    groups.set(gapId, g);
  }

  // 2. For each gap re-dispatched >= minDispatches, decide whether its target
  // metric provably moved. If it did, the remedy eventually worked — skip. If
  // not (or unknown), it is a livelock: escalate.
  const livelocks: LivelockReport[] = [];
  const dayBucket = new Date().toISOString().slice(0, 10);
  const apiKey = process.env["METABOB_API_KEY"];
  const authHeader: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};

  for (const g of groups.values()) {
    if (g.dispatch_count < minDispatches) continue;

    // Target-metric cross-check. Only trace_store_reconciliation has a cheap,
    // authoritative counter we can read directly; other categories fall back to
    // "unknown" (null), which is treated as not-proven-moved.
    let metricMoved: boolean | null = null;
    if (g.category === "trace_store_reconciliation") {
      try {
        const r = await fetch(`${apiBase}/metrics/db`, { signal: AbortSignal.timeout(8_000) });
        if (r.ok) {
          const stats = (await r.json()) as Record<string, unknown>;
          const traceStore = stats["traceStore"] as { row_count?: unknown; cap?: unknown } | undefined;
          if (traceStore && typeof traceStore === "object") {
            const rowCount = Number(traceStore.row_count ?? 0);
            const cap = Number(traceStore.cap ?? 0);
            // Still over cap => reconcile provably did not drop row_count => not moved.
            metricMoved = !(cap > 0 && rowCount > cap);
          }
        }
      } catch {
        metricMoved = null;
      }
    }

    // Proven-moved remedies are healthy; skip them.
    if (metricMoved === true) continue;

    const observedStatuses = Array.from(g.statuses).sort();
    let emitted = false;
    let emitStatus: number | string | null = null;

    if (!dryRun) {
      const abortNote =
        g.abort_count > 0
          ? `${g.abort_count}/${g.dispatch_count} dispatches returned an abort/500`
          : `every dispatch ACK'd green (${observedStatuses.join(",") || "no status"}) while the target metric never moved`;
      const goal =
        `Remedy '${g.remedy}' for gap '${g.gap_id}' has been dispatched ${g.dispatch_count} times in the last ` +
        `${windowHours}h without moving its target metric (${abortNote}). The gap-drain loop is silently ` +
        `re-dispatching an aborting remedy. Investigate why the downstream execution is not reaching, then ` +
        `either repair the remedy or reclassify the gap so the loop stops re-dispatching it.`;
      const body = {
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: `remedy-livelock-${sanitizeId(g.gap_id)}-${dayBucket}`,
              category: "remedy_livelock",
              source: "substrate_detected",
              route: "dispatchable",
              remedy: { vessel: "goal-host-vessel", goal },
              summary: goal,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: {
                failing_gap_id: g.gap_id,
                failing_remedy: g.remedy,
                failing_category: g.category,
                dispatch_count: g.dispatch_count,
                abort_count: g.abort_count,
                observed_statuses: observedStatuses,
                metric_moved: metricMoved,
                window_hours: windowHours,
                last_dispatched_at: g.last_at,
              },
            },
          },
        },
      };
      try {
        const resp = await fetch(emitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        emitStatus = resp.status;
        emitted = resp.ok;
      } catch (e) {
        emitStatus = e instanceof Error ? e.message : "error";
      }
    }

    livelocks.push({
      gap_id: g.gap_id,
      remedy: g.remedy,
      category: g.category,
      dispatch_count: g.dispatch_count,
      abort_count: g.abort_count,
      observed_statuses: observedStatuses,
      metric_moved: metricMoved,
      gap_emitted: emitted,
      gap_emit_status: emitStatus,
    });
  }

  return {
    shape: "remedyEffectivenessReport",
    body: {
      available: true,
      scanned_dispatches: scanned,
      window_hours: windowHours,
      min_dispatches: minDispatches,
      livelock_count: livelocks.length,
      livelocks,
      dry_run: dryRun,
      generated_at: new Date().toISOString(),
    },
  };
}
