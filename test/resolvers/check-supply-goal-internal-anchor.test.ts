// THE CHECK-WRITING GOAL NEVER OFFERS AN INTERNAL FUNCTION AS A CALLABLE.
//
// Measured (dispatch f176b321, a check-supply goal for a goal-host src/index.ts gap whose evidence names the floor's
// internal universalToolFallback): the goal listed the module's exports with their signatures, then said "Build it on
// what the evidence names (symbol `universalToolFallback`; …): call the code with an input". The symbol resolves in the
// site's code, so it is an anchor, but the module does not export it: the drafter called it off the namespace import
// and the verify refused the check, check_references_missing_export, on every attempt.
//
//   [MUST-FAIL] a symbol anchor the site does not export is said to be internal, to be reached through an export on
//               the list; an anchor the site exports is named as before;
//   [CONTROL]   a goal whose anchors are all exported, and a goal built with no reader (no export list), are as before.
import { describe, expect, it } from "bun:test";

const supply = (await import("../../src/resolvers/gap-check-supply.js")) as Record<string, any>;
type Reader = { read: (rel: string) => string | null; list: (dir: string) => string[] };
const reader = (files: Record<string, string>): Reader => ({ read: (rel) => files[rel] ?? null, list: () => [] });

const GH = "goal-host-vessel";
const CHECK = "test/checks/the-floor-hand-picked-tool-list-omits-the-shape-the-chooser.check.ts";
const SITE = `repos/${GH}/src/index.ts`;
const SITE_SRC = [
  `function universalToolFallback(goal: string): string[] { return goal ? ["fs_read", "fs_grep"] : []; }`,
  `export function runGroundedToolLoop(goal: string, maxSteps: number): { tools: string[]; steps: number } { return { tools: universalToolFallback(goal), steps: maxSteps }; }`,
  `export const FLOOR_TOOL_MAX = 4;`,
  ``,
].join("\n");
const FILES = { "src/index.ts": SITE_SRC };
// The row's summary, as the supply read it (the floor named by its internal function).
const SUMMARY = "goal-host floor (universalToolFallback) hand-picked tools [fs_read, codeSearchResult, fs_grep, substrateGap] while the target chooser named shellResult as the closest shape, and runGroundedToolLoop() then ran with that list";
const LABEL = "(internal to src/index.ts, not exported: the test cannot call it, so reach it through an export on the list that does)";

describe("a symbol anchor the edit site does not export is not offered as a callable", () => {
  it("[MUST-FAIL] the internal anchor is labelled internal and to be reached through an export; the exported one is not", () => {
    const anchors = supply.falsifiableAnchors(SUMMARY, SITE_SRC);
    expect(anchors).toContainEqual({ kind: "symbol", value: "universalToolFallback" });
    expect(anchors).toContainEqual({ kind: "symbol", value: "runGroundedToolLoop" });
    const goal: string = supply.checkSupplyGoal(GH, CHECK, SUMMARY, SITE, reader(FILES), anchors);
    expect(goal).toContain(`symbol \`universalToolFallback\` ${LABEL}`);
    expect(goal).toContain("symbol `runGroundedToolLoop`;");
    expect(goal).not.toContain("symbol `runGroundedToolLoop` (internal");
    // the list the label points at carries the exported function's signature
    expect(goal).toContain("runGroundedToolLoop: function (goal: string, maxSteps: number): { tools: string[]; steps: number }");
  });

  it("[CONTROL] anchors that are all exported are named exactly as before", () => {
    const anchors = [{ kind: "symbol", value: "runGroundedToolLoop" }];
    const goal: string = supply.checkSupplyGoal(GH, CHECK, SUMMARY, SITE, reader(FILES), anchors);
    expect(goal).toContain("Build it on what the evidence names (symbol `runGroundedToolLoop`): call the code with an input");
    expect(goal).not.toContain("(internal to");
  });

  it("[CONTROL] a goal built with no reader, or for an unreadable site, labels nothing", () => {
    const anchors = [{ kind: "symbol", value: "universalToolFallback" }];
    for (const goal of [supply.checkSupplyGoal(GH, CHECK, SUMMARY, SITE, undefined, anchors), supply.checkSupplyGoal(GH, CHECK, SUMMARY, SITE, reader({}), anchors)] as string[]) {
      expect(goal).toContain("Build it on what the evidence names (symbol `universalToolFallback`): call the code with an input");
      expect(goal).not.toContain("(internal to");
    }
  });
});
