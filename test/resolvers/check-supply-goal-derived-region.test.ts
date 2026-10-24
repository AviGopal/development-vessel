// THE CHECK-WRITING GOAL NAMES THE REGION THE ARM STEP'S REGION GATE WILL REPLACE (law 8).
//
// The region gate (regionMutantGate) replaces the statement a row's evidence derives (explainedTextRegion) and refuses
// a check whose red survives it, but the goal never named that statement: the drafter learned it only from a refusal.
// The goal now carries the SAME derivation over the same inputs (summary, falsifier_spec, must_fail, control) under the
// same rule (regionGateApplies): the anchor, the statement at path:line, and what it produces.
//
//   [MUST-FAIL] a row with a derived region gets its anchor, its site path:line and "Assert on THIS: <observable>";
//   [CONTROL]   a row with no derivable region, a row whose literal region is in the site, and a goal with no
//               reader get the goal text byte-unchanged.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const supply = (await import("../../src/resolvers/gap-check-supply.js")) as Record<string, any>;
type Reader = { read: (rel: string) => string | null; list: (dir: string) => string[] };
const reader = (files: Record<string, string>): Reader => ({ read: (rel) => files[rel] ?? null, list: () => [] });

const V = "development-vessel";
const CHECK = "test/checks/g-throws-the-widget-is-not-configured.check.ts";
const SITE = `repos/${V}/src/g.ts`;
const SRC = "export function g(): string {\n  throw new Error(\"the widget is not configured\");\n}\n";
const FILES = { "src/g.ts": SRC };
const SUMMARY = "g misbehaves";
const META = { must_fail: "g throws \"the widget is not configured\" today" };

describe("the check goal names the gate's derived region", () => {
  it("[MUST-FAIL] a row with a derived region: anchor text, site path:line and the observable to assert on", () => {
    const region = supply.derivedTextRegion(SRC, "src/g.ts", SUMMARY, "", META);
    expect(region).toMatchObject({ anchor: "the widget is not configured", kind: "text" });
    const goal: string = supply.checkSupplyGoal(V, CHECK, SUMMARY, SITE, reader(FILES), [], [], META);
    expect(goal).toContain("\"the widget is not configured\"");
    expect(goal).toContain(`src/g.ts:${region.mutant.line}`);
    expect(goal).toContain("throw new Error(\"the widget is not configured\");");
    expect(goal).toContain(`Assert on THIS: the error it throws at src/g.ts:${region.mutant.line}`);
  });

  it("[MUST-FAIL] a multi-occurrence token region (5e69d7a0's row) is named with its first statement and count", () => {
    const FIX = join(import.meta.dir, "..", "fixtures", "check-asserts-defect-output");
    const src = readFileSync(join(FIX, "gap-check-supply.bf88c790.ts.txt"), "utf8");
    const row = JSON.parse(readFileSync(join(FIX, "5e69d7a0-row-evidence.json"), "utf8")) as Record<string, string>;
    const rel = "src/resolvers/gap-check-supply.ts";
    const meta = { falsifier_spec: row["falsifier_spec"], must_fail: row["must_fail"], control: row["control"] };
    const region = supply.derivedTextRegion(src, rel, row["summary"], row["falsifier_spec"], { must_fail: row["must_fail"], control: row["control"] });
    const goal: string = supply.checkSupplyGoal(V, "test/checks/x.check.ts", row["summary"], `repos/${V}/${rel}`, reader({ [rel]: src }), [], [], meta);
    expect(goal).toContain("token anchor \"red_independent_of_edit_site\"");
    expect(goal).toContain(`${rel}:${region.mutant.line} (with its 1 other occurrence(s) there)`);
    expect(goal).toContain(`Assert on THIS: the value it returns at ${rel}:${region.mutant.line}`);
  });

  it("[CONTROL] a row with no derivable region gets the goal byte-unchanged", () => {
    const plain: string = supply.checkSupplyGoal(V, CHECK, SUMMARY, SITE, reader(FILES), []);
    expect(supply.checkSupplyGoal(V, CHECK, SUMMARY, SITE, reader(FILES), [], [], {})).toBe(plain);
    expect(supply.checkSupplyGoal(V, CHECK, SUMMARY, SITE, reader(FILES), [], [], { must_fail: "g fails somehow" })).toBe(plain);
    expect(plain).not.toContain("Assert on THIS");
  });

  it("[CONTROL] a literal region in the site (no region gate) and a goal with no reader are byte-unchanged", () => {
    const lit = { ...META, region: "throw new Error" };
    expect(supply.checkSupplyGoal(V, CHECK, SUMMARY, SITE, reader(FILES), [], [], lit)).toBe(supply.checkSupplyGoal(V, CHECK, SUMMARY, SITE, reader(FILES), []));
    expect(supply.checkSupplyGoal(V, CHECK, SUMMARY, SITE, undefined, [], [], META)).toBe(supply.checkSupplyGoal(V, CHECK, SUMMARY, SITE, undefined, []));
    expect(supply.checkSupplyGoal(V, CHECK, SUMMARY, SITE, reader({}), [], [], META)).toBe(supply.checkSupplyGoal(V, CHECK, SUMMARY, SITE, reader({}), []));
  });
});
