/**
 * web_resource (2026-06-28) — wire the WEB learning channel, TRUST-GATED.
 *
 * Per SUBSTRATE_AS_NETWORK: external sources cross the boundary as EVIDENCE, never
 * directly as state. So this resolver (a) fetches only from an origin the trust gate admits
 * (an unknown origin is refused, not fetched), (b) caps size and time, (c) returns the content
 * tagged trust:"external-evidence" so the rest of the substrate treats it as a low-trust impulse:
 * it can INFORM reasoning / be ingested as an (evidence-flagged) concept, but it must be verified
 * before it shapes durable state (the same discipline the reach-gate applies to the LLM and the
 * operator).
 *
 * THE GATE ADMITS A URL ONE OF TWO WAYS (2026-10-02):
 *
 *  1. SEARCH PROVENANCE — the user's ruling: "allow any https URL that a web_search in the same
 *     walk returned". The caller passes a REFERENCE, `provenance: {dispatch_id, impulse_id}`, never
 *     a claim. This resolver re-reads the referenced impulse from where it lives — a RUNNING walk's
 *     pool, through goal-host's `goalWalkState {dispatchId, impulseId}` on THIS substrate's own
 *     producers (discoverOwnResolveUrls: a peer substrate cannot vouch) — and admits the URL only
 *     when that impulse is a search result a search satisfier produced (producedBy
 *     satisfier:webSearchResult | satisfier:web_search, with a producing execution) and the URL is
 *     one of its results, exactly. A pool impulse injected through poolImpulse_write carries
 *     neither, so it cannot vouch.
 *     WHAT IS ACTUALLY VERIFIED: that the URL is in a genuine search result of ANY LIVE DISPATCH on
 *     this substrate — not that it came from the caller's own walk. The resolver knows the walk only
 *     by the dispatch_id the pointer names, so a caller can cite another running dispatch's search.
 *     The admitted set is still exactly "URLs a real web search returned"; binding the reference to
 *     the calling walk would need the caller authenticated as that walk, which nothing provides.
 *
 *  2. THE STATIC ALLOWLIST — read-only public data origins (api.open-meteo.com, ssd.jpl.nasa.gov,
 *     ...). It is the shaped policy `webResourceAllowlist`, read at USE TIME from
 *     <live super-repo clone>/policies/webResourceAllowlist.json (`{allow_domains: string[],
 *     reason}`): the ONE policy directory goal-host's shaped policies already live in
 *     (shaped-policy-store.ts resolves WORKSPACE_ROOT/policies, and goal-host's WORKSPACE_ROOT is
 *     that clone). The clone is located by write-containment's own containmentZones, and it is the
 *     zone containWrite refuses ALWAYS (no grant opens it), so no fs_write / fs_edit / code_* tool —
 *     and so no walk — can widen the list. When no usable file exists the bootstrap list below
 *     applies, unchanged from before, and the answer says so. There is deliberately NO `_write`
 *     companion: editing the list is an operator act on the volume.
 *
 * REMOVED: `pointer.allow_domains` (a caller-supplied allowlist that replaced the gate — any caller
 * could admit any domain) and the WEB_RESOURCE_ALLOWLIST env override (behaviour frozen at process
 * start, invisible to traces; law 1). A pointer that still carries allow_domains is not honoured.
 *
 * Every URL, and every redirect hop, must be https to a DNS name (no IP literal, no localhost):
 * redirects are followed by hand, at most MAX_REDIRECTS, and a hop is admitted only to the same host
 * or an allowlisted one, so an admitted URL cannot 302 the fetch somewhere the gate would refuse.
 */
import type { ResolverResult } from "./types.js";
import { readPolicyFile, shapedPolicyPath } from "../lib/signal-window.js";

const WEB_RESOURCE_ALLOWLIST_POLICY = "webResourceAllowlist";

