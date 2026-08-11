// Pins that a quoted ROUTE PATH survives locator extraction.
//
// THE OBSERVED FAILURE (2026-08-11). A goal named four routes by their literal
// paths — '/selection-events' and siblings — and asked for the one thing that
// requires editing exactly the line those paths appear on. The extractor's
// character class demanded `[A-Za-z_$]` first, so every one of them was rejected on
// its leading slash. The compose received 62 locator candidates, none of them a
// route path, centred its anchor band elsewhere, and drafted anchors that were
// real, whole-file-unique, and in the wrong region (`interface ExecutionTrace {`,
// `WHERE variant_id = $variant_id`). The route path occurs EXACTLY ONCE in that
// file, on the line the edit needed.
//
// The single most precise locator the goal contained, discarded by a character
// class — with every downstream stage then working perfectly on the wrong region.
import { describe, expect, test } from "bun:test";
import { regionCandidatesFromText } from "./region-probe";

describe("quoted route paths are locators", () => {
  test("the exact goal text that failed now yields its route paths", () => {
    const goal =
      "In repos/activity-api/src/routes/execution-traces.ts, the GET routes '/selection-events', " +
      "'/selection-outcomes', '/selection-calibration' and '/calibration-summary' can never be called.";
    const out = regionCandidatesFromText(goal);
    for (const r of ["/selection-events", "/selection-outcomes", "/selection-calibration", "/calibration-summary"]) {
      expect(out).toContain(r);
    }
  });

  test("route paths are TIER-1 — quoted provenance outranks anything merely scraped", () => {
    // Ordering is the whole lever: the band centres on the FIRST candidate that
    // occurs in the file, so a scraped identifier winning would reproduce the bug.
    const out = regionCandidatesFromText(
      "the '/selection-events' route is shadowed by executionTrace handling in normalizePersistedTask",
    );
    expect(out[0]).toBe("/selection-events");
  });

  test("a quoted FILE path is a locator of the same kind", () => {
    expect(regionCandidatesFromText("see `src/routes/execution-traces.ts` for the handler"))
      .toContain("src/routes/execution-traces.ts");
  });

  test("backticks and double quotes work too, not just single", () => {
    expect(regionCandidatesFromText('the `/selection-events` route')).toContain("/selection-events");
    expect(regionCandidatesFromText('the "/selection-events" route')).toContain("/selection-events");
  });
});

describe("the widened class does not admit noise", () => {
  test("separator-only tokens locate nothing", () => {
    for (const t of ["'/'", "'//'", "'////'", "'/./'"]) {
      expect(regionCandidatesFromText(`a ${t} b`)).not.toContain(t.replace(/'/g, ""));
    }
  });

  test("too-short paths are still rejected by the length bound", () => {
    expect(regionCandidatesFromText("a '/a' b")).not.toContain("/a");
  });

  test("ordinary identifiers still extract, unchanged", () => {
    const out = regionCandidatesFromText("the `isFailoverError` predicate guards the beta increment");
    expect(out).toContain("isFailoverError");
  });

  test("empty and garbage input is safe", () => {
    expect(regionCandidatesFromText("")).toEqual([]);
    expect(regionCandidatesFromText(undefined as unknown as string)).toEqual([]);
  });
});
