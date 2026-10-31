// A narrowed child carries its parent's failed_attempts.
//
// narrowedChildRecord (the one builder for chronic-failure and semantic-dissent children) wrote failed_attempts: 0 on
// every child. The chronic caller narrows a parent at failed_attempts >= 3, so the child was born with the attempt
// history wiped: it scored as fresh work and outranked the parent whose failures it repeats. The attempt history
// stays with the family: the child is born with the parent's count, never lower.

import { describe, it, expect } from "bun:test";
import { narrowedChildRecord, shouldNarrowForChronicFailure } from "../../src/judge/gap-attempt-credit.js";

const parentMeta = (fa: number): Record<string, unknown> => ({
  edit_site: "repos/development-vessel/src/resolvers/fixture-site.ts",
  failed_attempts: fa,
  last_failed_at: "2026-10-30T12:00:00.000Z",
  failure_lessons: [{ class: "verify_failed", reason: "the drafted change left the check red", at: "2026-10-30T12:00:00.000Z" }],
});
const parent = (meta: Record<string, unknown>) => ({ id: "fixture-parent", category: "systematic_failure", source: "human_reported", summary: "fixture parent", status: "open", classification_metadata: meta });
const childMeta = (meta: Record<string, unknown>, checks: "inherit" | "drop") =>
  narrowedChildRecord(parent(meta), meta, { id: "fixture-parent-narrowed", checks, summaryTail: "", extra: {} }).classification_metadata as Record<string, unknown>;

describe("narrowedChildRecord: the child carries the parent's failed_attempts", () => {
  for (const checks of ["inherit", "drop"] as const) {
    it(`[MUST-FAIL] (${checks}): a child narrowed from a parent at failed_attempts 3 is not born below 3`, () => {
      const cm = childMeta(parentMeta(3), checks);
      expect(Number(cm["failed_attempts"] ?? 0)).toBeGreaterThanOrEqual(3);
      expect(cm["failed_attempts"]).toBe(3);
    });

    it(`[MUST-FAIL] (${checks}): a parent at failed_attempts 7 gives a child at 7, with the parent's lineage`, () => {
      const cm = childMeta(parentMeta(7), checks);
      expect(cm["failed_attempts"]).toBe(7);
      expect(cm["parent_gap_id"]).toBe("fixture-parent");
      expect(cm["last_failed_at"]).toBe("2026-10-30T12:00:00.000Z");
    });

    it(`control (${checks}): the parent's own accounting is not changed by building the child`, () => {
      const meta = parentMeta(4);
      childMeta(meta, checks);
      expect(meta["failed_attempts"]).toBe(4);
      expect(meta["parent_gap_id"]).toBeUndefined();
    });
  }

  it("control: a parent that never failed gives a child that never failed (nothing is invented)", () => {
    const meta = parentMeta(0); delete meta["failed_attempts"];
    expect(Number(childMeta(meta, "inherit")["failed_attempts"] ?? 0)).toBe(0);
  });

  it("control: a non-narrowed row is not narrowed below the threshold, and a child never narrows again", () => {
    expect(shouldNarrowForChronicFailure(2, parentMeta(2))).toBe(false);
    expect(shouldNarrowForChronicFailure(3, parentMeta(3))).toBe(true);
    const cm = childMeta(parentMeta(3), "inherit");
    expect(shouldNarrowForChronicFailure(Number(cm["failed_attempts"]) + 1, cm)).toBe(false);
  });
});
