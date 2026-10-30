import { describe, expect, test } from "bun:test";
import * as mod from "../../src/resolvers/gap-check-supply.js";

describe("gap-check-supply declaredTestTitles — escape handling", () => {
  test("MUST-FAIL: keeps a test whose title contains an escape — expected to include MUST-FAIL: goal's expected", () => {
    const src = `
import { test } from "bun:test";
// Two tests: one MUST-FAIL with an ESCAPED single quote, one CONTROL
// The escaped source contains a backslash in the literal — this is the reproduction.
test("MUST-FAIL: goal\\'s expected", () => {});
test("CONTROL: simple control", () => {});
`;
    const titles = mod.declaredTestTitles(src);
    // Expected (correct) behaviour: the escaped title survives baselineTitles collection.
    expect(titles).toContain("MUST-FAIL: goal's expected");
  });

  test("CONTROL: declaredTestTitles keeps a simple title without escapes", () => {
    const src = `
import { test } from "bun:test";
test("CONTROL: simple control", () => {});
`;
    const titles = mod.declaredTestTitles(src);
    expect(titles).toContain("CONTROL: simple control");
  });
});
