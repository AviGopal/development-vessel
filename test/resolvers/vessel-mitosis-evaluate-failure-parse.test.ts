import { describe, expect, test } from "bun:test";
import {
  testFailureNames,
  testFailureParseIsConsistent,
} from "../../src/resolvers/vessel-mitosis-evaluate";

/**
 * TTY-form bun output, captured from an interactive shell.
 *
 * CORRECTION (2026-08-09): this fixture was originally introduced with the claim
 * that it proved the parser dead. It did not. Bun emits `(pass)`/`(fail)` when
 * stdout is a PIPE — which is how the gate always spawns it — and the coloured
 * tick/cross only on a TTY. So the ORIGINAL `(fail)` pattern was correct for the
 * only context that matters, and the "inert parser" story was wrong; the real
 * defect was symlinked test files importing unpatched source (see buildOverlay).
 *
 * The fixture is KEPT because both spellings are now accepted and that property
 * deserves a test: a run that somehow retains a TTY, or a future bun that changes
 * its non-TTY format, must not silently yield an empty failure set.
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
  test("parses the TTY cross form (not what the gate sees, but must not silently empty)", () => {
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
