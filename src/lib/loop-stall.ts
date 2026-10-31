/**
 * A STALLED EVENT LOOP NAMES ITSELF (step 1, evidence). Measured 2026-10-31: this vessel's journal went silent for 71 s,
 * its cheap synchronous /health went unanswered three times, and self-recovery restarted it mid-compose. The backlog
 * flushed in the second systemd stopped it: a synchronous child (spawnSync / execFileSync) holding the loop fits that,
 * and the vessel has dozens of such sites, many with no timeout. Which one ran could not be told. This makes the next
 * stall say which work was running.
 *
 * Two halves, both cheap:
 *   - THE MARKER, at the tick level only: the one resolver dispatcher (routes/impulses.ts resolveDispatch) and the
 *     in-process loops in index.ts call noteActivity(label) on entry and the returned done() on exit. In memory it is
 *     the set of work in flight, with start times. When a marker file is configured (index.ts, under the volume root;
 *     nothing is written otherwise, so a test process never touches live state) the entry's label is also written
 *     synchronously as one line: a vessel killed DURING a stall still leaves the last entry behind for a post-mortem.
 *   - THE MONITOR: a 1 s timer that measures how late it fires. A blocked loop cannot run it, so the line is logged
 *     when the loop RESUMES: lag = now - expected, with the last entry and everything still in flight. A stall the
 *     process does not survive leaves only the marker file.
 *
 * The threshold is a number the caller hands in (index.ts reads the tuning row development_vessel.loop_stall_log_ms
 * through the one tuning reader). The monitor itself reads nothing over the network, so starting it from the
 * dispatch path costs no call any test or caller can see.
 */
import { writeFileSync } from "node:fs";

/** Bootstrap default for the stall threshold (used until the tuning row answers): below /health's 10 s probe window. */
export const LOOP_STALL_LOG_MS_DEFAULT = 5_000;
/** The tuning row that sets the threshold, read by index.ts through readTuningNumber. */
export const LOOP_STALL_LOG_MS_ROW = "development_vessel.loop_stall_log_ms";
const LOOP_STALL_INTERVAL_MS = 1_000;

let seq = 0;
const inFlight = new Map<number, { label: string; at: number }>();
let last: { label: string; at: number } | null = null;
let markerFile: string | null = null;

/** Configure (or, with null, stop) the synchronous one-line marker file written at each entry. */
export function setActivityMarkerFile(path: string | null): void { markerFile = path; }

/** Record that `label` work starts now; call the returned function when it ends. */
export function noteActivity(label: string): () => void {
  const at = Date.now();
  const id = ++seq;
  last = { label, at };
  inFlight.set(id, last);
  if (markerFile) {
    try { writeFileSync(markerFile, `${new Date(at).toISOString()} pid=${process.pid} ${label}\n`); } catch { /* best-effort: never fails the work */ }
  }
  return () => {
    const e = inFlight.get(id);
    inFlight.delete(id);
    // Work that ends right as the loop resumes (the blocking call returned, then its resolver finished before the
    // monitor's timer ran) is kept briefly, so the stall line can still name it.
    if (e) { recentlyEnded.push({ ...e, ended: Date.now() }); if (recentlyEnded.length > RECENT_KEEP) recentlyEnded.shift(); }
  };
}
const RECENT_KEEP = 16;
const recentlyEnded: Array<{ label: string; at: number; ended: number }> = [];

/** The most recent entry and everything still in flight, oldest first (ages relative to `nowMs`). */
export function activitySnapshot(nowMs: number = Date.now()): { last: { label: string; age_ms: number } | null; in_flight: Array<{ label: string; age_ms: number }> } {
  return {
    last: last ? { label: last.label, age_ms: nowMs - last.at } : null,
    in_flight: [...inFlight.values()].sort((a, b) => a.at - b.at).map((e) => ({ label: e.label, age_ms: nowMs - e.at })),
  };
}

/**
 * The one stall line: the stall's length, the threshold, the last entry, what is still in flight, and what ended after
 * `stallStartMs` (it was running when the loop blocked). Ages are at `nowMs`.
 */
export function loopStallLine(lagMs: number, thresholdMs: number, nowMs: number = Date.now(), stallStartMs: number = nowMs - lagMs): string {
  const s = activitySnapshot(nowMs);
  const lastText = s.last ? `${s.last.label} (entered ${s.last.age_ms}ms ago)` : "<none>";
  const flight = s.in_flight.length ? s.in_flight.map((e) => `${e.label}@${e.age_ms}ms`).join(",") : "<none>";
  const ended = recentlyEnded.filter((e) => e.ended >= stallStartMs && e.at <= stallStartMs).map((e) => `${e.label}@${nowMs - e.at}ms`);
  return `[loop-stall] event loop blocked ${lagMs}ms (threshold ${thresholdMs}ms); last activity: ${lastText}; still in flight: ${flight}; ended as the loop resumed: ${ended.length ? ended.join(",") : "<none>"}`;
}

let monitor: { timer: ReturnType<typeof setInterval>; threshold: number } | null = null;

/**
 * Start the monitor once (idempotent; unref'd, so it never holds a process open). `thresholdMs` updates the threshold
 * of a running monitor. Returns a stop function.
 */
export function startLoopStallMonitor(opts: { thresholdMs?: number; intervalMs?: number; log?: (line: string) => void } = {}): () => void {
  if (typeof opts.thresholdMs === "number" && Number.isFinite(opts.thresholdMs) && opts.thresholdMs > 0) {
    if (monitor) monitor.threshold = opts.thresholdMs;
  }
  if (!monitor) {
    const intervalMs = opts.intervalMs ?? LOOP_STALL_INTERVAL_MS;
    const log = opts.log ?? ((line: string) => console.warn(line));
    let expected = Date.now() + intervalMs;
    const m: { timer: ReturnType<typeof setInterval>; threshold: number } = {
      threshold: typeof opts.thresholdMs === "number" && opts.thresholdMs > 0 ? opts.thresholdMs : LOOP_STALL_LOG_MS_DEFAULT,
      timer: setInterval(() => {
        const now = Date.now();
        const lag = now - expected;
        if (lag >= m.threshold) log(loopStallLine(lag, m.threshold, now, expected - intervalMs));
        expected = now + intervalMs;
      }, intervalMs),
    };
    (m.timer as { unref?: () => void }).unref?.();
    monitor = m;
  }
  return stopLoopStallMonitor;
}

/** Stop the monitor (tests; a later start makes a fresh one). */
export function stopLoopStallMonitor(): void {
  if (monitor) clearInterval(monitor.timer);
  monitor = null;
}
