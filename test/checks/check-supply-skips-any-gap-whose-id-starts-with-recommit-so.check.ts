import { test, expect } from "bun:test";
import * as mod from "../../src/resolvers/gap-check-supply";

/**
 * This test reproduces a regression where checkSupplyDisposition incorrectly skips gaps
 * whose IDs start with "recommit-" but which are not actual recommit-failure summaries.
 * The logic was intended to skip children of recommit gaps, but the `id.startsWith()`
 * check was too broad, causing it to filter out legitimate, unarmed gaps that are
 * candidates for check-supply.
 */
test("checkSupplyDisposition should NOT skip a gap whose id starts with recommit- but lacks the re_commit marker", () => {
  // This row represents a gap that is NOT a recommit-failure summary, but whose ID happens to start with "recommit-".
  // It is also "unarmed" (has no falsifier_path or edit_site), which makes it a candidate for check-supply.
  // The bug is that the check `id.startsWith("recommit-")` is too broad and incorrectly filters out this gap.
  const row = {
    id: "recommit-but-not-a-recommit-failure-summary-gap-id",
    status: "open",
    category: "test_failure", // Any category that isn't 'orphaned_capability' or 'unreachable_producer'
    summary: "A gap that needs a check and is incorrectly skipped",
    // `classification_metadata` is read by `metaOf()` in the function under test.
    classification_metadata: {
      // Key properties that make this gap eligible for check-supply but trigger the bug:
      // - NO `re_commit: true`
      // - NO `failure_class`
      // - NO `falsifier_path` or `edit_site`, which should make it "unarmed"
      //
      // Other properties are absent to avoid other filter paths:
      // - no operator_hold
      // - no parking disposition
      // - no expected_literal
      // - no hardcoded_url
      // - no falsifier_unresolvable_reason
    },
  };

  const disposition = mod.checkSupplyDisposition(row);

  // The disposition SHOULD be a non-null object because it's an open, unarmed gap.
  // Due to the bug, the function returns `null`. This assertion will fail.
  expect(disposition).not.toBeNull();
});
