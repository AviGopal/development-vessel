import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';

/**
 * Is the machine so oversubscribed that starting another test suite is pure waste?
 *
 * WHY THIS EXISTS. Mitosis evaluation runs a full `bun test` per candidate (and a second one for
 * the baseline). Measured on substrate-live 2026-08-30: `development-vessel:mitosis-tick` fired
 * ~390 times an hour while each suite takes minutes, so ~29 suites ran concurrently on 14 CPUs and
 * the 1-minute load average sat between 41 and 57 for over half an hour with no downward trend.
 *
 * The load is self-defeating rather than merely expensive. A suite that finishes in ~2 minutes on
 * an idle box takes far longer at 4x oversubscription, so it tends to hit SUITE_CHECK_TIMEOUT_MS
 * (420s) and come back `timed_out` — which the evaluator already treats as INCONCLUSIVE-DEFER, not
 * as a regression. The run therefore burns seven CPU-minutes and yields exactly the verdict it
 * would have yielded for free. Worse, that burn is a large part of what made the box slow enough
 * to force the timeout, so the condition sustains itself.
 *
 * Declining to start under those conditions produces the SAME inconclusive verdict at zero cost,
 * and the deferral lifts by itself as soon as the load falls. This is condition-driven selection —
 * read the current state and choose — rather than a static concurrency clamp or a timer.
 *
 * THRESHOLD. Deliberately conservative at 3x the CPU count. Self-development must not be starved
 * by an over-eager guard: at 1-2x oversubscription suites still complete and their verdicts are
 * real, so they are allowed to run. Only past 3x, where a timeout is the likely outcome anyway, is
 * the work skipped.
 */
export const SATURATION_MULTIPLE = 3;

/** Read the 1-minute load average. Returns null when unreadable (non-Linux, restricted /proc). */
export function loadAverage1m(readFile: (p: string) => string = (p) => readFileSync(p, 'utf-8')): number | null {
  try {
    const first = readFile('/proc/loadavg').trim().split(/\s+/)[0];
    const n = Number(first);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * True when the box is oversubscribed past `SATURATION_MULTIPLE` x CPU count.
 *
 * FAILS OPEN. An unreadable loadavg or an implausible CPU count returns false, so the guard can
 * only ever skip work on positive evidence of saturation. A guard that mistakenly reports
 * saturation would silently halt mitosis evaluation altogether — a far worse outcome than the load
 * it exists to relieve.
 */
export function isSaturated(
  load: number | null = loadAverage1m(),
  cpuCount: number = cpus().length,
): boolean {
  if (load === null || !Number.isFinite(load)) return false;
  if (!Number.isFinite(cpuCount) || cpuCount < 1) return false;
  return load > cpuCount * SATURATION_MULTIPLE;
}
