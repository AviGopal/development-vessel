import { describe, expect, test } from "bun:test";
import * as mod from "../../src/resolvers/gap-check-supply.js";
import type { Row } from "../../src/resolvers/compose-placement.js";

describe("checkSupplySite", () => {
  test("returns test file when it's the only src match in summary (DEFECT)", () => {
    const row: Row = {
      summary: "fails in src/jobs/x.n1.test.ts",
      call_path: "src/jobs/x.ts"
    };
    const result = mod.checkSupplySite(row, "development-vessel");
    // Current defect: returns the test file when it should return the call_path
    expect(result).toBe("repos/development-vessel/src/jobs/x.ts");
  });

  test("returns null when only test files are matched in summary (CONTROL)", () => {
    const row: Row = {
      summary: "fails in src/jobs/x.n1.test.ts",
    };
    const result = mod.checkSupplySite(row, "development-vessel");
    // Correct behavior: returns null when no non-test src file is matched
    expect(result).toBeNull();
  });
});