// Pins the identifier probes that let grounding be windowed on the real change site.
//
// THE DEFECT: focusedSlice centres the grounding window on a primary probe, but the
// only two ways to supply one were classification_metadata.region (carried by 0 of 402
// live gaps) and a matcher demanding the literal phrase `in the region "<name>"` (which
// nothing emits — a goal whose FIRST WORDS were that phrase still produced region:null,
// because goal text is rewritten before becoming a gap summary). So every grounding was
// unwindowed at ~51,000 chars and anchor_not_found became the largest failure class.

import { describe, expect, it } from "bun:test";
import { regionCandidatesFromText } from "../../src/resolvers/region-probe.js";

describe("regionCandidatesFromText", () => {
  it("mines the identifier out of prose that names code", () => {
    const goal = "the routine classifyComposeFailure searches the combined output for codes";
    expect(regionCandidatesFromText(goal)).toContain("classifyComposeFailure");
  });

  it("mines SCREAMING_SNAKE markers", () => {
    expect(regionCandidatesFromText("the stage writes a TC_EXIT marker")).toContain("TC_EXIT");
  });

  it("mines snake_case table names", () => {
    expect(regionCandidatesFromText("rows in goal_execution_paths carry no org id"))
      .toContain("goal_execution_paths");
  });

  it("mines dotted paths like content.body", () => {
    expect(regionCandidatesFromText("the report sits at content.body instead")).toContain("content.body");
  });

  it("prefers a quoted span — an author who quotes is pointing", () => {
    const out = regionCandidatesFromText('look in `deriveVesselFromPath` please');
    expect(out[0]).toBe("deriveVesselFromPath");
  });

  it("NEVER returns a plain English word — it would match every file", () => {
    const out = regionCandidatesFromText("the routine that decides which kind of failure occurred is wrong");
    expect(out).toEqual([]);
  });

  it("drops prose words that merely look long", () => {
    const out = regionCandidatesFromText("because therefore concatenation measured successful");
    expect(out).toEqual([]);
  });

  it("orders longest first, since a longer identifier is rarer", () => {
    const out = regionCandidatesFromText("classifyComposeFailure and TC_EXIT both appear");
    expect(out.indexOf("classifyComposeFailure")).toBeLessThan(out.indexOf("TC_EXIT"));
  });

  it("dedupes repeats", () => {
    const out = regionCandidatesFromText("TC_EXIT then TC_EXIT again TC_EXIT");
    expect(out.filter((x) => x === "TC_EXIT").length).toBe(1);
  });

  it("never throws on junk input", () => {
    for (const junk of [null, undefined, 42, {}, []] as unknown[]) {
      expect(regionCandidatesFromText(junk as string)).toEqual([]);
    }
    expect(regionCandidatesFromText("")).toEqual([]);
  });
});

describe("the probe is inert unless it occurs in the file", () => {
  // Mirrors focusedSlice's guard: indexOf(probe) < 0 falls through to the existing
  // heuristics, so a wrong candidate can never move a window that was already right.
  const centresOn = (content: string, probes: string[]) => probes.find((p) => content.indexOf(p) >= 0) ?? null;

  it("a candidate absent from the file changes nothing", () => {
    expect(centresOn("function somethingElse() {}", ["classifyComposeFailure"])).toBeNull();
  });

  it("a candidate present in the file centres the window", () => {
    const content = "line\n".repeat(400) + "function classifyComposeFailure(a, b) {}\n" + "tail\n".repeat(400);
    expect(centresOn(content, ["classifyComposeFailure"])).toBe("classifyComposeFailure");
  });

  it("falls through candidate-by-candidate to the first that matches", () => {
    const content = "const TC_EXIT = 0;";
    expect(centresOn(content, ["classifyComposeFailure", "TC_EXIT"])).toBe("TC_EXIT");
  });
});
