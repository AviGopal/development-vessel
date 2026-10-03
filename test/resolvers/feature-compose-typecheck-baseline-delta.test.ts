// THE TYPECHECK GATE IS A BASELINE DELTA (gap a-silent-autonomous-commit-removed-the-baseline-typecheck-tolerance,
// check-first).
//
// feature-compose's verify computes the draft's tsc error set, the baseline's, the NEW errors (draft minus
// baseline) and whether any error sits in a file the draft touched, and its comment describes the
// relaxation: pass when the baseline was already red and the draft added no new error and left no error in a
// file it touched. Then `const tcOk = tcExit === 0;` discards all of it. Autonomous commit 03064b74
// (2026-08-08, one line, no reason in the message) replaced the relaxed predicate with the strict one, so on
// any vessel whose untouched baseline fails tsc every draft fails typecheck, its own check never runs (it is
// skipped when tcOk is false), and the lane records a typecheck failure the draft did not cause.
//
// The delta means "no NEW typecheck errors versus the baseline" (qa ruling). It is judged by an exported pure
// function, typecheckVerdict, that the verify step calls; its absence reads as a red assertion, never a skip.
// Limit: that the own check RUNS once tcOk is true is the verify step's unchanged `own && tcOk` condition, not
// driven here.
import { describe, expect, it } from "bun:test";

const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;

const BASE_ERR = "src/config.ts: error TS2305: Module has no exported member DiscoveryLookup.";
const NEW_ERR = "src/resolvers/widget.ts: error TS2339: Property frames does not exist on type Widget.";
const verdict = (input: { tcExit: number | null; curTs: string[]; baseTs: string[]; touched: string[] }) => {
  expect(typeof fc.typecheckVerdict).toBe("function");
  return fc.typecheckVerdict({ tcExit: input.tcExit, curTs: new Set(input.curTs), baseTs: new Set(input.baseTs), touched: input.touched }) as { ok: boolean; new_ts: string[]; touched_err: boolean };
};

describe("typecheck verdict on a draft, against its baseline", () => {
  it("MUST-FAIL a draft on a red baseline that adds no typecheck error and touches no erroring file passes typecheck", () => {
    const v = verdict({ tcExit: 2, curTs: [BASE_ERR], baseTs: [BASE_ERR], touched: ["/vessels/fixture-vessel/src/resolvers/widget.ts"] });
    expect(v.ok).toBe(true);
    expect(v.new_ts).toEqual([]);
    expect(v.touched_err).toBe(false);
  });

  it("CONTROL a draft that adds a typecheck error is refused, on a red baseline too", () => {
    const v = verdict({ tcExit: 2, curTs: [BASE_ERR, NEW_ERR], baseTs: [BASE_ERR], touched: ["/vessels/fixture-vessel/src/other.ts"] });
    expect(v.ok).toBe(false);
    expect(v.new_ts).toEqual([NEW_ERR]);
  });

  it("CONTROL a draft that edits a file which still carries a typecheck error is refused, even when that error was already in the baseline", () => {
    const v = verdict({ tcExit: 2, curTs: [BASE_ERR], baseTs: [BASE_ERR], touched: ["/vessels/fixture-vessel/src/config.ts"] });
    expect(v.ok).toBe(false);
    expect(v.touched_err).toBe(true);
  });

  it("CONTROL on a clean baseline the gate stays strict: any failing typecheck refuses", () => {
    expect(verdict({ tcExit: 2, curTs: [NEW_ERR], baseTs: [], touched: [] }).ok).toBe(false);
    expect(verdict({ tcExit: 0, curTs: [], baseTs: [], touched: [] }).ok).toBe(true);
  });

  it("CONTROL a typecheck that did not answer or timed out is never relaxed into a pass, whatever the baseline", () => {
    expect(verdict({ tcExit: null, curTs: [], baseTs: [BASE_ERR], touched: [] }).ok).toBe(false);
    expect(verdict({ tcExit: 124, curTs: [], baseTs: [BASE_ERR], touched: [] }).ok).toBe(false);
  });

  it("CONTROL a failing typecheck that printed no error at all is not explained by the baseline and refuses", () => {
    expect(verdict({ tcExit: 1, curTs: [], baseTs: [BASE_ERR], touched: [] }).ok).toBe(false);
  });
});
