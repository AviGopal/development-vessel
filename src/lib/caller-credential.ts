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
// gap filing into silent 401s. A POSITIVE answer is reused for VALIDATION_TTL_MS (discovery's TTL),
// keyed by a SHA-256 of the key so the raw secret is not retained. Negative answers are never
// cached, and a definitive refusal evicts. Revocation therefore takes effect within the TTL.
import { createHash } from "node:crypto";

export type CallerCredential = { authenticated: boolean; scopes: string[]; why?: string };

const VALIDATION_TTL_MS = 60_000;
const validated = new Map<string, { cred: CallerCredential; at: number }>();
const cacheKey = (apiKey: string): string => createHash("sha256").update(apiKey).digest("hex");

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
    if (hit && Date.now() - hit.at < VALIDATION_TTL_MS) return hit.cred;
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
    validated.set(k, { cred, at: Date.now() });
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
