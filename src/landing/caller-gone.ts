// A compose whose caller went away: the caller-gone binding and the release of the landing leases abandoned composes still hold. Lifted as-is from feature-compose.ts.
import type { ResolverResult } from "../resolvers/types.js";
import { resolveSubstrateGapLease, type LandingLeaseVerdict } from "../resolvers/substrate-gap.js";
import { AsyncLocalStorage } from "node:async_hooks";

export const callerGoneStore = new AsyncLocalStorage<AbortSignal>();
/** Run `fn` with `signal` as the caller-gone signal of the request it serves (no signal: run as-is). */
export function runWithCallerGone<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return signal ? callerGoneStore.run(signal, fn) : fn();
}
/** A signal that aborts when `request` does (the client dropped the connection), unless this process is draining. The
 *  reason carries the time the caller left. */
export function bindCallerGone(request: AbortSignal, draining: () => boolean): AbortSignal {
  const ac = new AbortController();
  const left = () => { if (!draining()) ac.abort({ at: new Date().toISOString() }); };
  if (request.aborted) left(); else request.addEventListener("abort", left, { once: true });
  return ac.signal;
}

/**
 * A cutover this compose handed its landing to and that is still PENDING: it deferred, keeping its staged
 * tree and pending lock (preserve_pending), or returned cutoverDeferred (the change window was held) —
 * either way a later tick re-runs that cutover. Anything else (landed, refused, failed, never reached) is
 * an outcome.
 */
export function cutoverPendingIn(outcome: ResolverResult | null): boolean {
  const cutovers = ((outcome?.body ?? {}) as { cutovers?: unknown }).cutovers;
  if (!Array.isArray(cutovers)) return false;
  return cutovers.some((c) => cutoverResultPending(((c ?? {}) as { result?: unknown }).result));
}

/**
 * THE ONE DEFINITION OF A DEFERRED CUTOVER (CHANGE-30a). A cutover result is PENDING when it deferred, keeping its
 * staged tree and pending lock (preserve_pending), or returned cutoverDeferred (deferred: the change window was
 * held, the gap store was unreadable). Every site that asks "did this landing defer?" uses this.
 */
export function cutoverResultPending(r: unknown): boolean {
  return !!r && typeof r === "object" && ((r as Record<string, unknown>)["preserve_pending"] === true || (r as Record<string, unknown>)["deferred"] === true);
}

/**
 * THE LANDING LEASES OF COMPOSES STILL RUNNING IN THIS PROCESS, by attempt id: set when a compose takes its lease, removed
 * when its exit settles it (releaseOrKeepLandingLease). A drain that abandons in-flight composes exits the process, so
 * no compose exit runs and the lease stayed until its TTL: the restarted node's own acquire is a new attempt, refused
 * held_by_prior_attempt, and the armed gap idled (about 90 min, 2026-10-30).
 */
export const inFlightLandingLeases = new Map<string, { gapId: string; holder: string; attempt: string }>();
/**
 * The drain's release of the leases its abandoned composes hold, through the compose exit's own path with no outcome
 * (nothing pending for a cutover, so a release). Returns how many were held. Never throws; the caller bounds the wait.
 */
export async function releaseAbandonedLandingLeases(): Promise<number> {
  const held = [...inFlightLandingLeases.values()];
  await Promise.allSettled(held.map((l) => releaseOrKeepLandingLease(l, null)));
  return held.length;
}

/**
 * The compose exit's share of the landing lease. A cutover still pending keeps it, RENEWED here (a stage
 * boundary), so another node stays refused until that cutover's outcome. Otherwise it is released: the
 * cutover already released it on its own outcome (a second release by this holder is a no-op), or the
 * compose ended without anything for a cutover. Never throws.
 */
export async function releaseOrKeepLandingLease(lease: { gapId: string; holder: string; attempt: string } | null, outcome: ResolverResult | null): Promise<void> {
  if (!lease) return;
  inFlightLandingLeases.delete(lease.attempt);
  const pending = cutoverPendingIn(outcome);
  try {
    const r = await resolveSubstrateGapLease({ type: "substrateGapLease_write", action: pending ? "renew" : "release", gap_id: lease.gapId, holder: lease.holder, attempt: lease.attempt });
    const b = (r.body ?? {}) as LandingLeaseVerdict;
    console.log(`[feature-compose] landing lease ${pending ? `kept for the pending cutover (renewed=${String(b.granted)})` : `released=${String(b.released ?? false)}`} gap=${lease.gapId} holder=${lease.holder}`);
  } catch (err) {
    console.warn(`[feature-compose] landing lease ${pending ? "renew" : "release"} FAILED gap=${lease.gapId} holder=${lease.holder}: ${(err as Error).message.slice(0, 200)} (expires at its until)`);
  }
}
