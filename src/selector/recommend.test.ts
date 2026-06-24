/**
 * Smoke tests — verifiable with `bun test`.
 * Ensures recommend() never returns null Thompson scores.
 */

import { describe, it, expect } from "bun:test";
import { recommend } from "./recommend";
import { recordOutcome } from "./activity-shape-store";

describe("recommend", () => {
  it("returns a non-null thompsonScore for every candidate — unseen pair", () => {
    const results = recommend([
      { activity: "compose-concept-relevance-backfill-v2-to-development-vessel", shape: "activity-lifecycle-a" },
      { activity: "compose-concept-relevance-backfill-v2-to-development-vessel", shape: "activity-lifecycle-b" },
    ]);

    expect(results.length).toBe(2);
    for (const r of results) {
      expect(typeof r.thompsonScore).toBe("number");
      expect(Number.isFinite(r.thompsonScore)).toBe(true);
      expect(r.thompsonScore).not.toBeNull();
    }
  });

  it("returns a non-null thompsonScore after recording outcomes", () => {
    recordOutcome("test-activity", "shape-x", true);
    recordOutcome("test-activity", "shape-x", true);
    recordOutcome("test-activity", "shape-x", false);

    const results = recommend([
      { activity: "test-activity", shape: "shape-x" },
    ]);

    expect(results.length).toBe(1);
    expect(typeof results[0]!.thompsonScore).toBe("number");
    expect(Number.isFinite(results[0]!.thompsonScore)).toBe(true);
  });

  it("sorts candidates by thompsonScore descending", () => {
    // Seed one shape heavily toward success to bias the draw
    for (let i = 0; i < 200; i++) {
      recordOutcome("sort-test", "high-success", true);
    }
    for (let i = 0; i < 200; i++) {
      recordOutcome("sort-test", "low-success", false);
    }

    // Over many trials the high-success shape should almost always rank first
    let highFirst = 0;
    const TRIALS = 50;
    for (let t = 0; t < TRIALS; t++) {
      const results = recommend([
        { activity: "sort-test", shape: "low-success" },
        { activity: "sort-test", shape: "high-success" },
      ]);
      if (results[0]?.shape === "high-success") highFirst++;
    }
    // Expect high-success to win at least 80% of the time
    expect(highFirst).toBeGreaterThan(TRIALS * 0.8);
  });

  it("returns empty array for empty input", () => {
    expect(recommend([])).toEqual([]);
  });
});
