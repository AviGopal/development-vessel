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
});
