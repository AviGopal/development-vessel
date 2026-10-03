import { describe, expect, it } from "bun:test";
import { compareOutcome } from "../../src/resolvers/attempt-register";

/**
 * AN EMPTY PROMISE IS NOT A KEPT ONE (gap: an-intent-with-an-empty-expect-pass-reads-as-intended-met).
 * compareOutcome started `intended` at "met" and only looked at expect_pass when it was non-empty, so an attempt
 * that predicted NOTHING recorded intended:"met" (with intended_vacuous:true beside it). Any reader of `intended`
 * alone counted a vacuous intent as a met one. An empty expect_pass now records intended:"vacuous".
 */
const check = (id: string, verdict: "pass" | "fail") => ({ id, verdict }) as never;

describe("compareOutcome on an empty prediction", () => {
  it("an empty expect_pass records intended 'vacuous', never 'met'", () => {
    const o = compareOutcome([check("a", "pass")], [check("a", "pass")], { expect_pass: [], expect_change: [] }, ["src/x.ts"]);
    expect(o.intended_vacuous).toBe(true);
    expect(o.intended as string).toBe("vacuous");
  });

  it("a non-empty expect_pass that passes still records 'met'", () => {
    const o = compareOutcome([check("a", "fail")], [check("a", "pass")], { expect_pass: ["a"], expect_change: [] }, ["src/x.ts"]);
    expect(o.intended_vacuous).toBe(false);
    expect(o.intended).toBe("met");
  });
});
