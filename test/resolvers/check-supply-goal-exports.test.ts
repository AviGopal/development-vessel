// F-ARM, THE WRITER'S SIDE: THE CHECK WRITER IS GIVEN THE MODULE'S REAL EXPORTS.
//
// gap-check-supply's goal is the check writer's whole brief: the drafter that writes test/checks/<gap>.check.ts sees
// the goal text, not the module it imports. It was never shown what that module exports, so it named a symbol the
// evidence mentioned and the module does not export (2f36f62, route-edit-bd252f8c: `mod["shellResult"]` on goal-host
// src/index.ts). The arm step now refuses such a check; this pins the fact that lets the writer avoid it: the goal for
// a code edit site carries the site's export list (names and kinds), read by the extractor the refusal uses, bounded
// like the decompose prompt's source list (80 names, the gap's own words first, the rest counted), and says checks may
// reference only exports from that list. Controls: an unreadable site gets no list; the goal stays under the dispatch
// bound (dispatch-goal.ts MAX_GOAL_LEN, 8192). The next attempt's brief (priorAttemptSentence) keeps the invented
// name a refusal named: an existence_only reason puts check_references_missing_export:<symbol> past the 160-char cut
// (the AuthCache check's ended at "check_references_missing_exp"), so the cut is made after the symbol.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const supply = (await import("../../src/resolvers/gap-check-supply.js")) as Record<string, unknown> & typeof import("../../src/resolvers/gap-check-supply.js");
type Reader = { read: (rel: string) => string | null; list: (dir: string) => string[] };
const reader = (files: Record<string, string>): Reader => ({ read: (rel) => files[rel] ?? null, list: () => [] });
const csa = (await import("../../src/resolvers/check-supply-admission.js")) as typeof import("../../src/resolvers/check-supply-admission.js");
const fixture = (name: string): string => readFileSync(join(import.meta.dir, "..", "fixtures", "check-references-missing-export", name), "utf8");
const GOAL_HOST_INDEX = fixture("goal-host-index.exports.ts.txt");
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

describe("the next attempt is told the name a refusal named", () => {
  const AUTHCACHE_TITLE = "auth-cache module resolves and exports AuthCache function";
  it("[MUST-FAIL] an existence_only reason naming a missing export (the AuthCache check, 7b54fc7) keeps check_references_missing_export:AuthCache through the cut", () => {
    const missing = csa.missingExportRefusal(fixture("pull-sync-testgate-unresolvable-modules-activity-api.check.ts.txt"), "test/checks/pull-sync-testgate-unresolvable-modules-activity-api.check.ts", reader({ "src/middleware/auth-cache.ts": fixture("activity-api-auth-cache.exports.ts.txt") }));
    expect(missing?.symbol).toBe("AuthCache");
    // the arm step's existence_only reason, as gap-check-supply writes it
    const reason = `existence_only: all 1 assertion(s) of the named test(s) only check that a name exists or has a type; a check must assert behaviour; ${missing!.reason}`;
    expect(reason.indexOf("AuthCache")).toBeGreaterThan(160);
    const s = supply.priorAttemptSentence([{ state: "existence_only", reason, titles: [AUTHCACHE_TITLE] }]);
    expect(s).toContain("check_references_missing_export:AuthCache");
    expect(s).toContain(`(${reason.slice(0, reason.indexOf("AuthCache") + "AuthCache".length)})`);
  });

  it("[CONTROL] a short reason passes through unchanged, and a long one that names no refused export is still cut at 160", () => {
    const short = "network: connection refused";
    expect(supply.priorAttemptSentence([{ state: "arm_refused", titles: ["t one"], reason: short }])).toBe(`An earlier attempt wrote "t one", which was not accepted (${short}): write a different test that avoids that. `);
    const long = "x".repeat(300);
    expect(supply.priorAttemptSentence([{ state: "arm_refused", titles: ["t one"], reason: long }])).toBe(`An earlier attempt wrote "t one", which was not accepted (${"x".repeat(160)}): write a different test that avoids that. `);
  });
});

// THE CHECK WRITER IS GIVEN EACH EXPORTED FUNCTION'S REAL SIGNATURE (2026-10-22).
//
// Told only names and kinds, the writer invented call shapes the module never had: a row object where
// nonAttemptDelayMs declares four numbers (2182d140), `.shapes` read off inferGoalTargetShapes, declared
// Promise<string[]> (725638cc). The goal now lists each function as `name: kind (parameters): ReturnType`, read by the
// same parser over the same clone reader the guards use (check-supply-admission.ts exportSignatures), so an export
// reached through `export { … }`, a re-export or a default is signed too; and a site that cannot be read is said to be
// unread instead of the list silently going missing. FIXTURES: the modules the instance checks were written against
// (check-contract-mismatch/ and check-references-missing-export/), verbatim or as verbatim excerpts.
const mismatchFixture = (name: string): string => readFileSync(join(import.meta.dir, "..", "fixtures", "check-contract-mismatch", name), "utf8");

