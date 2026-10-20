import { describe, test, expect } from "bun:test";
import * as mod from "../../src/resolvers/gap-check-supply";

// DEFECT REPRO: check supply admits recommit-<gap>-<draft-failure-class> children.
// feature_compose files these with a summary like
//   "compose for gap <id> repeated already-recorded failure class <cls>: <reason>"
// and classification_metadata { re_commit:true, source_gap_id, root_gap_id, failure_class, edit_site }.
// These describe a discarded draft's failure, not a HEAD defect, so check-supply
// must SKIP them. Today, checkSupplyDisposition admits them, so this assertion
// fails because of the defect (non-null), not a load error.

describe("check-supply — recommit draft-failure children are not eligible for check-writing", () => {
  test("re-commit child is skipped (no supply)", () => {
    const row: any = {
      status: "open",
      summary:
        "compose for gap gap-001 repeated already-recorded failure class dangling_reference: introduced new dangling import",
      category: "compose_failure",
      // feature_compose writes these under classification_metadata
      classification_metadata: {
        re_commit: true,
        source_gap_id: "gap-001",
        root_gap_id: "gap-001",
        failure_class: "dangling_reference",
        // edit_site can be present on real rows; omission here maximizes the chance that
        // the current (defective) eligibility path treats this as supply-eligible.
      },
    };

    const got = mod.checkSupplyDisposition(row as any);
    // Correct behavior: SKIP recommit draft-failure children — return null.
    // Current defect: returns a non-null disposition (admitting a test-writing goal).
    expect(got).toBeNull();
  });
});
