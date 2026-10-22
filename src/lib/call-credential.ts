/**
 * THE CALL'S OWN CREDENTIAL, FOR A CALL THIS NODE FORWARDS (2026-10-22).
 *
 * A gap-store call that reaches this node's resolve route and is forwarded to the holder used to travel under this
 * node's key, so the holder saw every caller as this node. Now, for a call the route received for a held gap-store
 * shape, the route runs the dispatch inside this context with the caller's own `Authorization: ApiKey <key>`, and
 * the forward (resolvers/substrate-gap.ts forwardToGapStore) presents THAT, so the holder's identity decides about
 * that caller, per call. A write the node makes itself (a detector, a rhythm, a compose) has no context and travels
 * under the node key: the node is its principal.
 *
 * Held in memory for the call only (AsyncLocalStorage, the pattern lib/operator-direct.ts and lib/request-signal.ts
 * use): never logged, persisted, queued or derived from. Only a well-formed single ApiKey credential is carried.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const current = new AsyncLocalStorage<string>();

/** Run `fn` with `authorization` as the credential a forward of this call presents (ignored unless it is `ApiKey <key>`). */
export function runWithCallCredential<T>(authorization: string | undefined, fn: () => Promise<T>): Promise<T> {
  const h = String(authorization ?? "").trim();
  return /^ApiKey\s+\S+$/i.test(h) ? current.run(h, fn) : fn();
}

/** The current call's own `Authorization` value, or null for a call this node makes itself. */
export function currentCallCredential(): string | null {
  return current.getStore() ?? null;
}

/** Run `fn` as a call this node makes itself, outside any caller's context (work queued by a call, replayed later). */
export function runWithoutCallCredential<T>(fn: () => Promise<T>): Promise<T> {
  return current.exit(fn);
}
