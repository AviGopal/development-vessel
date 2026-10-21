// A narrowed child does not inherit its parent's check-supply ledger.
//
// narrowedChildRecord (the one builder for chronic-failure and semantic-dissent children) copied every
// classification_metadata key not in its never-inherit list, check_supply included. Two children were
// observed carrying check_supply.state "armed" with armed_at IDENTICAL to their parent's: the "arm" was
// the parent's check. gap-check-supply then skips the child as already armed, so it never arms on its own
// check, and expiry reads the parent's arm as the child's. The fixture follows those stored rows' shape.

import { describe, it, expect } from "bun:test";
import { narrowedChildRecord } from "../../src/judge/gap-attempt-credit.js";

const T = "2026-10-14T17:07:01.650Z";
const parentMeta = (): Record<string, unknown> => ({
  edit_site: "repos/development-vessel/src/resolvers/fixture-site.ts",
  failed_attempts: 3,
  gap_check_supply_arm: "treatment",
  check_supply: {
    state: "armed",
    attempts: 2,
    last_dispatch_at: "2026-10-14T11:07:56.993Z",
    test_file: "test/checks/fixture-parent.check.ts",
    vessel: "development-vessel",
    mode: "check_file",
    baseline_titles: [],
    edit_site: "repos/development-vessel/src/resolvers/fixture-site.ts",
    dispatch_id: "00000000-0000-4000-8000-000000000000",
    last_verdict: "present",
    armed_at: T,
    red_at_head: true,
  },
});
const parent = (meta: Record<string, unknown>) => ({ id: "fixture-parent", category: "edit_intent_route", source: "human_reported", summary: "fixture parent", status: "open", classification_metadata: meta });

describe("narrowedChildRecord: the child starts its own check-supply ledger", () => {
  for (const checks of ["drop", "inherit"] as const) {
    it(`MUST-FAIL (${checks}): a child narrowed from an armed parent carries no inherited armed state`, () => {
      const meta = parentMeta();
      const child = narrowedChildRecord(parent(meta), meta, { id: "fixture-parent-narrowed", checks, summaryTail: "", extra: {} });
      const cm = child.classification_metadata as Record<string, unknown>;
      const cs = cm["check_supply"] as { state?: unknown; armed_at?: unknown } | undefined;
      expect(cs?.state).not.toBe("armed");
      expect(cs?.armed_at).not.toBe(T);
      expect(cm["check_supply"]).toBeUndefined();
    });

    it(`control (${checks}): the defect's localisation still carries over, and the parent is not mutated`, () => {
      const meta = parentMeta();
      const child = narrowedChildRecord(parent(meta), meta, { id: "fixture-parent-narrowed", checks, summaryTail: "", extra: {} });
      const cm = child.classification_metadata as Record<string, unknown>;
      expect(cm["edit_site"]).toBe("repos/development-vessel/src/resolvers/fixture-site.ts");
      expect(cm["parent_gap_id"]).toBe("fixture-parent");
      expect((meta["check_supply"] as { state?: unknown }).state).toBe("armed");
    });
  }
});
