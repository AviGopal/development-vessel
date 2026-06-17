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

  const timer = setTimeout(() => {}, timeoutMs);

  // Auto-attach this vessel's METABOB_API_KEY when the target is a
  // substrate-local host AND the caller didn't already set Authorization.
  // Substrate-internal vessels (concept-db, activity-api, identity-vessel, etc.)
  // all gate writes on org_id from the resolved API key — without this, every
  // intra-substrate http_fetch silently falls through to orgId='default' and
  // sees no org-scoped data.
  //
  // V28 (2026-06-09) gated auth to mutations only, on the premise that
  // activity-api's /v2/activities/execution-traces GET HUNG (>15s) with
  // Authorization but served in <100ms without it. V36 (2026-06-17): that
  // premise is now FALSE on both counts — the endpoint became auth-required
  // (no-auth GET returns 401 MISSING_AUTH instantly) and the authed path
  // returns in ~9s (< the 15s default timeout), after the execution-traces
  // datetime-index perf fix. The mutation-only gate therefore SILENTLY BROKE
  // the gap-closing drafter: its TASK "fetch_traces" got 401, so the analysis
  // LLM produced "AUTHENTICATION_BARRIER / INCOMPLETE" reports instead of
  // actionable patch_proposals → apply-proposal-as-patch saw nothing eligible
  // → autonomous landing throughput went to zero. Reads need org-scoping auth
  // too. Send auth on substrate-local requests regardless of method; a target
  // that prefers anonymous reads simply ignores the header.
  const headers: Record<string, string> = { ...(pointer.headers ?? {}) };
  const apiKey = process.env["METABOB_API_KEY"];
  const isSubstrateLocal = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
  if (apiKey && isSubstrateLocal && !hasAuth) {
    headers["Authorization"] = `ApiKey ${apiKey}`;
  }

  // Retry idempotent reads on transient transport drops. Substrate-internal
  // endpoints (notably the ~6s execution-traces GET the gap-closing drafter
  // depends on) intermittently reset the connection ("socket connection was
  // closed unexpectedly" / ECONNRESET) under concurrent load — a single
  // un-retried fetch fails ~1-in-6, which silently fails that many drafter
  // runs. Only GET/HEAD are retried; mutations must not double-apply.
  const isTransient = (err: unknown): boolean => {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    const code = (err as { code?: string })?.code ?? "";
    return (
      code === "ECONNRESET" || code === "ETIMEDOUT" ||
      msg.includes("socket connection") || msg.includes("econnreset") ||
      msg.includes("connection closed") || msg.includes("closed unexpectedly")
    );
  };
  const retryable = method === "GET" || method === "HEAD";
  const maxAttempts = retryable ? 3 : 1;
  let response: Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attemptController = new AbortController();
    const attemptTimer = setTimeout(() => attemptController.abort(), timeoutMs);
    try {
      response = await fetch(pointer.url, {
        method,
        headers,
        body: pointer.body ?? undefined,
        signal: attemptController.signal,
      });
      clearTimeout(attemptTimer);
      break;
    } catch (err) {
      clearTimeout(attemptTimer);
      lastErr = err;
      if (!retryable || !isTransient(err) || attempt === maxAttempts - 1) {
        clearTimeout(timer);
        throw new Error(`fetch failed: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
  }
  clearTimeout(timer);
  if (!response) {
    throw new Error(`fetch failed: ${(lastErr as Error)?.message ?? "no response"}`);
  }

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
