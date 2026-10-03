/**
 * CALLER IDENTITY FOR AUDIT LINES (2026-10-03).
 *
 * Names WHO made a request without carrying anything derived from its secret. A hash, digest or prefix of a
 * presented key is linkable across logs and, for a low-entropy or leaked key, a confirm-oracle, so it never
 * appears in a record, log or row. The label is the identity that VALIDATED the request: the identity-vessel
 * key id or name when the auth result carries one, its scopes when it carries only those, "authenticated"
 * when it carries neither, and "unauthenticated" when there is no successful auth result. The resolve route
 * passes the credential its write gate validated (lib/caller-credential.ts); an in-process write has none.
 */
/** node_self: the request carried this node's own key (lib/caller-credential.ts), authenticated locally. */
export type CallerAuthResult = { authenticated?: boolean; node_self?: boolean; key_id?: unknown; key_name?: unknown; scopes?: unknown };

const SAFE = /^[A-Za-z0-9._:@-]{1,128}$/;

export function callerAuthLabel(auth: CallerAuthResult | null | undefined): string {
  if (!auth || auth.authenticated !== true) return "unauthenticated";
  if (auth.node_self === true) return "authenticated:node-self";
  if (typeof auth.key_id === "string" && SAFE.test(auth.key_id)) return `authenticated:key_id:${auth.key_id}`;
  if (typeof auth.key_name === "string" && SAFE.test(auth.key_name)) return `authenticated:key_name:${auth.key_name}`;
  const scopes = Array.isArray(auth.scopes) ? auth.scopes.filter((s): s is string => typeof s === "string" && SAFE.test(s)) : [];
  return scopes.length > 0 ? `authenticated:${scopes.join(",")}` : "authenticated";
}
