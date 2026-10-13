import { describe, test, expect } from "bun:test";
import * as mod from "../../src/resolvers/gap-to-feature.js";

describe("Reproduce typecheck_dangling_reference from route-edit-ef9810e8", () => {
  test("property access on string array elements demonstrates type confusion", () => {
    const summary = "a summary about a some-real-gap";
    const rows = mod.decomposeSummaryTerms(summary); // returns ['summary', 'about', 'some_real_gap']

    // The original failing code likely assumed `rows` was an array of objects, e.g.:
    //   `expect(rows.some((r) => r["id"] === "some-real-gap")).toBe(true);`
    // This would fail to typecheck because elements `r` are strings, not objects.
    // To demonstrate the behavioral consequence of this type error in a valid test,
    // we can cast the element to `any`.
    const hasGapById = rows.some((r: any) => r["id"] === "some-real-gap");

    // At runtime, `r` is a string (e.g., "some_real_gap").
    // `r["id"]` is `undefined`.
    // The `.some()` call therefore returns `false`.
    // This `expect` fails, successfully reproducing the problem as a runtime test failure.
    expect(hasGapById).toBe(true);
  });
});
