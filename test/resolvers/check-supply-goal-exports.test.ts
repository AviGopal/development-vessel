// F-ARM, THE WRITER'S SIDE: THE CHECK WRITER IS GIVEN THE MODULE'S REAL EXPORTS.
//
// gap-check-supply's goal is the check writer's whole brief: the drafter that writes test/checks/<gap>.check.ts sees
// the goal text, not the module it imports. It was never shown what that module exports, so it named a symbol the
// evidence mentioned and the module does not export (2f36f62, route-edit-bd252f8c: `mod["shellResult"]` on goal-host
// src/index.ts). The arm step now refuses such a check; this pins the fact that lets the writer avoid it: the goal for
// a code edit site carries the site's export list (names and kinds), read by the extractor the refusal uses, bounded
// like the decompose prompt's source list (80 names, the gap's own words first, the rest counted), and says checks may
// reference only exports from that list. Controls: an unreadable site gets no list; the goal stays under the dispatch
// bound (dispatch-goal.ts MAX_GOAL_LEN, 8192).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const supply = (await import("../../src/resolvers/gap-check-supply.js")) as Record<string, unknown> & typeof import("../../src/resolvers/gap-check-supply.js");
type Reader = { read: (rel: string) => string | null; list: (dir: string) => string[] };
const reader = (files: Record<string, string>): Reader => ({ read: (rel) => files[rel] ?? null, list: () => [] });
const GOAL_HOST_INDEX = readFileSync(join(import.meta.dir, "..", "fixtures", "check-references-missing-export", "goal-host-index.exports.ts.txt"), "utf8");
const GH = "goal-host-vessel";
const CHECK = "test/checks/route-edit-bd252f8c.check.ts";
const SUMMARY = "route-edit-bd252f8c: when correctness requires an exact procedure, the universal fallback generates a value instead of executing it, despite a `shellResult` tool being available (17 letters reported for a 16-letter word)";
const MAX_GOAL_LEN = 8192;
/** The names and kinds a module exports, as the fixture declares them (one export per line). */
const declared = (src: string): Array<[string, string]> => [
  ...[...src.matchAll(/^export (function|const|interface|type) ([A-Za-z_$][\w$]*)/gm)].map((m) => [m[2]!, m[1]!] as [string, string]),
  ...[...src.matchAll(/^export \{ ([A-Za-z_$][\w$]*) \};$/gm)].map((m) => [m[1]!, "re-export"] as [string, string]),
];

describe("the check writer's goal names the edit site's real exports", () => {
  it("[MUST-FAIL] the goal for a gap whose edit site is goal-host src/index.ts lists every one of its 68 exports with its kind, and says a check may reference only those", () => {
    const goal = supply.checkSupplyGoal(GH, CHECK, SUMMARY, `repos/${GH}/src/index.ts`, reader({ "src/index.ts": GOAL_HOST_INDEX }));
    const names = declared(GOAL_HOST_INDEX);
    expect(names.length).toBe(68);
    for (const [name, kind] of names) expect(goal).toContain(`${name}: ${kind}`);
    expect(goal).toContain("src/index.ts exports exactly these 68 names");
    expect(goal).toContain("The test may reference only exports from this list");
    expect(goal).not.toContain("shellResult: ");
    expect(goal.length).toBeLessThanOrEqual(MAX_GOAL_LEN);
  });

  it("[MUST-FAIL] the list is bounded at 80 names, the ones the gap's words name first, and the rest are counted", () => {
    expect(supply["EXPORT_LIST_MAX"]).toBe(80);
    const many = Array.from({ length: 120 }, (_, i) => `export function fn${String(i).padStart(3, "0")}(): number { return ${i}; }`).join("\n") + "\n";
    const goal = supply.checkSupplyGoal("fixture-vessel", "test/checks/x.check.ts", "fn117 returns 117 where 0 is required", "repos/fixture-vessel/src/many.ts", reader({ "src/many.ts": many }));
    expect(goal).toContain("src/many.ts exports 120 names; 80 of them");
    expect(goal).toContain("and 40 more");
    expect(goal.indexOf("fn117: function")).toBeLessThan(goal.indexOf("fn000: function"));
    expect(goal).toContain("fn078: function");
    expect(goal).not.toContain("fn079: function");
    expect(goal.length).toBeLessThanOrEqual(MAX_GOAL_LEN);
  });

  it("[CONTROL] an edit site that cannot be read, and a goal built with no reader, carry no export list (the goal is otherwise as before)", () => {
    const unread = supply.checkSupplyGoal(GH, CHECK, SUMMARY, `repos/${GH}/src/index.ts`, reader({}));
    const noReader = supply.checkSupplyGoal(GH, CHECK, SUMMARY, `repos/${GH}/src/index.ts`);
    for (const goal of [unread, noReader]) {
      expect(goal).not.toContain("may reference only exports");
      expect(goal).toContain('import * as mod from "../../src/index"');
    }
    expect(unread).toBe(noReader);
  });

  it("[MUST-FAIL] the list is clamped by characters too: 80 very long names keep the goal under the dispatch bound, the rest counted", () => {
    expect(supply["EXPORT_LIST_MAX_CHARS"]).toBe(3000);
    const long = Array.from({ length: 80 }, (_, i) => `export function ${"averyLongExportNameThatGoesOnAndOn".repeat(4)}${i}(): number { return ${i}; }`).join("\n") + "\n";
    const goal = supply.checkSupplyGoal("fixture-vessel", "test/checks/x.check.ts", "x".repeat(600), "repos/fixture-vessel/src/long.ts", reader({ "src/long.ts": long }));
    expect(goal.length).toBeLessThanOrEqual(MAX_GOAL_LEN);
    expect(goal).toMatch(/src\/long\.ts exports 80 names; \d+ of them/);
    expect(goal).toMatch(/, and \d+ more\. /);
  });
});
