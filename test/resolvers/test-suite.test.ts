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
