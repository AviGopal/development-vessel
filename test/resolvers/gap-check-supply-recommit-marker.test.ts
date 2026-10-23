// A RE-COMMIT CHILD IS SKIPPED BY ITS MARKER, NEVER BY ITS ID (2026-10-23).
//
// checkSupplyDisposition skipped any row whose id starts with "recommit-" as well as a marked re-commit child
// (re_commit:true with a failure_class, the record feature_compose writes for a discarded draft's failure). The id
// prefix is a name, not a marker: an open real defect gap, recommit-children-are-never-retired-when-their-parent-is-
// fixed, is ABOUT re-commits, carries no re_commit marker, and was never supplied a check. Research counted 25 open
// recommit- rows without the marker; 4 of them unarmed and never supplied.
//
// THE CONTRACT: only the marker skips. MUST-FAIL: an unmarked open, unarmed row whose id starts with recommit- is
// supplied (a non-null disposition). CONTROL: a marked draft child (re_commit:true plus failure_class) is skipped
// whatever its id; the same unmarked row under another id is supplied, as before.
import { describe, expect, it } from "bun:test";
import { CHECK_SUPPLY_DISPOSITION } from "../../src/judge/gap-eligibility.js";
import { checkSupplyDisposition } from "../../src/resolvers/gap-check-supply.js";

type Row = Record<string, unknown>;
/** The live row's shape: an open, unarmed, system-detected defect with an edit site and no re_commit marker. */
const realDefect = (id: string): Row => ({
  id,
  status: "open",
  category: "systematic_failure",
  source: "substrate_detected",
  summary: "Re-commit children are never retired when their parent is fixed: closeAncestorsOnSamePredicate closes ancestors, never the recommit- children of a fixed parent.",
  classification_metadata: { falsifier: "none", edit_site: "repos/development-vessel/src/resolvers/gap-to-feature.ts" },
});
const draftChild = (id: string): Row => ({
  id,
  status: "open",
  category: "compose_failure",
  summary: "compose for gap gap-001 repeated already-recorded failure class dangling_reference: introduced new dangling import",
  classification_metadata: { re_commit: true, source_gap_id: "gap-001", root_gap_id: "gap-001", failure_class: "dangling_reference", edit_site: "repos/development-vessel/src/resolvers/gap-to-feature.ts" },
});

describe("check supply skips a re-commit child by its marker only", () => {
  it("[MUST-FAIL] an unmarked real defect gap whose id starts with recommit- is supplied", () => {
    expect(checkSupplyDisposition(realDefect("recommit-children-are-never-retired-when-their-parent-is-fixed"))).toBe(CHECK_SUPPLY_DISPOSITION);
  });
  it("[CONTROL] the same unmarked row under another id is supplied, as before", () => {
    expect(checkSupplyDisposition(realDefect("children-are-never-retired-when-their-parent-is-fixed"))).toBe(CHECK_SUPPLY_DISPOSITION);
  });
  it("[CONTROL] a marked draft child is skipped, whatever its id", () => {
    expect(checkSupplyDisposition(draftChild("recommit-gap-001-dangling_reference"))).toBeNull();
    expect(checkSupplyDisposition(draftChild("gap-001-draft-child"))).toBeNull();
  });
});
