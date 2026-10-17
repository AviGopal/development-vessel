// I-T (d): THE TWO PERSISTENCE WRITERS ARE DESCRIBED TO DISCOVERY. Target inference saw shape names only, so a goal
// worded around its deliverable ("note each issue as a gap") missed the write. A description names the capability and
// the pointer fields the resolver actually reads, so a described-producer choice can bind it.
import { describe, expect, it } from "bun:test";
import { config } from "../../src/config.js";

const D = config.discovery.shapeDescriptions as Record<string, string>;

describe("substrateGap_write and memoryNote_write are described", () => {
  it("[MUST-FAIL] both are described, and both are advertised shapes", () => {
    for (const s of ["substrateGap_write", "memoryNote_write"]) {
      expect(typeof D[s]).toBe("string");
      expect((config.discovery.shapes as readonly string[]).includes(s)).toBe(true);
    }
  });
  it("[MUST-FAIL] each description names the fields its resolver requires", () => {
    // resolveSubstrateGapWrite's refusal names gap {id, category, source, status, detected_at, summary};
    // resolveMemoryNoteWrite requires a title or a body.
    for (const f of ["id", "category", "source", "status", "detected_at", "summary"]) expect(D["substrateGap_write"]).toContain(f);
    for (const f of ["title", "body"]) expect(D["memoryNote_write"]).toContain(f);
  });
  it("[PIN] exactly the two existing descriptions plus these two (no other description changed or added)", () => {
    expect(Object.keys(D).sort()).toEqual(["gapDecomposition", "git_log", "memoryNote_write", "substrateGap_write"]);
  });
});
