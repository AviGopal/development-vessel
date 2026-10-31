// THE CHECK WRITER IS TOLD A PROSE-SPEC ROW'S EXPECTED VALUE.
//
// A row with a prose falsifier_spec and no must_fail reached the check-writing goal only through the region and anchor
// derivation: the spec's statement of what must hold after the fix never reached the drafter, which was told only to
// "Name the expected (correct) value in the failing test's title". It guessed, and its check was red for the wrong
// reason. mustFailControlSentence now says the spec, clamped like the row's must_fail, when must_fail is absent.
// The must_fail path is byte-unchanged (a spec on a row that has one is not read), a row with neither is
// byte-unchanged, and the added text is bounded like a must_fail. A goal its parts push past the dispatch bound
// (dispatch-goal.ts MAX_GOAL_LEN, 8192), which dispatch_goal refuses whole, now fits by cutting the symptom last, so
// the expected-value sentence is never what is lost. The literals below are the parent's output: the CONTROL cases
// pass there.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const supply = (await import("../../src/resolvers/gap-check-supply.js")) as Record<string, unknown> & typeof import("../../src/resolvers/gap-check-supply.js");
type Reader = { read: (rel: string) => string | null; list: (dir: string) => string[] };
const reader = (files: Record<string, string>): Reader => ({ read: (rel) => files[rel] ?? null, list: () => [] });
const MAX_GOAL_LEN = 8192;
const V = "fixture-vessel";
const CHECK = "test/checks/x.check.ts";
const SITE = `repos/${V}/src/x.ts`;
const FILES = { "src/x.ts": "export function count(items: string[]): number {\n  return items.length - 1;\n}\n" };
const SUMMARY = "count returns one less than the number of items";
const SPEC = "count([\"a\", \"b\"]) returns 2 (today 1). CONTROL: count([]) is not negative after the fix either.";
const CONTROL = "Write a second test, a CONTROL: an input the defect does not touch, asserting behaviour that must stay the same. It passes now and after the fix.";
const goalFor = (meta: Record<string, unknown> | null): string => supply.checkSupplyGoal(V, CHECK, SUMMARY, SITE, reader(FILES), [], [], meta);

