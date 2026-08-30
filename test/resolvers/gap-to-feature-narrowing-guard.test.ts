import { describe, it, expect } from "bun:test";
import { shouldNarrowForChronicFailure } from "../../src/resolvers/gap-to-feature.js";

// Pins the fix for the recommit/narrow alternation loop that drove a CPU/thermal
// emergency (Tctl 100C, ~1500% container CPU) on 2026-08-29/30.
//
// feature-compose.ts's own retry-cap files a child gap id `recommit-<id>-<cls>` on
// compose failure, recording lineage as classification_metadata.source_gap_id (and
// re_commit:true) — never parent_gap_id. The narrowing guard here used to check ONLY
// parent_gap_id, so every recommit- gap looked like a fresh root and got narrowed too.
// If that narrowed result failed compose again, feature-compose wrapped it in another
// recommit- layer (again omitting parent_gap_id), making it eligible for narrowing all
// over again — each narrowing resets failed_attempts to 0, so the two independently-
// capped mechanisms alternated forever instead of either ever holding. Confirmed via
// the recommit-*-syntax_break-narrowed chain measured on 2026-08-07 (id:
// route-edit-2206dec0:1's lineage).
describe("shouldNarrowForChronicFailure", () => {
  it("does NOT narrow a recommit- gap (re_commit:true, source_gap_id set) even at fa>=3", () => {
    expect(
      shouldNarrowForChronicFailure(3, { re_commit: true, source_gap_id: "route-edit-2206dec0:1" }),
    ).toBe(false);
  });

  it("does NOT narrow a recommit- gap identified by source_gap_id alone", () => {
    expect(shouldNarrowForChronicFailure(5, { source_gap_id: "route-edit-abc123:1" })).toBe(false);
  });

  it("does NOT re-narrow an already-narrowed child (parent_gap_id set)", () => {
    expect(shouldNarrowForChronicFailure(3, { parent_gap_id: "route-edit-2206dec0:1" })).toBe(false);
  });

  it("DOES narrow a genuine root gap at fa>=3 (no parent_gap_id, re_commit, or source_gap_id)", () => {
    expect(shouldNarrowForChronicFailure(3, {})).toBe(true);
  });

  it("does not narrow a genuine root gap below the fa>=3 threshold", () => {
    expect(shouldNarrowForChronicFailure(2, {})).toBe(false);
  });
});
