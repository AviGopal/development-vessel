import { describe, test, expect } from "bun:test";
import * as gapCheckSupply from "../../src/resolvers/gap-check-supply.js";

// It is imported in gap-check-supply.ts, so it should be exported.
import { CHECK_SUPPLY_DISPOSITION } from "../../src/judge/gap-eligibility.js";

describe("gap-check-supply: checkSupplyDisposition supply filter", () => {
  test("should return null for a gap in a protected vessel", () => {
    // This test reproduces a defect where the gap_check_supply logic does not
    // apply admission filters like autonomy scope before selecting candidates
    // for test-writing.

    // This gap is 'open' and 'unarmed' (no class1/class2 check), which would
    // normally make it a candidate. However, its edit_site is inside
    // 'identity-vessel', which is a protected vessel and should be excluded.
    const gapInProtectedVessel = {
      id: "gaps:some-id",
      status: "open",
      symptom: "A gap in a protected vessel that should be excluded.",
      meta: {
        edit_site: "repos/identity-vessel/src/index.ts",
      },
    };

    // The bug: checkSupplyDisposition does not consult autonomyScopeExcludes.
    // It will see an 'unarmed' gap and incorrectly return CHECK_SUPPLY_DISPOSITION.
    const disposition = gapCheckSupply.checkSupplyDisposition(gapInProtectedVessel as any);

    // The correct behavior is for the function to return null, excluding this
    // gap from the test-writing supply. This assertion will fail, demonstrating
    // the defect.
    expect(disposition).toBe(null);
  });
});
