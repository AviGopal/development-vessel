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
//   TODO(identity-vessel-auth-result-should-carry-a-key-id-for-audit): audit lines name the caller by
//   the key id when identity's answer carries one (keyId below, passed to callerAuthLabel), else by
//   scopes. Until every identity answer carries the id, scopes are what the audit shows. The digest
//   stays internal either way.
import { createHash, timingSafeEqual } from "node:crypto";
import dns from "node:dns";
import { isIP } from "node:net";

/** keyId: identity's id for the validated key (an identifier identity issues, not derived from the secret),
 *  when its answer carries one. Audit lines name the caller by it (routes/caller-identity.ts callerAuthLabel). */
export type CallerCredential = { authenticated: boolean; scopes: string[]; keyId?: string; why?: string };

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

/** Tests only: forget every cached validation and the loud-log window. */
export function __resetCredentialCacheForTests(): void {
  validated.clear();
  lastUnreachableLogAt = Number.NEGATIVE_INFINITY;
  lastCleartextLogAt = Number.NEGATIVE_INFINITY;
}

// THE NODE'S OWN KEY (qa R1, availability). A presented key equal to this process's METABOB_API_KEY is
// this node writing to itself (its detectors, rhythms, memory and gap filing). It is authenticated
// locally, identity never asked, so an identity outage (a spoke whose identity is the hub's) cannot
// stop the node's own self-maintenance. Every other key still needs identity and still fails closed.
// Compared in constant time over SHA-256 digests of both (equal-length buffers, so a length mismatch
// neither throws nor leaks timing). METABOB_API_KEY is read at use time, like IDENTITY_VESSEL_URL.
// The credential is one frozen object, so isNodeSelfCredential cannot be satisfied by an identity
// answer that merely carries a keyId of "node-self".
const NODE_SELF: CallerCredential = Object.freeze({ authenticated: true, scopes: Object.freeze(["node"]) as unknown as string[], keyId: "node-self" });
function isNodeKey(apiKey: string): boolean {
  const own = process.env["METABOB_API_KEY"] ?? "";
  if (!own) return false;
  const a = createHash("sha256").update(apiKey).digest();
  const b = createHash("sha256").update(own).digest();
  return timingSafeEqual(a, b);
}
/** Whether this credential is the node's own key (authenticated locally, not by identity). */
export function isNodeSelfCredential(cred: CallerCredential | null | undefined): boolean {
  return cred === NODE_SELF;
}

// LOUD, RATE-LIMITED. Identity unreachable is logged once per CREDENTIAL_VALIDATION_TTL_MS window
// (60 s), naming the identity host only, never a key or anything derived from one.
let lastUnreachableLogAt = Number.NEGATIVE_INFINITY;
function logIdentityUnreachable(base: string, detail: string): void {
  const now = Date.now();
  if (now - lastUnreachableLogAt < CREDENTIAL_VALIDATION_TTL_MS) return;
  lastUnreachableLogAt = now;
  let host = "(unparseable IDENTITY_VESSEL_URL)";
  try { host = new URL(base).host; } catch { /* keep placeholder */ }
  console.error(`[caller-credential] IDENTITY UNREACHABLE at ${host}: ${detail}. Writes from any key other than this node's own are refused (401) until identity answers.`);
}

