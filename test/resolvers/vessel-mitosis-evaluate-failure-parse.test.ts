import { describe, expect, test } from "bun:test";
import {
  testFailureNames,
  testFailureParseIsConsistent,
} from "../../src/resolvers/vessel-mitosis-evaluate";

/**
 * REAL bun 1.3.14 output, captured verbatim from a failing run of
 * goal-host-vessel's goal-intent.test.ts on 2026-08-09 — the run whose two
 * failures the gate reported as "0 introduced".
 *
 * It is a literal fixture on purpose. The parser previously matched
 * `^\(fail\)\s+(.*)$`, a shape bun no longer emits, so it extracted NOTHING from
 * every run for as long as this bun has been in the image. Both sides of the
 * delta parsed to the empty set, the gate always concluded "0 introduced", and a
 * commit that fails 2 of 7 tests landed FAVORABLE and pushed to origin/dev.
 *
 * Pinning the real bytes means the next bun upgrade breaks THIS TEST instead of
 * silently disarming the gate again.
 */
const BUN_FAILING_OUTPUT = [
  "[0m[32m✓[0m [0misEditIntentGoal[2m >[0m[1m matches a concrete file plus a mutation verb[0m [0m[2m[0.71ms[0m[2m][0m",
  "[0m[31m✗[0m [0misEditIntentGoal[2m >[0m[1m does NOT match a mutation verb with no concrete file[0m [0m[2m[0.10ms[0m[2m][0m",
  "[0m[31m✗[0m [0misEditIntentGoal[2m >[0m[1m requires a file EXTENSION, not just a repos/ prefix[0m [0m[2m[0.03ms[0m[2m][0m",
  "",
  "[0m[32m 5 pass[0m",
  "[0m[31m 2 fail[0m",
  " 12 expect() calls",
].join("\n");

const BUN_PASSING_OUTPUT = [
  "[0m[32m✓[0m [0msomething[2m >[0m[1m works[0m",
  "[0m[32m 27 pass[0m",
  "[2m 0 fail[0m",
].join("\n");

/** The dead format, kept so a bun downgrade does not re-break the gate. */
const LEGACY_OUTPUT = ["(fail) suite > a legacy failure name [1.20ms]", " 1 fail"].join("\n");

describe("testFailureNames", () => {
  test("REGRESSION: extracts the two failures the gate reported as zero", () => {
    const names = testFailureNames(BUN_FAILING_OUTPUT);
    expect(names.size).toBe(2);
    expect([...names]).toContain("isEditIntentGoal > does NOT match a mutation verb with no concrete file");
    expect([...names]).toContain("isEditIntentGoal > requires a file EXTENSION, not just a repos/ prefix");
  });

  test("strips the trailing duration so the same test matches across runs", () => {
    // Names are compared set-wise between base and overlay; a duration baked into
    // the name makes every test look "new" on every run.
    for (const n of testFailureNames(BUN_FAILING_OUTPUT)) expect(n).not.toMatch(/\[[\d.]+m?s\]$/);
  });

  test("does not count passing tests", () => {
    expect(testFailureNames(BUN_PASSING_OUTPUT).size).toBe(0);
  });

  test("still understands the legacy (fail) format", () => {
    expect([...testFailureNames(LEGACY_OUTPUT)]).toEqual(["suite > a legacy failure name"]);
  });
});

describe("testFailureParseIsConsistent", () => {
  // THIS IS THE DURABLE HALF. The regex was the instance; trusting an empty
  // parse as a measurement is the class. A parser that returns nothing must not
  // be indistinguishable from a green suite.
  test("catches a dead parser: bun says 2 fail, we extracted none", () => {
    expect(testFailureParseIsConsistent(BUN_FAILING_OUTPUT, new Set())).toBe(false);
  });

  test("accepts a real parse that agrees with the summary", () => {
    const names = testFailureNames(BUN_FAILING_OUTPUT);
    expect(testFailureParseIsConsistent(BUN_FAILING_OUTPUT, names)).toBe(true);
  });

  test("accepts the ordinary green run: 0 fail and nothing parsed", () => {
    expect(testFailureParseIsConsistent(BUN_PASSING_OUTPUT, new Set())).toBe(true);
  });

  test("flags a green summary contradicted by parsed failures", () => {
    expect(testFailureParseIsConsistent(BUN_PASSING_OUTPUT, new Set(["x > y"]))).toBe(false);
  });

  test("no summary line means nothing to contradict", () => {
    expect(testFailureParseIsConsistent("some unrelated output", new Set())).toBe(true);
  });
});
