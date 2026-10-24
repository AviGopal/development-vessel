import { test, expect, describe } from "bun:test";
import * as mod from "../../src/resolvers/reach-rate-scan";
import type {
  ReachRateScanPointer,
  StatsRow,
} from "../../src/resolvers/reach-rate-scan";

describe("reach-rate-scan: detector does not incorrectly credit fix on insufficient evidence", () => {
  test("a single successful run below the graded volume floor should not be treated as a cleared defect", async () => {
    // This test reproduces a defect where a check for a persistent failure (low reach rate)
    // passes if there's insufficient data to make a judgment.
    // Specifically, if the number of 'graded' runs after a fix is below 'min_graded_volume',
    // the resolver returns a report with `reach_rate: null` and omits the `reach_below_floor`
    // property.
    // A consumer of this resolver, seeing a successful execution ("exit status") and the
    // absence of the explicit failure property, may incorrectly conclude the defect is fixed
    // and close the corresponding gap. This is "credit by exit status" instead of by a
    // conclusive "reach verdict", as described in the goal.
    // The correct behavior is to continue reporting a failure state until there is
    // sufficient evidence (graded_count >= min_graded_volume) to confirm the fix.

    const pointer: ReachRateScanPointer = {
      type: "reach_rate_scan",
      activity_id: "activity-with-one-good-run",
      min_graded_volume: 10,
      min_reach_rate: 0.95,
      // We inject rows to bypass the network call to activity-api.
      _rows: [
        {
          activity_id: "activity-with-one-good-run",
          graded_count: 1, // One run, which is less than min_graded_volume.
          reach_rate: 1.0, // The run was successful.
          // Other fields are present to satisfy the StatsRow type.
          count: 1,
          reached_count: 1,
          success_rate: 1.0,
          ungraded_count: 0,
        } as StatsRow,
      ],
    };

    const result = await mod.resolveReachRateScan(pointer);

    // The resolver should produce a report.
    expect(result.shape).toBe("reachRateReport");
    expect(result.body).toBeDefined();

    // With graded_count < min_graded_volume, the current implementation sets reach_rate to null.
    // This causes the `stillBelow` check to be false, so `reach_below_floor` is omitted.
    // This assertion will fail, demonstrating the defect.
    // A correct implementation should still include `reach_below_floor` or another
    // signal indicating that the condition is not yet considered resolved.
    expect(Object.hasOwn(result.body as object, "reach_below_floor")).toBe(
      true,
      "The report body should have the 'reach_below_floor' property to indicate the defect is not cleared"
    );
  });
});
