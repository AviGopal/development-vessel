/**
 * PROGRESS, NOT AGE — what a converger reads before restarting into a long run.
 *
 * substrate-pull-sync defers an owed restart while /health reports in-flight work, but
 * only until the OLDEST request passes the compose ceiling (900 s): age alone then forced
 * the restart. A compose that walks scope -> plan -> apply -> verify -> own-check ->
 * cutover routinely runs past 900 s while still moving, so the restart killed live work.
 * Age says how long a run has taken, not whether it is stuck.
 *
 * This module owns the in-flight request records and lets the compose path STAMP a
 * stage transition on the record of the request it runs under (AsyncLocalStorage, so
 * no call site has to carry a handle). /health publishes
 *   in_flight_last_progress_ms — ms since the most recent stage transition of ANY
 *                                in-flight request (min age: one moving run is reason
 *                                to wait; a lone stalled run stops refreshing it);
 *                                null until some in-flight request has stamped, so a
 *                                request type that never stamps keeps the age rule.
 *   in_flight_last_progress_id — the attempt (gap id) named by that stamp, or null.
 * pull-sync defers a past-ceiling restart while that is under its shaped stall bound.
 *
 * A stage transition, not a heartbeat: stamps sit at existing stage-boundary log points,
 * so a run that hangs inside one stage stops refreshing and reads as stalled. A stamp
 * made outside any admitted request (an in-process caller with no HTTP record) is
 * dropped: it must not make a stalled request look alive.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface InFlightRecord {
  /** Admission time (ms epoch). */
  readonly at: number;
  /** Last stage transition stamped under this request (ms epoch); undefined until one is. */
  progressAt?: number;
  progressStage?: string;
  progressId?: string;
}

const records = new Set<InFlightRecord>();
const current = new AsyncLocalStorage<InFlightRecord>();

/** Register an admitted long-running request. Pair with releaseInFlight in a finally. */
export function admitInFlight(now: number = Date.now()): InFlightRecord {
  const rec: InFlightRecord = { at: now };
  records.add(rec);
  return rec;
}

export function releaseInFlight(rec: InFlightRecord | null | undefined): void {
  if (rec) records.delete(rec);
}

/** Run the request's handler with `rec` as the record its stage stamps land on. */
export function runInFlight<T>(rec: InFlightRecord, fn: () => T): T {
  return current.run(rec, fn);
}

/** Stamp a stage transition on the current request's record. Never throws. */
export function stampComposeProgress(stage: string, id?: unknown): void {
  try {
    const rec = current.getStore();
    if (!rec || !records.has(rec)) return;
    rec.progressAt = Date.now();
    rec.progressStage = stage;
    if (id !== undefined && id !== null && String(id) !== "") rec.progressId = String(id);
  } catch { /* advisory: progress must never fail a compose */ }
}

/** ms since the oldest in-flight request was admitted, or null when none is in flight. */
export function inFlightOldestMs(now: number = Date.now()): number | null {
  let oldest: number | null = null;
  for (const r of records) if (oldest === null || r.at < oldest) oldest = r.at;
  return oldest === null ? null : now - oldest;
}

/** The /health progress fields (see the module comment for their contract). */
export function inFlightProgressHealth(now: number = Date.now()): {
  in_flight_last_progress_ms: number | null;
  in_flight_last_progress_id: string | null;
} {
  let latest: InFlightRecord | null = null;
  for (const r of records) {
    if (r.progressAt === undefined) continue;
    if (latest === null || r.progressAt > (latest.progressAt as number)) latest = r;
  }
  if (!latest) return { in_flight_last_progress_ms: null, in_flight_last_progress_id: null };
  return {
    in_flight_last_progress_ms: Math.max(0, now - (latest.progressAt as number)),
    in_flight_last_progress_id: latest.progressId ?? null,
  };
}
