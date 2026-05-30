import type { ResolverResult } from "./types.js";

export interface HttpFetchPointer {
  type: "http_fetch";
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

const ALLOWED_SCHEMES = ["http:", "https:"];
const DEFAULT_MAX_BODY_BYTES = 512 * 1024; // 512 KiB
const DEFAULT_TIMEOUT_MS = 15_000;

export async function resolveHttpFetch(pointer: HttpFetchPointer): Promise<ResolverResult> {
  let parsed: URL;
  try {
    parsed = new URL(pointer.url);
  } catch {
    throw new Error(`invalid URL: ${pointer.url}`);
  }

  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    throw new Error(`URL scheme not allowed: ${parsed.protocol} (only http/https)`);
  }

  const method = pointer.method ?? "GET";
  const timeoutMs = pointer.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = pointer.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Auto-attach this vessel's METABOB_API_KEY when the target is a
  // substrate-local host AND the caller didn't already set Authorization.
  // Substrate-internal vessels (concept-db, activity-api, identity-vessel, etc.)
  // all gate writes on org_id from the resolved API key — without this, every
  // intra-substrate http_fetch silently falls through to orgId='default' and
  // sees no org-scoped data.
  const headers: Record<string, string> = { ...(pointer.headers ?? {}) };
  const apiKey = process.env["METABOB_API_KEY"];
  const isSubstrateLocal = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
  if (apiKey && isSubstrateLocal && !hasAuth) {
    headers["Authorization"] = `ApiKey ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(pointer.url, {
      method,
      headers,
      body: pointer.body ?? undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`fetch failed: ${(err as Error).message}`);
  }
  clearTimeout(timer);

  const contentType = response.headers.get("content-type") ?? "";
  const buffer = await response.arrayBuffer();
  const truncated = buffer.byteLength > maxBodyBytes;
  const sliced = truncated ? buffer.slice(0, maxBodyBytes) : buffer;
  const text = new TextDecoder().decode(sliced);

  let json: unknown = undefined;
  if (contentType.includes("application/json")) {
    try { json = JSON.parse(text); } catch { /* leave undefined */ }
  }

  return {
    shape: "httpResponse",
    body: {
      url: pointer.url,
      status: response.status,
      ok: response.ok,
      contentType,
      bodyText: text,
      bodyJson: json,
      truncated,
      byteLength: buffer.byteLength,
    },
  };
}
