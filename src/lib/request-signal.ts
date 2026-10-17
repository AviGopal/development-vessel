/**
 * THE CALLER'S SIGNAL, CARRIED TO THE CALLS A RESOLVE MAKES (light-dispatch abort-budget fix).
 *
 * Measured: when a caller (light-dispatch, goal-host) gave up on a resolve, development-vessel kept
 * going: the resolve route never handed the request's signal to the dispatch, and the resolvers'
 * outbound calls (llm_completion_dispatch above all) had no deadline, so an abandoned LLM request
 * ran, and was paid for, after nobody was waiting. The resolve route now runs the dispatch under the
 * request's signal (AsyncLocalStorage, the pattern operator-direct.ts uses for its grant), and an
 * outbound call composes it with its own deadline via outboundSignal.
 *
 * LONG-RUNNING WORK IS NOT CUT. The entrypoint (index.ts) rebuilds the Request for a long-running
 * body (long-running.ts: feature_compose, gap_to_feature, ...) and the rebuilt Request carries its
 * own signal, which never aborts. A compose therefore outlives a caller that stopped waiting, exactly
 * as before; only a short resolve (llm_completion_dispatch and the like) ends with its caller.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const current = new AsyncLocalStorage<AbortSignal>();

/** Run `fn` with `signal` as the current request's signal (no signal: run as-is). */
export function runWithRequestSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return signal ? current.run(signal, fn) : fn();
}

/** The current request's signal, or undefined outside a request (an in-process caller). */
export function currentRequestSignal(): AbortSignal | undefined {
  return current.getStore();
}

/** The signal for one outbound call: the request's signal, and a deadline when one is stated. */
export function outboundSignal(deadlineMs?: number): AbortSignal | undefined {
  const parts: AbortSignal[] = [];
  const req = currentRequestSignal();
  if (req) parts.push(req);
  if (typeof deadlineMs === "number" && Number.isFinite(deadlineMs) && deadlineMs > 0) parts.push(AbortSignal.timeout(deadlineMs));
  return parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : AbortSignal.any(parts);
}
