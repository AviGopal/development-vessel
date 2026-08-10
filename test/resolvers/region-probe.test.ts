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

  it("orders longest first WITHIN a tier", () => {
    const out = regionCandidatesFromText("classifyComposeFailure and TC_EXIT both appear");
    expect(out.indexOf("classifyComposeFailure")).toBeLessThan(out.indexOf("TC_EXIT"));
  });

  it("a quoted anchor OUTRANKS a longer scraped identifier — the live regression", () => {
    // Real shape: the restatement's anchor clause beside a pasted failure excerpt.
    // Length-sorting everything made `noUncheckedIndexedAccess` (24) beat the anchor,
    // and the window centred on tsconfig options for many consecutive composes.
    const spec = 'The relevant code is around `classifyFailure`.\n' +
      'PRIOR FAILURE: error TS2345 under noUncheckedIndexedAccess in strictNullChecks mode';
    const out = regionCandidatesFromText(spec);
    expect(out[0]).toBe("classifyFailure");
    expect(out.indexOf("classifyFailure")).toBeLessThan(out.indexOf("noUncheckedIndexedAccess"));
  });

  it("keeps a scraped identifier available, just ranked below the quoted one", () => {
    const out = regionCandidatesFromText('around `shortName` plus someLongerIdentifierHere');
    expect(out[0]).toBe("shortName");
    expect(out).toContain("someLongerIdentifierHere");
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

describe("the probe is inert unless it plausibly locates", () => {
  // Mirrors focusedSlice's guard: present, and not sprayed through the file.
  const MAX = 8;
  const centresOn = (content: string, probes: string[]) =>
    probes.find((p) => {
      const at = content.indexOf(p);
      if (at < 0) return false;
      let n = 0;
      for (let k = content.indexOf(p); k !== -1 && n <= MAX; k = content.indexOf(p, k + 1)) n++;
      return n <= MAX;
    }) ?? null;

  it("REJECTS a token sprayed through the file — the live regression", () => {
    const content = "try {} finally {}\n".repeat(40);
    expect(centresOn(content, ["finally"])).toBeNull();
  });

  it("ACCEPTS a real symbol at its definition plus call sites", () => {
    // The measurement that killed the uniqueness rule: classifyComposeFailure
    // occurs 3x in the real file. Uniqueness would have rejected the true anchor.
    const content = "function classifyComposeFailure() {}\n" + "classifyComposeFailure();\n".repeat(2);
    expect(centresOn(content, ["classifyComposeFailure"])).toBe("classifyComposeFailure");
  });

  it("skips a sprayed candidate and takes the next viable one", () => {
    const content = "finally\n".repeat(30) + "function classifyComposeFailure() {}\n";
    expect(centresOn(content, ["finally", "classifyComposeFailure"])).toBe("classifyComposeFailure");
  });

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