// NO CLEARTEXT KEYS (qa R2). The presented key is POSTed to identity, so it is sent only over https, or
// over http to a host that cannot be on the public internet: loopback (127.0.0.0/8, ::1, localhost),
// RFC1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), IPv6 ULA (fc00::/7), or a
// hostname that RESOLVES (all addresses) only to those. Anything else is not asked at all: identity is
// treated as unreachable, a loud rate-limited line names the identity host (never a key), and only the
// node's own key (above) still writes.
function isPrivateV4(addr: string): boolean {
  const o = addr.split(".").map((x) => Number(x));
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = o as [number, number, number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
function isPrivateAddress(raw: string): boolean {
  const addr = raw.replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
  const kind = isIP(addr);
  if (kind === 4) return isPrivateV4(addr);
  if (kind !== 6) return false;
  if (addr === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return isPrivateV4(mapped[1]!);
  const first = parseInt(addr.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}
let lastCleartextLogAt = Number.NEGATIVE_INFINITY;
/** null when the key may be sent to `base`; otherwise why not (naming the host only). */
async function cleartextRefusal(base: string): Promise<string | null> {
  let url: URL;
  try { url = new URL(base); } catch { return "IDENTITY_VESSEL_URL is not a URL"; }
  if (url.protocol === "https:") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let refusal: string | null = null;
  if (url.protocol !== "http:") refusal = `scheme ${url.protocol} is neither https nor http`;
  else if (host.toLowerCase() === "localhost") refusal = null;
  else if (isIP(host)) refusal = isPrivateAddress(host) ? null : "host is a public address over plain http";
  else {
    try {
      const addrs = (await dns.promises.lookup(host, { all: true })) as Array<{ address: string }>;
      refusal = addrs.length > 0 && addrs.every((a) => isPrivateAddress(a.address)) ? null : "host resolves to a public address over plain http";
    } catch (err) {
      refusal = `host does not resolve (${String((err as { code?: string })?.code ?? "lookup failed")}), so it cannot be shown private`;
    }
  }
  if (refusal) {
    const now = Date.now();
    if (now - lastCleartextLogAt >= CREDENTIAL_VALIDATION_TTL_MS) {
      lastCleartextLogAt = now;
      console.error(`[caller-credential] REFUSED to send a credential in cleartext to identity at ${url.host}: ${refusal}. Identity is treated as unreachable; writes from any key other than this node's own are refused (401). Use https or a private address.`);
    }
  }
  return refusal;
}

const identityUrl = (): string => (process.env["IDENTITY_VESSEL_URL"] ?? "").trim().replace(/\/+$/, "");

/** What identity-vessel says about `authHeader`. `cache:false` asks identity every time. */
export async function identityCredential(authHeader: string | undefined, opts: { cache?: boolean } = {}): Promise<CallerCredential> {
  const m = /^ApiKey\s+(\S+)$/i.exec(String(authHeader ?? "").trim());
  if (!m) return { authenticated: false, scopes: [], why: "no ApiKey credential presented" };
  const apiKey = m[1]!;
  if (isNodeKey(apiKey)) return NODE_SELF;
  const useCache = opts.cache !== false;
  const k = cacheKey(apiKey);
  if (useCache) {
    const hit = validated.get(k);
    if (hit && Date.now() - hit.at < CREDENTIAL_VALIDATION_TTL_MS) return hit.cred;
    if (hit) validated.delete(k);
  }
  const base = identityUrl();
  if (!base) return { authenticated: false, scopes: [], why: "IDENTITY_VESSEL_URL unset: identity cannot be asked" };
  const refusal = await cleartextRefusal(base);
  if (refusal) return { authenticated: false, scopes: [], why: `identity unreachable: cleartext refused (${refusal})` };
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
    const j = (await res.json()) as { success?: boolean; data?: { authenticated?: boolean; scopes?: unknown; keyId?: unknown; key_id?: unknown } };
    if (j?.data?.authenticated !== true) {
      validated.delete(k);
      return { authenticated: false, scopes: [], why: "credential not authenticated" };
    }
    const scopes = Array.isArray(j.data.scopes) ? j.data.scopes.map(String) : [];
    const rawKeyId = j.data.keyId ?? j.data.key_id;
    const cred: CallerCredential = { authenticated: true, scopes, ...(typeof rawKeyId === "string" && rawKeyId ? { keyId: rawKeyId } : {}) };
    remember(k, cred);
    return cred;
  } catch (err) {
    const detail = String((err as Error)?.message ?? err);
    logIdentityUnreachable(base, detail);
    return { authenticated: false, scopes: [], why: "identity unreachable: " + detail };
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
