// OPERATOR-DIRECTED IS A PROPERTY OF THE CALLER'S KEY, NOT OF THE POINTER.
//
// A directed feature_compose attempt is stamped by registerAttempt (attempt-register.ts directedIntentStamp),
// and a stamped landing is exempt from the autonomy scope's excluded paths at the cutover. Until now the
// stamp followed `directed: true` on the pointer, and goal-host set that for any /run-goal request carrying an
// `operator` field, which autonomous dispatchers send. So "directed" was self-declared end to end.
//
// Now registerAttempt stamps an intent directed ONLY under an OperatorDirectGrant, and a grant exists only when
// identity-vessel, asked fresh (no cache), answers that the OPERATOR'S OWN credential carries the
// "operator:direct" scope ("admin" as the interim fallback). That credential reaches this vessel as the
// X-Operator-Authorization header goal-host forwards from the operator's /run-goal request (goal-host
// src/operator-credential.ts); goal-host's own fleet key is the request's Authorization and is never it.
//
// What this reads, and nothing else:
//   - the X-Operator-Authorization header (ApiKey scheme), validated by identity (lib/caller-credential.ts
//     identityCredential, cache:false, fail closed: unreachable/refused/unset identity is no grant);
//   - identity's answer: authenticated, scopes, keyId. This node's own key (node-self, scopes ["node"]) is
//     never a grant. role and user id are not read: the cockpit key, the node keys and goal-host's key share
//     one user, org and role, and only the scopes they were issued with differ.
// No pointer field (directed, operator, scopes, any _grant) is read. No env or constant gate, no key-id list.
// (The gap-row section at the end of this file is the other half: a gap's stored `directed` and the route-set grant
// that alone may write it. The grant decision above still reads no pointer field.)
//
// HOW THE GRANT TRAVELS. The resolve route runs the feature_compose dispatch inside an AsyncLocalStorage
// context holding the grant (runWithOperatorDirectGrant); registerAttempt reads it (currentOperatorDirectGrant).
// A grant cannot arrive in JSON: it is a frozen object this module created and remembers in a WeakSet. It is
// bound to the request's gap id, so work that inherits the context but registers a different gap is not
// directed. A dispatch without the context (the gap lane, a resumed compose, any other route) registers
// autonomous.
//
// The two scopes are kept separate: "verdict:human" (activity-api, human goal-verification labels) does not
// make a compose directed, and "operator:direct" does not make a label human.
import { AsyncLocalStorage } from "node:async_hooks";
import { identityCredential, isNodeSelfCredential, type CallerCredential } from "./caller-credential.js";

export const OPERATOR_DIRECT_SCOPE = "operator:direct";
export const ADMIN_SCOPE = "admin";
/** The header goal-host carries the operator's own credential in (goal-host src/operator-credential.ts). */
export const OPERATOR_AUTHORIZATION_HEADER = "X-Operator-Authorization";

export interface OperatorDirectGrant {
  readonly key_id: string | null;
  readonly gap_id: string | null;
}

/** Whether an identity-validated credential may direct a compose: "operator:direct" (or "admin", interim), never node-self. */
export function isOperatorDirectCredential(cred: CallerCredential | null | undefined): boolean {
  if (!cred || cred.authenticated !== true || isNodeSelfCredential(cred)) return false;
  const scopes = Array.isArray(cred.scopes) ? cred.scopes : [];
  return scopes.includes(OPERATOR_DIRECT_SCOPE) || scopes.includes(ADMIN_SCOPE);
}

const issued = new WeakSet<object>();
function mint(key_id: string | null, gap_id: string | null): OperatorDirectGrant {
  const g = Object.freeze({ key_id, gap_id });
  issued.add(g);
  return g;
}

/**
 * The grant for a compose of `gap_id`, when `operatorAuthorization` (the forwarded header) is a credential identity
 * validates WITH the operator-direct scope; otherwise null and why. Asked fresh every time (a directed landing is
 * rare and must see a revocation at once).
 */
export async function operatorDirectGrant(operatorAuthorization: string | null | undefined, opts: { gap_id: string | null }): Promise<{ grant: OperatorDirectGrant | null; why?: string }> {
  if (!operatorAuthorization) return { grant: null, why: `no ${OPERATOR_AUTHORIZATION_HEADER} credential` };
  const cred = await identityCredential(operatorAuthorization, { cache: false });
  if (!cred.authenticated) return { grant: null, why: cred.why ?? "not authenticated" };
  if (isNodeSelfCredential(cred)) return { grant: null, why: "the node's own key never directs" };
  if (!isOperatorDirectCredential(cred)) return { grant: null, why: `credential lacks the ${OPERATOR_DIRECT_SCOPE} scope` };
  return { grant: mint(cred.keyId ?? null, opts.gap_id ?? null) };
}

/** Tests only: a grant without asking identity. Not reachable from any request. */
export function __mintOperatorDirectGrantForTests(key_id: string | null, gap_id: string | null): OperatorDirectGrant {
  return mint(key_id, gap_id);
}

const context = new AsyncLocalStorage<OperatorDirectGrant>();

/** Run `fn` with `grant` as the operator-direct grant of everything it awaits. */
export function runWithOperatorDirectGrant<T>(grant: OperatorDirectGrant, fn: () => T): T {
  return context.run(grant, fn);
}

