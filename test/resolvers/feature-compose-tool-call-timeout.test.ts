// A LONG TOOL CALL IS NOT CUT BY BUN'S DEFAULT FETCH TIMEOUT, AND THE CLIENT WAITS AS LONG AS IT ASKED THE TOOL TO RUN.
//
// feature_compose's callTool passed only `signal: AbortSignal.timeout(600_000)` and never Bun's `timeout: false`, so
// Bun's own ~300 s default cut every long call: a clean-typechecking compose whose verify (which asks the shell for
// timeout_sec 720) ran longer came back with empty output, read as an uncharged environment non-attempt. The fixed
// 600 s signal would also have aborted it before the shell's own 720 s kill. test_suite's runner call to the same
// shell producer (suites up to 900 s) had the same cut.
//
// Only the fetch init is read here (a stub captures it, and AbortSignal.timeout's argument is recorded): no socket
// is held open for minutes.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { __resetDiscoveryForTests } from "../../src/config.js";

const fc = await import("../../src/resolvers/feature-compose.js") as Record<string, unknown>;
const { resolveTestSuite } = await import("../../src/resolvers/test-suite.js");

type Init = RequestInit & { timeout?: unknown };
const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
let calls: Array<{ url: string; init: Init; signalMs: number | null }> = [];
let lastSignalMs: number | null = null;

beforeEach(() => {
  calls = [];
  lastSignalMs = null;
  AbortSignal.timeout = ((ms: number) => { lastSignalMs = ms; return originalTimeout.call(AbortSignal, ms); }) as typeof AbortSignal.timeout;
  globalThis.fetch = (async (input: unknown, init?: Init) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    calls.push({ url, init: init ?? {}, signalMs: lastSignalMs });
    lastSignalMs = null;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if ((body?.pointer ?? body?.impulse?.pointer)?.type === "vesselCapability") {
      return Response.json({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } });
    }
    return Response.json({ stdout: "VERIFIED_ROOT=/x\n1 pass\n0 fail\n" });
  }) as unknown as typeof fetch;
  __resetDiscoveryForTests();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  __resetDiscoveryForTests();
});

const callTool = (...a: [string, string, Record<string, unknown>]): Promise<{ ok: boolean }> =>
  (fc["callTool"] as (e: string, t: string, x: Record<string, unknown>) => Promise<{ ok: boolean }>)(...a);

describe("feature_compose callTool", () => {
  it("[MUST-FAIL] a shell verify asking for timeout_sec 720 is sent with timeout:false and a signal of at least 780 s", async () => {
    expect(typeof fc["callTool"]).toBe("function");
    const r = await callTool("http://tools.test/v2/impulses/resolve", "shell", { command: "true", cwd: "/", timeout_sec: 720 });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.init.timeout).toBe(false);
    expect(calls[0]!.signalMs).not.toBeNull();
    expect(calls[0]!.signalMs!).toBeGreaterThanOrEqual(780_000);
    expect(JSON.parse(String(calls[0]!.init.body)).impulse.pointer.timeout_sec).toBe(720);
  });

  it("[CONTROL] a short call keeps a bounded signal, longer than what it asked the tool for and within the per-call cap; a call naming no timeout_sec keeps the cap", async () => {
    await callTool("http://tools.test/v2/impulses/resolve", "shell", { command: "true", cwd: "/", timeout_sec: 30 });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.signalMs!).toBeGreaterThan(30_000);
    expect(calls[0]!.signalMs!).toBeLessThanOrEqual(600_000);
    await callTool("http://tools.test/v2/impulses/resolve", "read_file", { path: "/x" });
    expect(calls[1]!.signalMs).toBe(600_000);
    expect(JSON.parse(String(calls[1]!.init.body)).impulse.pointer.timeout_sec).toBeUndefined();
  });
});

describe("test_suite's runner call to the shell producer", () => {
  it("[MUST-FAIL] the shell call is sent with timeout:false, bounded by its signal", async () => {
    await resolveTestSuite({ type: "test_suite", vessel: "repos/fixture-vessel", test_file: "test/x.test.ts", timeout_ms: 600_000 } as never);
    const shell = calls.filter((c) => c.url.startsWith("http://shell.test"));
    expect(shell.length).toBe(1);
    expect(shell[0]!.init.timeout).toBe(false);
    expect(shell[0]!.signalMs).toBe(630_000);
  });
});
