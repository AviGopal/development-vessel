// Per-resolver test for `test_suite` (R8.1: one test file per resolver).
//
// This resolver is the IN-BAND replacement for out-of-band post-landing verification.
// External CI runs in no vessel, produces no trace, and delivers its outcome through an
// env-gated webhook; host-pull-sync.sh detects regressions but writes only an operator log.
// Neither emits a shape, so no post-landing outcome was ever observable to the learning
// loop — which is why the fitness of a landed change could not be computed from activity
// outcomes.
//
// The previous version of this file asserted the resolver's original contract (call with a
// bare pointer, get a report). Those two tests had NEVER passed: the old implementation
// fetched /api/test-store/summaries, an endpoint that exists nowhere in the fleet, so every
// call threw. They are replaced here with tests of the contract that actually runs.
import { describe, expect, it, test } from "bun:test";
import { parseBunSummary, resolveTestSuite } from "../../src/resolvers/test-suite.js";

describe("parseBunSummary", () => {
  const REAL = ` 155 pass\n 4 fail\n 321 expect() calls\nRan 159 tests across 7 files. [232.00ms]`;

  it("reads counts from bun's summary lines", () => {
    const r = parseBunSummary(REAL);
    expect(r.pass).toBe(155);
    expect(r.fail).toBe(4);
    expect(r.total).toBe(159);
  });

  it("handles a summary carrying skip/todo lines", () => {
    const r = parseBunSummary(` 7 skip\n 5 todo\n 152 fail\n 82 pass\n`);
    expect(r.pass).toBe(82);
    expect(r.fail).toBe(152);
    expect(r.skip).toBe(7);
  });

  // The load-bearing property. A suite that fails to LOAD emits FEWER per-test lines, not
  // more, so counting (fail) lines cannot distinguish "tests were fixed" from "tests were
  // deleted or the module stopped importing". Reading `pass` from the summary is what
  // catches coverage disappearing — the cheapest way for an autonomous draft to go green.
  it("surfaces a COLLAPSED pass count instead of inferring health from few failures", () => {
    const collapsed = parseBunSummary(` 0 pass\n 1 fail\n`);
    expect(collapsed.pass).toBe(0);
    expect(collapsed.pass).toBeLessThan(parseBunSummary(REAL).pass);
    // Strictly FEWER failures than the 4-fail baseline, yet plainly worse.
    expect(collapsed.fail).toBeLessThan(parseBunSummary(REAL).fail);
  });

  it("collects failing test names with bun's timing suffix stripped", () => {
    const r = parseBunSummary(`(fail) repairSignatureOf > is deterministic [0.11ms]\n 1 pass\n 1 fail\n`);
    expect(r.failingTests).toEqual(["(fail) repairSignatureOf > is deterministic"]);
  });

  // bun prints each failure twice — inline, then again in the summary block. Without
  // dedupe, 9 real failures were reported as 18, overstating a regression to whatever reads
  // this shape.
  it("deduplicates failures that bun prints twice", () => {
    const dup = `(fail) a > one [0.1ms]\n(fail) b > two [0.2ms]\n 5 pass\n 2 fail\n(fail) a > one [0.1ms]\n(fail) b > two [0.2ms]\n`;
    const r = parseBunSummary(dup);
    expect(r.failingTests).toEqual(["(fail) a > one", "(fail) b > two"]);
    expect(r.fail).toBe(2);
  });

  it("returns zeros when the output carries no summary at all", () => {
    const r = parseBunSummary("bun: command not found");
    expect(r).toMatchObject({ total: 0, pass: 0, fail: 0, skip: 0 });
    expect(r.failingTests).toEqual([]);
  });
});

test("resolveTestSuite refuses without a vessel rather than reporting an empty suite", async () => {
  // Reporting 0/0/0 for a missing target would be indistinguishable from a clean run —
  // the same 'absence reads as success' defect this resolver exists to close.
  const result = await resolveTestSuite({ type: "test_suite" });
  expect(result).toHaveProperty("shape", "structuredError");
});