/** The bootstrap allowlist: what applies until a webResourceAllowlist policy file is seeded. */
export const BOOTSTRAP_ALLOW_DOMAINS: readonly string[] = [
  "developer.mozilla.org",
  "docs.python.org",
  "raw.githubusercontent.com",
  "en.wikipedia.org",
  "arxiv.org",
  "nodejs.org",
  "bun.sh",
  "surrealdb.com",
  "api.open-meteo.com",
  "wttr.in",
  // 2026-08-16: the ephemeris origin (JPL Horizons) the walk kept deriving and could not reach.
  "ssd.jpl.nasa.gov",
];

export interface SearchProvenance {
  /** The goal-host dispatch whose walk pool holds the search impulse. */
  dispatch_id: string;
  /** The pool id of the webSearchResult impulse that returned the url. */
  impulse_id: string;
}

export interface WebResourcePointer {
  type: "web_resource";
  url: string;
  /** Byte cap on returned content. Default 200_000. */
  max_bytes?: number;
  /** A reference to the same-walk search result that returned `url`; verified, never trusted. */
  provenance?: SearchProvenance;
}

// ── the static allowlist: a shaped policy on the volume ────────────────────────────────────────

/**
 * The policy file, in the live super-repo clone's policies/ — write-containment's always-refused
 * zone, located by the same containmentZones every tool writer checks against (so the two can
 * never disagree about where that is). Null when this node has no super-repo clone: then the
 * bootstrap list applies, and nothing a tool can write is ever read as the policy.
 */
export function webResourceAllowlistPath(env: Record<string, string | undefined> = process.env): string | null {
  return shapedPolicyPath(WEB_RESOURCE_ALLOWLIST_POLICY, env);
}

export interface WebResourceAllowlist {
  allow_domains: string[];
  source: "policy" | "bootstrap";
  path: string | null;
  reason?: string;
  note?: string;
}

/** Read at use time. A usable file is an object whose allow_domains is an array of strings (it may
 *  be empty: an explicit "no static origins"). Absent or unusable → the bootstrap list, said so.
 *  This caller's fallback is deliberately the bootstrap list (not fail-closed), unchanged. */
export async function readWebResourceAllowlist(env: Record<string, string | undefined> = process.env): Promise<WebResourceAllowlist> {
  const f = await readPolicyFile(WEB_RESOURCE_ALLOWLIST_POLICY, env);
  const path = f.path;
  if (f.state === "no_clone" || f.state === "bad_name") return { allow_domains: [...BOOTSTRAP_ALLOW_DOMAINS], source: "bootstrap", path, note: "no live super-repo clone on this node to hold a webResourceAllowlist policy; the bootstrap list applies" };
  if (f.state === "absent" || f.state === "unreadable") return { allow_domains: [...BOOTSTRAP_ALLOW_DOMAINS], source: "bootstrap", path, note: "no webResourceAllowlist policy file; the bootstrap list applies" };
  if (f.state === "parsed") {
    const p = f.value as { allow_domains?: unknown; reason?: unknown } | null;
    if (p && typeof p === "object" && !Array.isArray(p) && Array.isArray(p.allow_domains) && p.allow_domains.every((d) => typeof d === "string")) {
      const domains = (p.allow_domains as string[]).map((d) => d.trim().toLowerCase()).filter(Boolean);
      return { allow_domains: domains, source: "policy", path, ...(typeof p.reason === "string" ? { reason: p.reason } : {}) };
    }
  }
  console.error(`[web_resource] webResourceAllowlist policy at ${path} is unusable (needs {allow_domains: string[]}) — the bootstrap list applies`);
  return { allow_domains: [...BOOTSTRAP_ALLOW_DOMAINS], source: "bootstrap", path, note: "the webResourceAllowlist policy file is unusable; the bootstrap list applies" };
}

/** The `webResourceAllowlist` read shape: the list the gate applies right now, and where it came from. */
export async function resolveWebResourceAllowlist(): Promise<ResolverResult> {
  return { shape: "webResourceAllowlist", body: await readWebResourceAllowlist() };
}

// ── search provenance: re-read the referenced impulse where it lives ───────────────────────────

