/**
 * Is an inbound request one of the multi-minute drafting runs a restart must not
 * destroy?
 *
 * THE DEFECT THIS REPLACES. The first version tested a regex against the RAW
 * REQUEST BODY:
 *
 *   const LONG_RUNNING = /(feature_compose|patch_with_tools|...)/i;
 *   if (LONG_RUNNING.test(raw)) inFlightRequests++;
 *
 * So any request that merely MENTIONED one of those words counted as a live
 * compose. Measured 2026-08-10 against an independent census — `ls
 * /workspace/compose-slots/*.slot`, the authoritative count of live composes,
 * said **1** while `/health` reported **9**. The autonomous lane was writing gap
 * records titled "feature-compose-has-no-concurrency-cap"; every write of that
 * gap registered as a compose in flight.
 *
 * The inflation was load-bearing in three places:
 *   1. the SIGTERM drain waits for the count to reach 0 — unreachable under
 *      ambient gap traffic, so it burned its full budget and killed the compose
 *      at the deadline, which is the exact failure the counter was added to
 *      prevent;
 *   2. substrate-pull-sync defers a restart while the count is non-zero, so it
 *      deferred every tick until it hit its bound and restarted anyway;
 *   3. it is published on /health, so every other consumer inherited the lie.
 *
 * A request is a long-running run only if its impulse pointer SAYS so. Read the
 * pointer type; never pattern-match prose.
 *
 * FAILS CLOSED ON PARSE ERRORS, deliberately: a compose pointer is always a JSON
 * envelope, so "cannot parse" is conclusive evidence that this is not one. The
 * cost of not counting a non-JSON body is zero; the cost of counting every body
 * that talks about composing is the outage above.
 */

/** Pointer types whose runs take minutes and whose loss is not recoverable. */
export const LONG_RUNNING_TYPES: ReadonlySet<string> = new Set([
  "feature_compose",
  "patch_with_tools",
  "apply_proposal_as_patch",
  "vessel_mitosis",
  "vessel_mitosis_cutover",
]);

/** Accepts both envelope spellings this vessel serves: `{impulse:{pointer}}` and bare `{pointer}`. */
export function isLongRunningBody(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  try {
    const b = JSON.parse(raw) as {
      impulse?: { pointer?: { type?: unknown } };
      pointer?: { type?: unknown };
    };
    const t = b?.impulse?.pointer?.type ?? b?.pointer?.type;
    return typeof t === "string" && LONG_RUNNING_TYPES.has(t);
  } catch {
    return false;
  }
}
