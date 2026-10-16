// Wiring for run-origin-read.test.ts (source-level, no import, so it fails on a tree without the rule for that reason).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("[MUST-FAIL] producer-dispatch reads a run where it ran", () => {
  test("readRun resolves the dispatch's tally entry and reads through runOriginBase, not this node's goal-host alone", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "goal-reach-tick.ts"), "utf8");
    const at = src.indexOf("readRun: async (id) => {");
    const body = src.slice(at, at + 600);
    expect(body).toContain("runOriginBase(entry)");
    expect(body).not.toMatch(/const base = await ownGoalHostBase\(\);/);
  });
});
