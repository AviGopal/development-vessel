import type { ResolverResult } from "./types.js";

export interface HttpFetchPointer {
  type: "http_fetch";
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  /**
   * If true, non-2xx responses throw with a structured message instead of
   * being returned as `httpResponse` impulses with `ok: false`. Default
   * false — most existing seed templates (probes, health checks, drift
   * detectors) treat 4xx/5xx as DATA and rely on the swallow behavior.
   * Opt in when the caller is a write that should fail loudly on error
   * (e.g. POSTing a concept create_write and wanting a malformed body
   * to surface as task failure, not silent success).
   */
  failOnNon2xx?: boolean;
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
  //
  // V28 (2026-06-09): GATED to mutating methods only. activity-api's
  // /v2/activities/execution-traces GET path hangs when Authorization is
  // supplied (auth middleware → identity-vessel callback that doesn't return
  // within the 15s default), but serves the same request in <100ms without
  // auth. Substrate-authored gap-closing variants all fetch traces via
  // http_fetch GET — every variant's TASK 1 was timing out at the auth step.
  // Mutations (POST/PUT/PATCH/DELETE) still get auth so the org-gating
  // invariants remain satisfied; reads on substrate-internal endpoints go
  // unauthenticated and rely on the endpoint's own public-read policy.
  const headers: Record<string, string> = { ...(pointer.headers ?? {}) };
  const apiKey = process.env["METABOB_API_KEY"];
  const isSubstrateLocal = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
  const isMutation = method !== "GET" && method !== "HEAD";
  if (apiKey && isSubstrateLocal && !hasAuth && isMutation) {
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

  // Non-2xx swallow is the historical default — many seed templates (probes,
  // mechanism-health-tick, detect-*) treat 4xx/5xx as data. Opt-in surfacing
  // via failOnNon2xx for writes that should fail loudly (e.g. concept_create
  // POSTs where a 400 indicates a malformed body and the task should not
  // silently succeed). See HttpFetchPointer.failOnNon2xx docstring.
  if (!response.ok && pointer.failOnNon2xx) {
    const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;
    throw new Error(
      `http_fetch ${method} ${pointer.url} → ${response.status}: ${preview}`,
    );
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