// ---- Isolation re-run filter (2026-08-29) ----
//
// `only_tests` exists for the precutover regression gate, which must confirm a failure
// before refusing. Confirming by re-running the WHOLE suite cannot discriminate a
// load-correlated flake — the second run carries the same load that produced the first.
// These pin the two properties that make the narrowed re-run trustworthy.
describe("test_suite — only_tests isolation filter", () => {
  const originalFetch = globalThis.fetch;

  async function captureCommand(pointer: Record<string, unknown>): Promise<string> {
    let captured = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("vesselCapability")) {
        return new Response(
          JSON.stringify({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } }),
          { status: 200 },
        );
      }
      if (url.startsWith("http://shell.test")) {
        captured = String(JSON.parse(body).impulse.pointer.command ?? "");
        return new Response(JSON.stringify({ stdout: " 1 pass\n 0 fail\n" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await resolveTestSuite({ type: "test_suite", vessel: "development-vessel", ...pointer });
    } finally {
      globalThis.fetch = originalFetch;
    }
    return captured;
  }

  it("runs the whole suite when no names are supplied", async () => {
    const cmd = await captureCommand({});
    expect(cmd).toContain("bun test");
    expect(cmd).not.toContain(" -t ");
  });

  it("narrows to the named tests with -t", async () => {
    const cmd = await captureCommand({ only_tests: ["alpha case", "beta case"] });
    expect(cmd).toContain(" -t ");
    expect(cmd).toContain("alpha case");
    expect(cmd).toContain("beta case");
  });

  // THE LOAD-BEARING PROPERTY. bun's -t is a regex. The real failure that motivated this
  // is titled "propose finds a closed cluster; apply + gate = PASS" — unescaped, the '+'
  // makes the pattern match NOTHING, the isolated re-run reports zero failures, and the
  // gate concludes "passed in isolation" and waves a genuine regression through. Silent,
  // and in the safe-looking direction.
  it("escapes regex metacharacters so a title with '+' matches literally", async () => {
    const cmd = await captureCommand({ only_tests: ["apply + gate = PASS"] });
    expect(cmd).toContain("apply \\\\+ gate");
  });

  it("ignores empty or non-string entries rather than emitting an empty pattern", async () => {
    // An empty alternation branch matches everything, which would silently restore the
    // whole-suite behaviour while claiming to be narrowed.
    const cmd = await captureCommand({ only_tests: ["", "   ", 42, null] });
    expect(cmd).not.toContain(" -t ");
  });
});

// ---- Per-test timeout (2026-08-29) ----
//
// bun's 5000ms default is a LOAD SENSOR, not a correctness one. Measured across five runs of
// this vessel's suite at ONE commit with no code change: 94/95/96/97/97 failures, 10 of them
// literal "timed out after 5000ms", drifting with container load. precutover_regression
// compares a staged run against a stored baseline, so that drift manufactures regressions.
describe("test_suite — per-test timeout", () => {
  const originalFetch = globalThis.fetch;

  async function captureCommand(pointer: Record<string, unknown>): Promise<string> {
    let captured = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("vesselCapability")) {
        return new Response(
          JSON.stringify({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } }),
          { status: 200 },
        );
      }
      if (url.startsWith("http://shell.test")) {
        captured = String(JSON.parse(body).impulse.pointer.command ?? "");
        return new Response(JSON.stringify({ stdout: " 1 pass\n 0 fail\n" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await resolveTestSuite({ type: "test_suite", vessel: "development-vessel", ...pointer });
    } finally {
      globalThis.fetch = originalFetch;
    }
    return captured;
  }

  it("passes a per-test timeout well above bun's 5s default", async () => {
    const cmd = await captureCommand({});
    expect(cmd).toContain("--timeout 20000");
  });

  it("still bounds the WHOLE run, so a hung test cannot pass silently", async () => {
    // The per-test timeout is raised, not removed. `timeout <budget>` wraps the run.
    const cmd = await captureCommand({});
    expect(cmd).toMatch(/timeout \d+ bun test/);
  });

  it("accepts an explicit override", async () => {
    const cmd = await captureCommand({ per_test_timeout_ms: 45000 });
    expect(cmd).toContain("--timeout 45000");
  });

  it("ignores a non-positive or non-numeric override rather than emitting a broken flag", async () => {
    for (const bad of [0, -1, "20000", null]) {
      const cmd = await captureCommand({ per_test_timeout_ms: bad });
      expect(cmd).toContain("--timeout 20000");
    }
  });
});
