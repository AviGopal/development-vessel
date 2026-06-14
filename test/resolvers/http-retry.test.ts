import { describe, it, expect, afterEach } from "bun:test";
import { fetchWithRetry } from "../../src/resolvers/http-retry.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("fetchWithRetry", () => {
  it("retries a transient ECONNRESET and succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) { const e = new Error("read ECONNRESET") as Error & { code?: string }; e.code = "ECONNRESET"; throw e; }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchWithRetry("http://x", {}, { attempts: 3, baseDelayMs: 1 });
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
    expect(calls).toBe(3);
  });

  it("retries the 'socket connection was closed' bun error", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 2) throw new Error("The socket connection was closed unexpectedly.");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchWithRetry("http://x", {}, { attempts: 3, baseDelayMs: 1 });
    expect(r?.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("returns null after exhausting attempts on persistent transient error", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; const e = new Error("ECONNRESET") as Error & { code?: string }; e.code = "ECONNRESET"; throw e; }) as unknown as typeof fetch;
    const r = await fetchWithRetry("http://x", {}, { attempts: 3, baseDelayMs: 1 });
    expect(r).toBeNull();
    expect(calls).toBe(3);
  });

  it("does NOT retry a 4xx — returns it directly", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("nope", { status: 404 }); }) as unknown as typeof fetch;
    const r = await fetchWithRetry("http://x", {}, { attempts: 3, baseDelayMs: 1 });
    expect(r?.status).toBe(404);
    expect(calls).toBe(1);
  });

  it("retries a 5xx then returns the eventual 200", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("{}", { status: calls < 2 ? 503 : 200 }); }) as unknown as typeof fetch;
    const r = await fetchWithRetry("http://x", {}, { attempts: 3, baseDelayMs: 1 });
    expect(r?.status).toBe(200);
    expect(calls).toBe(2);
  });
});