const SEARCH_RESULT_SHAPES = new Set(["webSearchResult", "web_search"]);
const SEARCH_PRODUCERS = new Set(["satisfier:webSearchResult", "satisfier:web_search"]);

/** One walk-pool impulse as goal-host's goalWalkState {impulseId} serves it. */
export interface WalkImpulse {
  id: string;
  shape: string | null;
  producedBy: string | null;
  producerExecutionId: string | null;
  content: unknown;
}
export type SearchImpulseReader = (dispatchId: string, impulseId: string) => Promise<{ ok: true; impulse: WalkImpulse | null } | { ok: false; why: string }>;

/** Reads the impulse from this substrate's own goalWalkState producers (a peer cannot vouch). */
const discoveryReader: SearchImpulseReader = async (dispatchId, impulseId) => {
  const { discoverOwnResolveUrls } = await import("./gap-to-feature.js");
  const { METABOB_API_KEY } = await import("../config.js");
  const d = await discoverOwnResolveUrls("goalWalkState");
  if (!d.ok) return { ok: false, why: `goalWalkState unreadable: ${d.why}` };
  if (d.urls.length === 0) return { ok: false, why: "no own-substrate goalWalkState producer discovered" };
  for (const url of d.urls) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
        body: JSON.stringify({ impulse: { pointer: { type: "goalWalkState", dispatchId, impulseId } } }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!r.ok) continue; // 404: not this goal-host's dispatch (or impulse); ask the next
      const j = (await r.json()) as { body?: { impulse?: WalkImpulse | null } };
      if (j?.body?.impulse) return { ok: true, impulse: j.body.impulse };
    } catch { /* try the next producer */ }
  }
  return { ok: true, impulse: null };
};
let searchImpulseReader: SearchImpulseReader = discoveryReader;
/** Tests only. */
export function __setSearchImpulseReaderForTests(r: SearchImpulseReader | null): void {
  searchImpulseReader = r ?? discoveryReader;
}

function searchResultUrls(content: unknown): string[] {
  let c: unknown = content;
  if (typeof c === "string") { try { c = JSON.parse(c); } catch { return []; } }
  if (!c || typeof c !== "object") return [];
  const o = c as Record<string, unknown>;
  const results = Array.isArray(o["results"]) ? o["results"] : (o["body"] && typeof o["body"] === "object" ? (o["body"] as Record<string, unknown>)["results"] : undefined);
  if (!Array.isArray(results)) return [];
  return results.map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>)["url"] : undefined)).filter((u): u is string => typeof u === "string");
}

/** Verifies a provenance reference: null when it admits `url`, else the refusal reason. */
export async function verifySearchProvenance(url: string, provenance: unknown): Promise<string | null> {
  const p = provenance as Partial<SearchProvenance> | undefined;
  if (!p || typeof p !== "object" || typeof p.dispatch_id !== "string" || !p.dispatch_id || typeof p.impulse_id !== "string" || !p.impulse_id) {
    return "no search provenance (provenance: {dispatch_id, impulse_id} referencing the walk's web search result)";
  }
  const read = await searchImpulseReader(p.dispatch_id, p.impulse_id);
  if (!read.ok) return `search provenance unverifiable: ${read.why}`;
  const imp = read.impulse;
  if (!imp) return `search provenance not found: dispatch ${p.dispatch_id} holds no live impulse ${p.impulse_id}`;
  if (!SEARCH_RESULT_SHAPES.has(String(imp.shape ?? ""))) return `search provenance is not a search result (shape ${String(imp.shape)})`;
  if (!SEARCH_PRODUCERS.has(String(imp.producedBy ?? "")) || typeof imp.producerExecutionId !== "string" || !imp.producerExecutionId) {
    return `search provenance was not produced by a search satisfier (producedBy ${String(imp.producedBy)})`;
  }
  if (!searchResultUrls(imp.content).includes(url)) return "url is not among the referenced search result's urls";
  return null;
}

