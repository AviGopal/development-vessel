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
