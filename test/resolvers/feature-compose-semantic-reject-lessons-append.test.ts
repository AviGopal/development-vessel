// THE SEMANTIC-REJECT WRITE-BACK APPENDS TO THE ROW'S LESSONS (verified bug, qa 2026-10-24). feature_compose's
// spec-matched write-back on an UNFAVORABLE semantic gate read matched["failure_lessons"] at the row's TOP level. The
// store keeps lessons under classification_metadata (node1: 0 of 4,296 open rows with a top-level list, 930 with it
// under classification_metadata), so it always read [] and wrote classification_metadata.failure_lessons as ONE entry,
// erasing the gap's per-gap drafter memory each time it fired. semanticRejectLessons reads them where they live and
// appends under the existing cap (8). Pinned on the helper and, on the source, on the write-back's use of it.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fc = await import("../../src/resolvers/feature-compose.js") as Record<string, unknown>;
type L = Record<string, unknown>;
const lesson = (i: number): L => ({ at: `t${i}`, class: "verify_failed", reason: `r${i}` });
const NEW: L = { at: "now", class: "semantic_reject", reason: "the draft misses the gap", raw_excerpt: "the draft misses the gap" };
const append = (row: L): L[] => (fc["semanticRejectLessons"] as (m: L, l: L) => L[])(row, NEW);

describe("the semantic-reject lesson is appended to classification_metadata.failure_lessons", () => {
  it("[MUST-FAIL] a row with 3 lessons has 4 after the write-back, not 1", () => {
    expect(typeof fc["semanticRejectLessons"]).toBe("function");
    const out = append({ id: "g", classification_metadata: { failure_lessons: [lesson(1), lesson(2), lesson(3)] } });
    expect(out).toEqual([lesson(1), lesson(2), lesson(3), NEW]);
  });
  it("[CONTROL] an empty row gets 1; the cap keeps the last 8", () => {
    expect(append({ id: "g", classification_metadata: {} })).toEqual([NEW]);
    expect(append({ id: "g" })).toEqual([NEW]);
    const full = append({ id: "g", classification_metadata: { failure_lessons: [1, 2, 3, 4, 5, 6, 7, 8].map(lesson) } });
    expect(full).toHaveLength(8);
    expect(full[0]).toEqual(lesson(2));
    expect(full[7]).toEqual(NEW);
  });
  it("[MUST-FAIL] the UNFAVORABLE write-back computes its failure_lessons through the helper, and no top-level read is left", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "feature-compose.ts"), "utf8");
    expect(src.split("semanticRejectLessons(matched, newLesson)").length - 1).toBe(1);
    expect(src).not.toContain("[...existingLessons, newLesson]");
    expect(src).not.toContain("const existingLessons: Array<Record<string, unknown>> = Array.isArray(matched[\"failure_lessons\"])");
  });
});