// ── the gate ────────────────────────────────────────────────────────────────────────────────────

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;
const realFetch: FetchFn = (input, init) => fetch(input, init);
let fetchImpl: FetchFn = realFetch;
/** Tests only. */
export function __setWebResourceFetchForTests(f: FetchFn | null): void {
  fetchImpl = f ?? realFetch;
}

/** An https URL to a DNS name (no IP literal, no localhost): its lower-case host, else null. */
function httpsHost(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost") || /^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return null;
  return h;
}

// Allow exact domain or a subdomain of an allowed domain.
function isAllowed(domain: string, allow: readonly string[]): boolean {
  return allow.some((a) => domain === a || domain.endsWith(`.${a}`));
}

// Rough HTML -> text: drop script/style, strip tags, collapse whitespace.
function toText(raw: string, contentType: string): string {
  if (!/html/i.test(contentType)) return raw;
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function resolveWebResource(pointer: WebResourcePointer): Promise<ResolverResult> {
  const maxBytes = pointer.max_bytes ?? 200_000;
  const url = typeof pointer.url === "string" ? pointer.url : "";
  const domain = httpsHost(url);
  const ignored = (pointer as { allow_domains?: unknown }).allow_domains !== undefined
    ? { ignored: "allow_domains is not honoured: a caller cannot widen the trust gate" }
    : {};

  // TRUST GATE: https to a DNS name only.
  if (!domain) {
    return { shape: "web_resource", body: { trust: "rejected", reason: "url must be a valid https URL to a DNS name (no IP literal or localhost)", url, ...ignored } };
  }
  const allow = await readWebResourceAllowlist();
  let admittedBy: "allowlist" | "search_provenance";
  if (isAllowed(domain, allow.allow_domains)) {
    admittedBy = "allowlist";
  } else {
    const why = await verifySearchProvenance(url, pointer.provenance);
    if (why !== null) {
      return {
        shape: "web_resource",
        body: {
          trust: "rejected",
          reason: `origin not admitted — external sources cross as evidence only, from an allowlisted origin or a url a web search in the same walk returned: ${why}`,
          domain,
          allow_domains: allow.allow_domains,
          allowlist_source: allow.source,
          ...ignored,
        },
      };
    }
    admittedBy = "search_provenance";
  }

  try {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; ; hop++) {
      res = await fetchImpl(current, { headers: { "User-Agent": "metabob-substrate-web-resource/1.0" }, signal, redirect: "manual" });
      if (res.status < 300 || res.status >= 400 || !res.headers.get("location")) break;
      const next = new URL(res.headers.get("location")!, current).href;
      const nextHost = httpsHost(next);
      if (hop + 1 > MAX_REDIRECTS || !nextHost || !(nextHost === domain || isAllowed(nextHost, allow.allow_domains))) {
        return { shape: "web_resource", body: { trust: "external-evidence", url, domain, ok: false, status: res.status, redirect_refused: next, reason: `redirect not followed: ${hop + 1 > MAX_REDIRECTS ? "too many redirects" : "the target is not https to the same or an allowlisted host"}` } };
      }
      current = next;
    }
    if (!res.ok) {
      return { shape: "web_resource", body: { trust: "external-evidence", url, domain, ok: false, status: res.status } };
    }
    const contentType = res.headers.get("content-type") ?? "";
    const raw = (await res.text()).slice(0, maxBytes * 4); // pre-strip slack; text() may exceed
    const text = toText(raw, contentType).slice(0, maxBytes);
    return {
      shape: "web_resource",
      body: {
        // EVIDENCE, not state — must be verified before it shapes durable learning.
        trust: "external-evidence",
        ok: true,
        url,
        ...(current !== url ? { final_url: current } : {}),
        domain,
        admitted_by: admittedBy,
        ...(admittedBy === "search_provenance" ? { provenance: pointer.provenance } : {}),
        content_type: contentType,
        bytes: text.length,
        content: text,
        fetched_at: new Date().toISOString(),
      },
    };
  } catch (e) {
    return { shape: "web_resource", body: { trust: "external-evidence", url, domain, ok: false, error: (e as Error).message } };
  }
}
