import { describe, expect, test } from "bun:test";

// Per the spec, import the module as a namespace to assert on its contents.
import * as tickModule from "../../src/seed/gap-lifecycle-tick.js";

describe("gap-lifecycle-tick defect: region_lint is not scheduled", () => {
  test("the tick MUST schedule a region_lint scan to surface bad armed regions", () => {
    // The defect is that `gap-lifecycle-scan` gained a `region_lint` mode, but
    // the `gap-lifecycle-tick` activity does not schedule it. This means that
    // badly armed regions are not automatically detected and require operator
    // intervention to find. This test reproduces the defect by asserting that
    // the tick's configuration for the scan includes `region_lint: true`.

    // The ActivityTemplate type is not fully available, so we cast to `any` for inspection.
    const template = (tickModule as any).GAP_LIFECYCLE_TICK_TEMPLATE;
    const scanTask = template.tasks.find((t: any) => t.resolver === "gap_lifecycle_scan");

    // This is a precondition check. If it fails, the task has been removed or
    // renamed, which is a different problem from the one this test targets.
    if (!scanTask) {
      expect.fail("Could not find 'gap_lifecycle_scan' task in the template.");
      return; // Return to satisfy TypeScript's type narrowing.
    }

    const scanConfig = scanTask.config;

    // This is the core failing assertion that reproduces the defect.
    // The config in `src/seed/gap-lifecycle-tick.ts` is missing `region_lint: true`,
    // so `scanConfig.region_lint` will be `undefined`, and `undefined` is not `true`.
    expect(scanConfig.region_lint).toBe(true);
  });
});
