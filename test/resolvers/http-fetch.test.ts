import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { resolveHttpFetch } from "../../src/resolvers/http-fetch.js";

// Stub globalThis.fetch to avoid real network in tests.
function makeFetchStub(
  status: number,
  body: string,
  contentType = "application/json",
): typeof fetch {
  const stub = async () =>
    new Response(body, { status, headers: { "content-type": contentType } });
  return stub as unknown as typeof fetch;
}

describe("http-fetch resolver", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns httpResponse shape on successful GET", async () => {
    globalThis.fetch = makeFetchStub(200, JSON.stringify({ status: "ok" }));
    const result = await resolveHttpFetch({ type: "http_fetch", url: "http://localhost/health" });
    expect(result.shape).toBe("httpResponse");
    const body = result.body as { status: number; ok: boolean; bodyJson: { status: string } };
    expect(body.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.bodyJson.status).toBe("ok");
  });

  it("marks ok:false for 4xx responses", async () => {
    globalThis.fetch = makeFetchStub(404, "not found", "text/plain");
    const result = await resolveHttpFetch({ type: "http_fetch", url: "http://localhost/missing" });
    const body = result.body as { ok: boolean; status: number };
    expect(body.ok).toBe(false);
    expect(body.status).toBe(404);
  });

  it("truncates large bodies", async () => {
    const big = "x".repeat(600 * 1024);
    globalThis.fetch = makeFetchStub(200, big, "text/plain");
    const result = await resolveHttpFetch({
      type: "http_fetch",
      url: "http://localhost/big",
      maxBodyBytes: 100,
    });
    const body = result.body as { truncated: boolean; bodyText: string };
    expect(body.truncated).toBe(true);
    expect(body.bodyText.length).toBe(100);
  });

  it("rejects non-http/https schemes", async () => {
    await expect(
      resolveHttpFetch({ type: "http_fetch", url: "file:///etc/passwd" }),
    ).rejects.toThrow("URL scheme not allowed");
  });

  it("rejects invalid URLs", async () => {
    await expect(
      resolveHttpFetch({ type: "http_fetch", url: "not-a-url" }),
    ).rejects.toThrow("invalid URL");
  });

  // V36 (2026-06-17): auth is attached to substrate-local requests regardless of
  // method (was previously mutation-only, which 401'd the gap-closing drafter's
  // GET of execution-traces and zeroed autonomous landing throughput).
  function captureHeadersStub(): { calls: Array<Record<string, string>>; fetch: typeof fetch } {
    const calls: Array<Record<string, string>> = [];
    const stub = async (_url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ ...(init?.headers ?? {}) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { calls, fetch: stub as unknown as typeof fetch };
  }

  it("attaches Authorization on a substrate-local GET when METABOB_API_KEY is set", async () => {
    const prev = process.env["METABOB_API_KEY"];
    process.env["METABOB_API_KEY"] = "test-key-123";
    try {
      const cap = captureHeadersStub();
      globalThis.fetch = cap.fetch;
      await resolveHttpFetch({
        type: "http_fetch",
        url: "http://127.0.0.1:8080/v2/activities/execution-traces?limit=5",
        method: "GET",
      });
      const hdrs = cap.calls[0] ?? {};
      const authKey = Object.keys(hdrs).find((k) => k.toLowerCase() === "authorization");
      expect(authKey).toBeDefined();
      expect(hdrs[authKey as string]).toBe("ApiKey test-key-123");
    } finally {
      if (prev === undefined) delete process.env["METABOB_API_KEY"]; else process.env["METABOB_API_KEY"] = prev;
    }
  });

  it("does NOT attach Authorization on a non-substrate-local GET", async () => {
    const prev = process.env["METABOB_API_KEY"];
    process.env["METABOB_API_KEY"] = "test-key-123";
    try {
      const cap = captureHeadersStub();
      globalThis.fetch = cap.fetch;
      await resolveHttpFetch({ type: "http_fetch", url: "https://example.com/data", method: "GET" });
      const hdrs = cap.calls[0] ?? {};
      expect(Object.keys(hdrs).some((k) => k.toLowerCase() === "authorization")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env["METABOB_API_KEY"]; else process.env["METABOB_API_KEY"] = prev;
    }
  });

  it("respects a caller-supplied Authorization header (no override)", async () => {
    const prev = process.env["METABOB_API_KEY"];
    process.env["METABOB_API_KEY"] = "test-key-123";
    try {
      const cap = captureHeadersStub();
      globalThis.fetch = cap.fetch;
      await resolveHttpFetch({
        type: "http_fetch",
        url: "http://127.0.0.1:8080/x",
        method: "GET",
        headers: { Authorization: "Bearer caller-token" },
      });
      expect(cap.calls[0]?.["Authorization"]).toBe("Bearer caller-token");
    } finally {
      if (prev === undefined) delete process.env["METABOB_API_KEY"]; else process.env["METABOB_API_KEY"] = prev;
    }
  });
});