describe("the check writer's goal gives each exported function its signature", () => {
  it("[MUST-FAIL] a function export with parameters and a return type is listed with them (goal-target-inference.ts at 725638cc, nonAttemptDelayMs at 2182d140)", () => {
    const gti = supply.checkSupplyGoal(GH, "test/checks/x.check.ts", "goal-target inference reads outside-world asks as self-reports", `repos/${GH}/src/goal-target-inference.ts`, reader({ "src/goal-target-inference.ts": mismatchFixture("goal-target-inference.at-725638cc.ts.txt") }));
    expect(gti).toContain("inferGoalTargetShapes: function (goal: string, knownShapes: string[], opts: InferGoalTargetShapesOpts = {}): Promise<string[]>");
    expect(gti).toContain("each function with its declared signature");
    expect(gti).toContain("Call each function with the parameters its signature declares");
    const gcs = supply.checkSupplyGoal("development-vessel", "test/checks/x.check.ts", "a ruled sequencing condition is not honoured", "repos/development-vessel/src/resolvers/gap-check-supply.ts", reader({ "src/resolvers/gap-check-supply.ts": mismatchFixture("gap-check-supply.at-2182d140.excerpt.ts.txt") }));
    expect(gcs).toContain("nonAttemptDelayMs: function (baseMs: number, streak: number, maxMs: number, receiverMinMs = 0): number");
    for (const goal of [gti, gcs]) expect(goal.length).toBeLessThanOrEqual(MAX_GOAL_LEN);
  });

  it("[MUST-FAIL] an export reached only through an export list, a re-export or a default is listed with its signature", () => {
    const index = fixture("goal-host-index.at-979b966d.excerpt.ts.txt");
    expect(index).not.toContain("export async function verifyGoalReached");
    const goal = supply.checkSupplyGoal(GH, CHECK, "the reach judge lacks the current date", `repos/${GH}/src/index.ts`, reader({ "src/index.ts": index }));
    expect(goal).toContain("verifyGoalReached: function (goal: string, producedShapes: string[], taskSummary: string, contentDigest?: string");
    const SITE = {
      "src/a.ts": `import { inner } from "./c";\nfunction local(n: number): string { return String(n); }\nexport { local as renamed, inner };\nexport { fromB } from "./b";\nexport * from "./d";\nexport default function main(flag: boolean): void {}\n`,
      "src/b.ts": "export const fromB = (s: string): number => s.length;\n",
      "src/c.ts": "export function inner(x: { id: string }): Promise<string[]> { return Promise.resolve([x.id]); }\n",
      "src/d.ts": "export const fromD: (a: number, b: number) => number = (a, b) => a + b;\nexport const data = { k: 1 };\n",
    };
    const g = supply.checkSupplyGoal("fixture-vessel", "test/checks/x.check.ts", "x", "repos/fixture-vessel/src/a.ts", reader(SITE));
    expect(g).toContain("renamed: function (n: number): string");
    expect(g).toContain("inner: re-export (x: { id: string }): Promise<string[]>");
    expect(g).toContain("fromB: re-export (s: string): number");
    expect(g).toContain("fromD: const (a: number, b: number) => number");
    expect(g).toContain("default: function (flag: boolean): void");
    expect(g).toContain("data: const,");
  });

  it("[MUST-FAIL] an edit site that cannot be read is said to be unread, not silently left without a list", () => {
    const goal = supply.checkSupplyGoal(GH, CHECK, SUMMARY, `repos/${GH}/src/index.ts`, reader({}));
    expect(goal).toContain("src/index.ts could not be read here, so its exports and their signatures are not listed");
  });

  it("[CONTROL] a goal for a site with no function export is unchanged: names and kinds, no signature, no call instruction", () => {
    const goal = supply.checkSupplyGoal("fixture-vessel", "test/checks/x.check.ts", "the widget count is wrong", "repos/fixture-vessel/src/x.ts", reader({ "src/x.ts": "export const widget = 1;\nexport type T = { a: 1 };\nexport interface I { b: string }\n" }));
    expect(goal).toBe('Write ONE failing test in repos/fixture-vessel/test/checks/x.check.ts that reproduces: the widget count is wrong. Its expect() assertion fails because of the defect, not because the file fails to load: Import the module the defect lives in as a namespace, import * as mod from "../../src/x", and assert on it. src/x.ts exports exactly these 3 names (name: kind): widget: const, T: type, I: interface. The test may reference only exports from this list: a name the module does not export (an internal function, a shape name, a label) is undefined on the import, so a check that reads one is refused; reach internal code through an export on the list. No network, no services, no timers. Do not change src/ or any other file.');
  });
});