/** The grant of the dispatch this runs under, or null. Only a grant this module minted counts. */
export function currentOperatorDirectGrant(): OperatorDirectGrant | null {
  const g = context.getStore();
  return g && issued.has(g) ? g : null;
}

// ── A GAP ROW'S `directed` IS AN OPERATOR'S FIELD, AND IT CARRIES WHO SET IT ──────────────────────────────────────────
//
// classification_metadata.directed on a gap row makes this vessel's in-process work on it directed: the decomposer
// drops the autonomy scope for its steps and the steps inherit it (judge/gap-admission.ts, resolvers/gap-to-
// feature.ts), and a recommit child inherits it (resolvers/feature-compose.ts). Any keyed substrateGap_write could
// set it, so any key could direct a gap. Now:
//
//   - The route (routes/impulses.ts) is the one place that knows who is writing. On a substrateGap_write that claims
//     directed:true it asks identity, fresh, whether the Authorization key carries "operator:direct" (or "admin";
//     isOperatorDirectCredential above, never the node's own key), and only then sets the pointer's
//     DIRECTED_GRANT_FIELD to that principal's label. Every inbound DIRECTED_GRANT_FIELD is deleted first, so a
//     caller cannot send one.
//   - The store's one writer (resolvers/substrate-gap.ts) applies gateGapDirected before it merges: with a grant, it
//     stores directed and stamps DIRECTED_BY_FIELD with the grant; without one, an incoming `directed` (and any
//     incoming DIRECTED_BY_FIELD) is removed from the write, logged (directed_claim_stripped), and the stored values
//     carry forward unchanged. A caller without the scope can neither set nor clear an operator's direction.
//   - Readers honour directed only with its provenance: gapDirected(meta). A LEGACY row (directed:true written before
//     this, no DIRECTED_BY_FIELD) is treated as UNDIRECTED.
//   - In-process writers that propagate an already-honoured direction (a decomposed step of a directed parent, a
//     recommit child) pass the parent's DIRECTED_BY_FIELD as the grant: in-process code is trusted; the route is the
//     only external door, and it overwrites the field.
// The label names the principal by identity's key id (or its scopes), never by anything derived from the key.

/** The stored provenance of a gap's direction: the label of the operator principal that set it. */
export const DIRECTED_BY_FIELD = "directed_by";
/** The write pointer's grant (set only by the route, or by in-process code propagating an honoured direction; never stored). */
export const DIRECTED_GRANT_FIELD = "_directed_grant";

/** Whether a gap row's metadata is DIRECTED: directed:true AND the provenance stamp. A legacy directed row is not. */
export function gapDirected(meta: unknown): boolean {
  if (!meta || typeof meta !== "object") return false;
  const m = meta as Record<string, unknown>;
  const by = m[DIRECTED_BY_FIELD];
  return m["directed"] === true && typeof by === "string" && by.length > 0;
}

/** The grant an in-process writer passes on to a child it creates of an honoured directed gap. */
export function inheritedDirectedGrant(meta: unknown): string | null {
  return gapDirected(meta) ? String((meta as Record<string, unknown>)[DIRECTED_BY_FIELD]) : null;
}

/**
 * Apply the rule to one substrateGap_write pointer (enveloped `{gap}` or flat), before the store merges it. Mutates the
 * pointer: removes DIRECTED_GRANT_FIELD always; with a grant, stamps DIRECTED_BY_FIELD on a directed:true write and
 * clears it on a directed:false one; without a grant, removes `directed` and DIRECTED_BY_FIELD from the incoming
 * metadata so the stored values carry forward. Returns why a directed:true claim was stripped, or null.
 */
export function gateGapDirected(pointer: Record<string, unknown>): string | null {
  const rawGrant = pointer[DIRECTED_GRANT_FIELD];
  const grant = typeof rawGrant === "string" && rawGrant.length > 0 ? rawGrant : null;
  delete pointer[DIRECTED_GRANT_FIELD];
  const env = pointer["gap"];
  const holder = env !== undefined && env !== null && typeof env === "object" ? (env as Record<string, unknown>) : pointer;
  delete holder[DIRECTED_GRANT_FIELD];
  const cm = holder["classification_metadata"];
  if (!cm || typeof cm !== "object" || Array.isArray(cm)) return null;
  const meta = cm as Record<string, unknown>;
  const incomingBy = DIRECTED_BY_FIELD in meta;
  delete meta[DIRECTED_BY_FIELD];
  if (!("directed" in meta)) return null;
  if (grant) {
    if (meta["directed"] === true) meta[DIRECTED_BY_FIELD] = grant;
    else { meta["directed"] = false; meta[DIRECTED_BY_FIELD] = null; }
    return null;
  }
  const claimed = meta["directed"] === true;
  delete meta["directed"];
  if (!claimed) return null;
  const why = `no operator grant on this write${incomingBy ? " (a supplied directed_by is never trusted)" : ""}`;
  console.warn(`[substrate-gap] directed_claim_stripped: gap ${String(holder["id"] ?? "(no id)")} claimed directed:true with ${why}; stored without it`);
  return why;
}
