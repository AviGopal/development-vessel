/**
 * web_resource (2026-06-28) — wire the WEB learning channel, TRUST-GATED.
 *
 * Per SUBSTRATE_AS_NETWORK: external sources cross the boundary as EVIDENCE, never
 * directly as state. So this resolver (a) fetches only from an ALLOWLIST of trusted
 * domains (the trust gate — an unknown domain is refused, not fetched), (b) caps size
 * and time, (c) returns the content tagged trust:"external-evidence" so the rest of the
 * substrate treats it as a low-trust impulse: it can INFORM reasoning / be ingested as
 * an (evidence-flagged) concept, but it must be verified before it shapes durable state
 * (the same discipline the reach-gate applies to the LLM and the operator).
 *
 * This is the channel; consumption (ingest web evidence as concepts, like the docs
 * channel; verify before trusting) is the follow-on, deliberately gated.
 */
import type { ResolverResult } from "./types.js";

const DEFAULT_ALLOW = (process.env["WEB_RESOURCE_ALLOWLIST"]?.split(",").map((s) => s.trim()).filter(Boolean)) ?? [
  "developer.mozilla.org",
  "docs.python.org",
  "raw.githubusercontent.com",
  "en.wikipedia.org",
  "arxiv.org",
  "nodejs.org",
  "bun.sh",
  "surrealdb.com",
  "api.open-meteo.com",
];

export interface WebResourcePointer {
  type: "web_resource";
  url: string;
  /** Byte cap on returned content. Default 200_000. */
  max_bytes?: number;
  /** Override the trust allowlist (domains). */
  allow_domains?: string[];
}

function domainOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

// Allow exact domain or a subdomain of an allowed domain.
function isAllowed(domain: string, allow: string[]): boolean {
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
  const allow = pointer.allow_domains ?? DEFAULT_ALLOW;
  const maxBytes = pointer.max_bytes ?? 200_000;
  const domain = domainOf(pointer.url);

  // TRUST GATE: refuse anything not from an allowlisted origin (and only https).
  if (!domain || !/^https:/i.test(pointer.url)) {
    return { shape: "web_resource", body: { trust: "rejected", reason: "url must be a valid https URL", url: pointer.url } };
  }
  if (!isAllowed(domain, allow)) {
    return {
      shape: "web_resource",
      body: { trust: "rejected", reason: "domain not in trust allowlist — external sources cross as evidence only, from trusted origins", domain, allow_domains: allow },
    };
  }

  try {
    const res = await fetch(pointer.url, {
      headers: { "User-Agent": "metabob-substrate-web-resource/1.0" },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!res.ok) {
      return { shape: "web_resource", body: { trust: "external-evidence", url: pointer.url, domain, ok: false, status: res.status } };
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
        url: pointer.url,
        domain,
        content_type: contentType,
        bytes: text.length,
        content: text,
        fetched_at: new Date().toISOString(),
      },
    };
  } catch (e) {
    return { shape: "web_resource", body: { trust: "external-evidence", url: pointer.url, domain, ok: false, error: (e as Error).message } };
  }
}
