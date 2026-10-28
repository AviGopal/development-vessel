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

/**
 * THE EXECUTION THAT PRODUCED THIS CALL'S OUTPUT (findings agf_hrgaf1yd89kr / agf_zuaa6xsh4b28, "detectors scored by
 * consumption").
 *
 * light-dispatch stamps every dispatched task pointer with `producer_execution_id` and `producer_template_id`. A
 * detector resolver that runs under such a task files its gaps through this vessel's gap writer, in-process or by an
 * HTTP self-call to its own resolve route, and the gap row is what a consumer later closes, rejects or lets expire.
 * For that outcome to reach the detector, the row must name the execution and template that filed it.
 *
 * So the resolve dispatch runs inside this context (AsyncLocalStorage, as the call credential above),
 * taken from the pointer's own stamp, else from the self-call headers below, else inherited from the call it runs
 * inside. A self-call carries it in `X-Producer-Execution-Id` / `X-Producer-Template-Id` (added by selfAuthHeaders),
 * and the gap writer stamps it on the row it creates (substrate-gap.ts). It lives in this file, not a module of its
 * own, because the gap writer and selfAuthHeaders are on the evaluator's import closure
 * (test/resolvers/evaluator-grant-scan.test.ts): a new lane-editable module there would widen it.
 *
 * ABSENT IS NORMAL. A node whose light-dispatch does not stamp yet, a walk-filed gap, an operator's write: no context,
 * and every write goes on exactly as before, with no producer fields. Nothing here may refuse or delay a write.
 * Like origin_dispatch_id, the stamp is the caller's claim; the row's own detector name stays beside it.
 */

export interface Producer { execution_id: string; template_id: string | null }

export const PRODUCER_EXECUTION_FIELD = "producer_execution_id";
export const PRODUCER_TEMPLATE_FIELD = "producer_template_id";
export const PRODUCER_EXECUTION_HEADER = "X-Producer-Execution-Id";
export const PRODUCER_TEMPLATE_HEADER = "X-Producer-Template-Id";

const currentProducerStore = new AsyncLocalStorage<Producer>();

/** A usable id: a non-blank string with no unrendered `{{…}}` placeholder, bounded. */
function idOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 && s.length <= 200 && !/\{\{[^}]*\}\}/.test(s) ? s : null;
}

/** The producer a pointer names (light-dispatch's stamp), or null. */
export function producerFromPointer(p: Record<string, unknown> | null | undefined): Producer | null {
  const e = idOf(p?.[PRODUCER_EXECUTION_FIELD]);
  return e ? { execution_id: e, template_id: idOf(p?.[PRODUCER_TEMPLATE_FIELD]) } : null;
}

/** The producer a self-call's headers name, or null. */
export function producerFromHeaders(header: (name: string) => string | undefined): Producer | null {
  const e = idOf(header(PRODUCER_EXECUTION_HEADER));
  return e ? { execution_id: e, template_id: idOf(header(PRODUCER_TEMPLATE_HEADER)) } : null;
}

/** Run `fn` with `producer` as this call's producer; null keeps whatever context the call already runs in. */
export function runWithProducer<T>(producer: Producer | null, fn: () => Promise<T>): Promise<T> {
  return producer ? currentProducerStore.run(producer, fn) : fn();
}

/** The producer of the call running now, or null. */
export function currentProducer(): Producer | null {
  return currentProducerStore.getStore() ?? null;
}

/** Headers that carry the current producer on a self-call; {} when there is none. */
export function producerHeaders(): Record<string, string> {
  const p = currentProducerStore.getStore();
  if (!p) return {};
  return { [PRODUCER_EXECUTION_HEADER]: p.execution_id, ...(p.template_id ? { [PRODUCER_TEMPLATE_HEADER]: p.template_id } : {}) };
}
