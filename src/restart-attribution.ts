/**
 * Who asked this vessel to restart, and what did it destroy?
 *
 * THE OBSERVED PROBLEM (2026-08-11). development-vessel hosts `feature_compose`
 * for the whole fleet, so every restart of it discards long-running composes for
 * OTHER vessels once the drain deadline passes. In one 2h20m window it restarted
 * SIX times (~13 min apart) with 54 `REFUSING long-running request during drain`
 * and two `drain deadline — they will be lost`; zero isolated-vessel composes
 * completed while in-place ones landed five commits.
 *
 * At least THREE mechanisms can issue that restart — the mitosis cutover's
 * scheduled self-restart, substrate-pull-sync converging to origin/dev, and a
 * plain `systemctl restart` from an operator or Makefile — and systemd's journal
 * records only `Stopping development-vessel.service`. It never records the
 * requester.
 *
 * That absence is not a diagnostic inconvenience, it is what blocks the fix. The
 * cutover quiesce was found to be bounded BELOW the compose ceiling and raised
 * (5a41852), and restarts kept killing composes — with no way to tell whether the
 * fix worked and a different source fired, or whether the fix is inert. Two
 * mechanisms were confidently proposed and retracted in a single session for
 * exactly this reason.
 *
 * THE KEY DESIGN POINT — AN UNATTRIBUTED RESTART IS THE SIGNAL. A breadcrumb can
 * only cover sources that write one, and the source we cannot name will by
 * definition not write one. So the useful observation is the ABSENCE: a start with
 * no breadcrumb is an UNATTRIBUTED restart. Counting those tells us the unknown
 * source's frequency now, and tells us it is gone when the count reaches zero.
 * Designing only for the sources we already know would have measured everything
 * except the thing we are missing.
 *
 * ENTIRELY OBSERVATIONAL. Nothing here can block, delay, or alter a restart; the
 * worst failure is a missing log line. Every function swallows its own errors,
 * because a vessel that will not boot because its telemetry file is unreadable is
 * far worse than one that boots without knowing why it restarted.
 */

/** Where breadcrumbs live. One file per vessel; the newest write wins. */
export function breadcrumbPath(vessel: string, dir?: string): string {
  const base = dir ?? process.env["RESTART_BREADCRUMB_DIR"] ?? "/workspace/restart-requests";
  // A vessel name is used as a filename — keep it to a safe charset so a caller
  // cannot escape the directory.
  const safe = String(vessel || "unknown").replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80);
  return `${base}/${safe}.json`;
}

export interface RestartBreadcrumb {
  /** Who asked: "mitosis-cutover", "pull-sync", "make", "operator", … */
  readonly requester: string;
  /** Why, in one line — the gap id, the sha, the command. */
  readonly reason: string;
  /** in_flight as the requester observed it, so a lossy restart is visible. */
  readonly in_flight?: number;
  /** ISO timestamp written by the requester. */
  readonly at: string;
}

/** Parse a breadcrumb, tolerating anything. Returns null when it cannot. */
export function parseBreadcrumb(raw: string): RestartBreadcrumb | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const requester = typeof o["requester"] === "string" ? o["requester"] : "";
    if (!requester) return null;
    return {
      requester,
      reason: typeof o["reason"] === "string" ? o["reason"] : "",
      in_flight: typeof o["in_flight"] === "number" ? o["in_flight"] : undefined,
      at: typeof o["at"] === "string" ? o["at"] : "",
    };
  } catch {
    return null;
  }
}

/**
 * How stale may a breadcrumb be and still explain THIS start?
 *
 * A restart takes as long as the drain allows (240s) plus start-up. Anything much
 * older than that describes a PREVIOUS restart, and attributing this start to it
 * would be worse than reporting the start as unattributed — a wrong attribution is
 * how a plausible mechanism gets believed. Ten minutes is comfortably past a legal
 * restart and still far short of the ~13-minute observed restart interval.
 */
export const BREADCRUMB_FRESH_MS = Number(process.env["RESTART_BREADCRUMB_FRESH_MS"] ?? 600_000);

/** Is this breadcrumb recent enough to explain a start happening now? */
export function breadcrumbIsFresh(b: RestartBreadcrumb, now: number): boolean {
  if (!b.at) return false;
  const t = Date.parse(b.at);
  if (!Number.isFinite(t)) return false;
  // A breadcrumb from the future is a clock problem, not an explanation.
  if (t > now + 60_000) return false;
  return now - t <= BREADCRUMB_FRESH_MS;
}

/**
 * The line this vessel logs at boot.
 *
 * Deliberately says UNATTRIBUTED loudly when there is no fresh breadcrumb: that is
 * the case we are hunting, and a quiet "no data" line would let the very thing
 * this module exists to surface stay invisible.
 */
export function describeStart(b: RestartBreadcrumb | null, now: number): string {
  if (!b) {
    return "[restart-attribution] UNATTRIBUTED START — no restart breadcrumb. Some source restarted this vessel without declaring itself; if a compose was in flight it was lost with no record of what killed it.";
  }
  if (!breadcrumbIsFresh(b, now)) {
    return `[restart-attribution] UNATTRIBUTED START — the only breadcrumb is stale (requester=${b.requester}, at=${b.at}), so it describes an EARLIER restart, not this one. Reporting unattributed rather than guessing.`;
  }
  const inflight = typeof b.in_flight === "number"
    ? (b.in_flight > 0
      ? ` — it observed ${b.in_flight} in flight, so this restart was LOSSY`
      : " — it observed 0 in flight, so nothing was lost")
    : "";
  return `[restart-attribution] restarted by ${b.requester}: ${b.reason}${inflight}`;
}
