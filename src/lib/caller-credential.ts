// WHO IS CALLING: the one place this vessel asks identity-vessel about a caller's credential.
//
// identity-vessel is the single validator (POST /v1/auth/resolve, the contract discovery-vessel's
// auth middleware and activity-api's validateApiKeyWithFallback use). pool-impulse.ts's
// operatorCredential (the trust-root admin check) and the resolve route's write gate both ask
// through identityCredential below, so there is one request shape and one set of failure reasons.
//
// WRITES ARE AUTHENTICATED. A write-type pointer (isWritePointerType) reaching the HTTP resolve
// route must carry `Authorization: ApiKey <key>` that identity authenticates. Reads are not gated
// here: that is a separate decision.
//
// FAIL CLOSED. No header, a non-ApiKey scheme, identity's refusal, identity answering non-2xx,
// identity unreachable, or IDENTITY_VESSEL_URL unset: each is "not authenticated". There is no
// grace window and no exemption by source address (rootless port forwarding can make an external
// caller look local).
//
// CACHE. identity rate-limits /v1/auth/resolve per (source IP, key prefix), and every in-container
// writer shares 127.0.0.1 and the fleet key, so asking per request would rate-limit the fleet's own
// gap filing into silent 401s. A POSITIVE answer is reused for CREDENTIAL_VALIDATION_TTL_MS
// (discovery's TTL). Negative answers (a refused key, identity erroring or unreachable) are never
// cached, and a definitive refusal evicts.
//   REVOCATION LAG IS AT MOST THE TTL (60 s): a key identity revokes keeps passing this gate from
//   cache until its entry is CREDENTIAL_VALIDATION_TTL_MS old, then the next request asks identity
//   and is refused. There is no grace window beyond that.
//   BOUNDED: at most CREDENTIAL_CACHE_MAX_ENTRIES entries; inserting past the cap evicts the oldest
//   validation first, so a flood of distinct valid keys cannot grow the map without limit.
//   THE DIGEST IS A LOOKUP KEY ONLY. The map is keyed by SHA-256 of the presented key so the raw
//   secret is not retained; the digest never leaves process memory: it is not logged, traced,
//   persisted, returned in an error, or exposed through /health, /metrics or any export of this
//   module.
//   TODO(identity-vessel-auth-result-should-carry-a-key-id-for-audit): once identity's auth result
//   carries the key id, audit lines name the caller by that id. The digest stays internal.
import { createHash } from "node:crypto";

export type CallerCredential = { authenticated: boolean; scopes: string[]; why?: string };

export const CREDENTIAL_VALIDATION_TTL_MS = 60_000;
export const CREDENTIAL_CACHE_MAX_ENTRIES = 256;
const validated = new Map<string, { cred: CallerCredential; at: number }>();
const cacheKey = (apiKey: string): string => createHash("sha256").update(apiKey).digest("hex");
/** Insert (or refresh) an entry; past the cap, evict the oldest validation first (Map keeps insertion order). */
function remember(k: string, cred: CallerCredential): void {
  validated.delete(k);
  validated.set(k, { cred, at: Date.now() });
  while (validated.size > CREDENTIAL_CACHE_MAX_ENTRIES) {
    const oldest = validated.keys().next().value;
    if (oldest === undefined) break;
    validated.delete(oldest);
  }
}

/** Tests only: forget every cached validation. */
export function __resetCredentialCacheForTests(): void {
  validated.clear();
}

const identityUrl = (): string => (process.env["IDENTITY_VESSEL_URL"] ?? "").trim().replace(/\/+$/, "");

/** What identity-vessel says about `authHeader`. `cache:false` asks identity every time. */
export async function identityCredential(authHeader: string | undefined, opts: { cache?: boolean } = {}): Promise<CallerCredential> {
  const m = /^ApiKey\s+(\S+)$/i.exec(String(authHeader ?? "").trim());
  if (!m) return { authenticated: false, scopes: [], why: "no ApiKey credential presented" };
  const apiKey = m[1]!;
  const useCache = opts.cache !== false;
  const k = cacheKey(apiKey);
  if (useCache) {
    const hit = validated.get(k);
    if (hit && Date.now() - hit.at < CREDENTIAL_VALIDATION_TTL_MS) return hit.cred;
    if (hit) validated.delete(k);
  }
  const base = identityUrl();
  if (!base) return { authenticated: false, scopes: [], why: "IDENTITY_VESSEL_URL unset: identity cannot be asked" };
  try {
    const res = await fetch(`${base}/v1/auth/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ impulse: { type: "authentication", pointer: { type: "apiKey", apiKey } } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) validated.delete(k);
      return { authenticated: false, scopes: [], why: `identity answered HTTP ${res.status}` };
    }
    const j = (await res.json()) as { success?: boolean; data?: { authenticated?: boolean; scopes?: unknown } };
    if (j?.data?.authenticated !== true) {
      validated.delete(k);
      return { authenticated: false, scopes: [], why: "credential not authenticated" };
    }
    const scopes = Array.isArray(j.data.scopes) ? j.data.scopes.map(String) : [];
    const cred: CallerCredential = { authenticated: true, scopes };
    remember(k, cred);
    return cred;
  } catch (err) {
    return { authenticated: false, scopes: [], why: "identity unreachable: " + String((err as Error)?.message ?? err) };
  }
}

// THE GATED SET. Every `*_write` shape (gap, memory, pool, lease, policy, concept, ui and
// interactor records) and the primitives that change files, git, GitHub, units, the database or
// the running tree. http_fetch is here because it attaches this vessel's own fleet key to loopback
// targets: left open, an unauthenticated caller could have it re-post any gated write to this
// route with the vessel's credential.
export const MUTATING_PRIMITIVES: ReadonlySet<string> = new Set([
  "fs_write", "fs_edit",
  "git_add", "git_commit", "git_push", "git_branch_create",
  "gh_pr_create", "gh_pr_merge", "gh_repo_create",
  "patch_with_tools", "apply_proposal_as_patch",
  "systemd_restart", "pull_cutover", "surrealdb_import", "activate_substrate_script", "vessel_mitosis_cutover",
  "http_fetch",
]);

/** Whether a pointer of this type writes, and so must carry an authenticated credential. */
export function isWritePointerType(type: string): boolean {
  return type.endsWith("_write") || MUTATING_PRIMITIVES.has(type);
}
