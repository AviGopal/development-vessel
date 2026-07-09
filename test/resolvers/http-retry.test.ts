import { describe, it, expect, afterEach } from "bun:test";
import { fetchWithRetry, __resetMaintenanceLeaseCacheForTests } from "../../src/resolvers/http-retry.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";

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

describe("fetchWithRetry — pausable-citizen guard (maintenance lease)", () => {
  const leasePath = join(tmpdir(), `dev-vessel-http-retry-lease-test-${Date.now()}.json`);

  afterEach(async () => {
    delete process.env["MAINTENANCE_LEASE_PATH"];
    __resetMaintenanceLeaseCacheForTests();
    await rm(leasePath, { force: true });
  });

  it("skips (returns null) a trace-store read when an unexpired lease is held", async () => {
    process.env["MAINTENANCE_LEASE_PATH"] = leasePath;
    await writeFile(
      leasePath,
      JSON.stringify({
        holder: "trace-store-reconcile",
        token: "abc123",
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    __resetMaintenanceLeaseCacheForTests();

    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;

    const r = await fetchWithRetry("http://127.0.0.1:8080/v2/activities/execution-traces?limit=10");
    expect(r).toBeNull();
    expect(calls).toBe(0);
  });

  it("proceeds with the fetch when the lease is expired", async () => {
    process.env["MAINTENANCE_LEASE_PATH"] = leasePath;
    await writeFile(
      leasePath,
      JSON.stringify({
        holder: "trace-store-reconcile",
        token: "abc123",
        acquired_at: new Date(Date.now() - 120_000).toISOString(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    __resetMaintenanceLeaseCacheForTests();

    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    const r = await fetchWithRetry("http://127.0.0.1:8080/v2/activities/execution-traces?limit=10");
    expect(r?.status).toBe(200);
  });

  it("proceeds with the fetch when the lease file is missing", async () => {
    process.env["MAINTENANCE_LEASE_PATH"] = leasePath; // does not exist
    __resetMaintenanceLeaseCacheForTests();

    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    const r = await fetchWithRetry("http://127.0.0.1:8080/v2/activities/execution-traces?limit=10");
    expect(r?.status).toBe(200);
  });

  it("proceeds with the fetch when the lease file is corrupt JSON (fail open)", async () => {
    process.env["MAINTENANCE_LEASE_PATH"] = leasePath;
    await writeFile(leasePath, "{ not valid json");
    __resetMaintenanceLeaseCacheForTests();

    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    const r = await fetchWithRetry("http://127.0.0.1:8080/v2/activities/execution-traces?limit=10");
    expect(r?.status).toBe(200);
  });

  it("does not apply the guard to a non-trace-store URL even with a held lease", async () => {
    process.env["MAINTENANCE_LEASE_PATH"] = leasePath;
    await writeFile(
      leasePath,
      JSON.stringify({
        holder: "trace-store-reconcile",
        token: "abc123",
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    __resetMaintenanceLeaseCacheForTests();

    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;

    const r = await fetchWithRetry("http://127.0.0.1:8080/v2/activities/templates?limit=10");
    expect(r?.status).toBe(200);
    expect(calls).toBe(1);
  });
});
