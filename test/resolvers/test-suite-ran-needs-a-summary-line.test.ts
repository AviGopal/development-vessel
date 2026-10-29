// test_suite's `ran` means bun printed its summary, recognised by parseBunSummary's own rule: a count at the START of a
// line. Measured on both nodes: the pre-cutover suite, killed by its 240 s budget before bun's summary, still carried
// "N pass" mid-line in some test's output, so the resolver read ran:true with 0 tests counted ("ran but measured 0
// tests") instead of did-not-run. The shell output reaches the resolver through the stubbed shell transport.
import { describe, expect, test } from "bun:test";
import { resolveTestSuite } from "../../src/resolvers/test-suite.js";

async function resolveWith(stdout: string): Promise<Record<string, unknown>> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("vesselCapability")) {
      return new Response(JSON.stringify({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } }), { status: 200 });
    }
    if (String(input).startsWith("http://shell.test")) return new Response(JSON.stringify({ stdout }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const r = await resolveTestSuite({ type: "test_suite", vessel: "development-vessel" });
    expect(r.shape).toBe("test_suite");
    return r.body as Record<string, unknown>;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// A whole-suite run cut off by `timeout`: per-test lines and test logging, no summary block.
const KILLED = [
  "VERIFIED_ROOT=/workspace/git/vessels/development-vessel",
  "VERIFIED_HEAD=c4a672d7",
  "bun test v1.3.14",
  "test/resolvers/a.test.ts:",
  "(pass) a > first [1.20ms]",
  "[gap-check-supply] arm verdict: 3 pass, 1 fail across mutants",
  "(pass) a > second [0.40ms]",
  "",
].join("\n");

describe("test_suite: ran needs bun's summary line", () => {
  test("[MUST-FAIL] a killed run whose output carries a mid-line \"3 pass\" is not ran", async () => {
    const b = await resolveWith(KILLED);
    expect(b["ran"]).toBe(false);
    expect(b["pass"]).toBe(0);
    expect(b["fail"]).toBe(0);
  });

  test("[CONTROL] a real bun summary still parses: ran with its counts", async () => {
    const b = await resolveWith(KILLED + " 12 pass\n 1 fail\n 40 expect() calls\nRan 13 tests across 2 files. [3.10s]\n");
    expect(b["ran"]).toBe(true);
    expect(b["pass"]).toBe(12);
    expect(b["fail"]).toBe(1);
    expect(b["total"]).toBe(13);
  });

  test("[CONTROL] a summary with only failures is ran", async () => {
    const b = await resolveWith(" 0 pass\n 1 fail\nRan 1 test across 1 file. [5.00ms]\n");
    expect(b["ran"]).toBe(true);
    expect(b["fail"]).toBe(1);
  });
});