describe("a prose falsifier_spec reaches the check-writing goal", () => {
  it("[MUST-FAIL] a row with a falsifier_spec and no must_fail is told the spec as the expected value", () => {
    expect(supply.mustFailControlSentence({ falsifier_spec: SPEC })).toBe(
      `After the fix, this must hold: ${SPEC}. The failing assertion states THAT expected value; it is red now because the code does something else. ${CONTROL} `);
  });

  it("[MUST-FAIL] the whole goal carries the spec's expectation and no longer asks the drafter to name a value", () => {
    const goal = goalFor({ falsifier_spec: SPEC });
    expect(goal).toContain(`After the fix, this must hold: ${SPEC}.`);
    expect(goal).not.toContain("Name the expected (correct) value in the failing test's title.");
  });

  it("[MUST-FAIL] a long spec is clamped like a must_fail, and adds exactly what the same must_fail would", () => {
    const long = `count must return the item count. ${"x".repeat(2000)}`;
    const said = supply.mustFailControlSentence({ falsifier_spec: long });
    expect(said).toContain(`After the fix, this must hold: ${long.slice(0, supply.MUST_FAIL_CONTROL_MAX_CHARS - 1)}…. `);
    expect(said).toBe(supply.mustFailControlSentence({ must_fail: long }));
    expect(goalFor({ falsifier_spec: long }).length).toBe(goalFor({ must_fail: long }).length);
  });

  it("[CONTROL] a must_fail row's sentence and goal are byte-identical to the parent's, with or without a spec", () => {
    const parent = `After the fix, this must hold: count(["a"]) returns 1. The failing assertion states THAT expected value; it is red now because the code does something else. ${CONTROL} The control: count([]) is 0. `;
    expect(supply.mustFailControlSentence({ must_fail: "count([\"a\"]) returns 1", control: "count([]) is 0" })).toBe(parent);
    expect(supply.mustFailControlSentence({ must_fail: "count([\"a\"]) returns 1", control: "count([]) is 0", falsifier_spec: SPEC })).toBe(parent);
    const withMf = { must_fail: "count([\"a\"]) returns 1", control: "count([]) is 0" };
    expect(goalFor({ ...withMf, falsifier_spec: SPEC })).toBe(goalFor(withMf));
    // The rest of the goal is the parent's too: only the row sentence differs from a row-less goal.
    expect(goalFor(withMf)).toBe(goalFor(null).replace(`Name the expected (correct) value in the failing test's title. ${CONTROL} `, parent));
    expect(goalFor(withMf)).toContain(`that reproduces: ${SUMMARY}. Its expect() assertion fails because of the defect`);
  });

  it("[CONTROL] a row with neither must_fail nor falsifier_spec (or a blank or non-string spec) is unchanged", () => {
    const parent = `Name the expected (correct) value in the failing test's title. ${CONTROL} `;
    for (const meta of [null, {}, { falsifier_spec: "   " }, { falsifier_spec: 7 }, { control: "count([]) is 0", falsifier_spec: "" }]) {
      const want = meta && "control" in meta ? `${parent}The control: count([]) is 0. ` : parent;
      expect(supply.mustFailControlSentence(meta as Record<string, unknown> | null)).toBe(want);
    }
    expect(goalFor({ falsifier_spec: "  " })).toBe(goalFor(null));
  });

  it("[MUST-FAIL] a goal the parts push past MAX_GOAL_LEN fits by cutting the symptom last: the falsifier sentence and the anchors stay intact", () => {
    // The anchor is sized so the goal with a short symptom sits 200 characters under the bound; a full 600-character
    // symptom then pushes it about 400 over. The parent returned it over the bound, and dispatch_goal refuses it whole.
    const meta = { falsifier_spec: SPEC, control: "count([]) is 0" };
    const short = supply.checkSupplyGoal(V, CHECK, "count is wrong", SITE, reader(FILES), [{ kind: "behaviour", value: "x" }], [], meta);
    const anchor = { kind: "behaviour" as const, value: `x${"w".repeat(MAX_GOAL_LEN - 200 - short.length)}` };
    const summary = `count is wrong ${"s".repeat(800)}`;
    const goal = supply.checkSupplyGoal(V, CHECK, summary, SITE, reader(FILES), [anchor], [], meta);
    expect(goal.length).toBeLessThanOrEqual(MAX_GOAL_LEN);
    expect(goal).toContain(supply.mustFailControlSentence(meta));
    expect(goal).toContain(`After the fix, this must hold: ${SPEC}.`);
    expect(goal).toContain(anchor.value);
    expect(goal).toMatch(/that reproduces: count is wrong s{100,500}\. Its expect\(\) assertion/);
  });

  it("[CONTROL] a goal still over the bound with no symptom left is returned whole, as before", () => {
    const anchor = { kind: "behaviour" as const, value: "w".repeat(MAX_GOAL_LEN) };
    const goal = supply.checkSupplyGoal(V, CHECK, SUMMARY, SITE, reader(FILES), [anchor], [], { must_fail: "count([\"a\"]) returns 1" });
    expect(goal).toContain(`that reproduces: ${SUMMARY}. `);
    expect(goal.length).toBeGreaterThan(MAX_GOAL_LEN);
  });

  it("[CONTROL] with goal-host's whole export list and a 2000-character spec the goal stays under the dispatch bound", () => {
    const src = readFileSync(join(import.meta.dir, "..", "fixtures", "check-references-missing-export", "goal-host-index.exports.ts.txt"), "utf8");
    const goal = supply.checkSupplyGoal("goal-host-vessel", "test/checks/route-edit-bd252f8c.check.ts", "y".repeat(600), "repos/goal-host-vessel/src/index.ts", reader({ "src/index.ts": src }), [], [], { falsifier_spec: "z".repeat(2000), control: "c".repeat(2000) });
    expect(goal).toContain("src/index.ts exports exactly these 68 names");
    expect(goal.length).toBeLessThanOrEqual(MAX_GOAL_LEN);
  });
});
