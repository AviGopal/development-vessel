// Pins the recall key for the drafter's lesson block.
//
// THE DEFECT: composeLessonsBlock sent NO query, so the same eight rows came back for
// 132 consecutive composes under the heading "KNOWN FAILURE MODES from this
// substrate's own rejected composes" — a fixed list read as targeted advice.
//
// The spec is NOT a usable key and was measured twice and reverted twice: a compose
// spec is code-shaped so its distinctive terms are identifiers, while the corpus is
// prose keyed on failure-class names. 2000 chars of TypeScript returns nothing; a
// bare `anchor_not_found` returns "old_string anchors must be copied verbatim from
// the CURRENT file content shown in the grounding" immediately.
//
// Only the MOST RECENT class is sent. Joining several was measured and rejected:
// `@@` is AND, so a join matches none of them and concept-db's relaxation ladder then
// picks the LONGEST name — a join of four returned typecheck_dangling_reference (28
// chars) over anchor_not_found. Length is not recency.

import { describe, expect, test } from "bun:test";
import { gapFailureClasses } from "../../src/resolvers/feature-compose.js";

const L = (cls: string, at: string) => ({ class: cls, at });

describe("gapFailureClasses", () => {
  test("returns the most recent class FIRST — it is the mistake about to be repeated", () => {
    const meta = { failure_lessons: [L("syntax_break", "2026-08-10T15:00:00Z"), L("anchor_not_found", "2026-08-10T18:00:00Z")] };
    expect(gapFailureClasses(meta)[0]).toBe("anchor_not_found");
  });

  test("dedupes repeated classes, keeping the most recent ordering", () => {
    const meta = { failure_lessons: [
      L("verify_failed", "2026-08-10T10:00:00Z"),
      L("anchor_not_found", "2026-08-10T18:00:00Z"),
      L("verify_failed", "2026-08-10T17:00:00Z"),
    ] };
    expect(gapFailureClasses(meta)).toEqual(["anchor_not_found", "verify_failed"]);
  });

  test("returns [] for a gap that has never failed — the query is then omitted entirely", () => {
    expect(gapFailureClasses({})).toEqual([]);
    expect(gapFailureClasses({ failure_lessons: [] })).toEqual([]);
    expect(gapFailureClasses(undefined)).toEqual([]);
  });

  test("ignores malformed lesson entries rather than emitting junk as a query", () => {
    const meta = { failure_lessons: [{ class: 42 }, { class: "  " }, {}, L("anchor_not_found", "2026-08-10T18:00:00Z")] };
    expect(gapFailureClasses(meta)).toEqual(["anchor_not_found"]);
  });

  test("survives failure_lessons that is not an array", () => {
    expect(gapFailureClasses({ failure_lessons: "nope" })).toEqual([]);
  });

  test("tolerates missing timestamps without throwing", () => {
    const meta = { failure_lessons: [{ class: "syntax_break" }, { class: "anchor_not_found" }] };
    expect(gapFailureClasses(meta).length).toBe(2);
  });
});
