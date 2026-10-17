// THE DRAFTER IS GROUNDED WHERE THE GOAL'S QUOTED CODE IS, AND A FAR ANCHOR IS NEVER TRUSTED ANYWAY (M-6, 2026-10-17).
//
// Replays lane compose 8c20e9b8: a goal quoting `resolver_tier: "deterministic"` in light-dispatch's index.ts, where the
// bare word `deterministic` first occurs in a doc comment (line 10) and the literal sits at lines 824 and 907. The
// quoted-locator tier took one token only, so the span became `deterministic`, the window centred on the comment, the
// drafter anchored ~800 lines from what it was shown, and the anchor guard logged "TRUSTING THE UNIQUE ANCHOR".
//
// Pinned:
//   (a) [MUST-FAIL] the grounding window for that goal CONTAINS the quoted literal (it moves to where the literal is);
//       the whole quoted span is the first locator; a paraphrase quoting the same literal grounds the same way (G5).
//   (b) [MUST-FAIL] a unique anchor far from a region the drafter saw only a window of is re-derived, and refused with the
//       named reason anchor_far_from_grounded_region when re-derivation finds nothing (never "trust anyway"); an explicit
//       region refuses the same way; a drafter shown the whole file keeps its unique anchor.
//   (c) [CONTROL] a goal with no quoted code span locates and grounds exactly as before.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const rp = (await import("../../src/resolvers/region-probe.js")) as Record<string, any>;
const SRC = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "feature-compose.ts"), "utf8");

// A file shaped like light-dispatch-vessel/src/index.ts at 031c5e5 (1,197 lines; the word in a comment at line 10,
// the literal at 824 and 907, runDispatch defined at ~760).
function ldShaped(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 1200; i++) {
    if (i === 10) lines.push(" * instrumentation). Useful for deterministic multi-task chains");
    else if (i === 760) lines.push("async function runDispatch(template: Template, vars: Vars) {");
    else if (i === 824 || i === 907) lines.push(`      resolver_tier: "deterministic",`);
    else lines.push(`  const filler_${i} = compute(${i}, "padding text here");`);
  }
  return lines.join("\n");
}
const lineOf = (content: string, slice: string, needle: string): number => {
  const at = content.indexOf(slice);
  const start = content.slice(0, at).split("\n").length;
  const rel = slice.split("\n").findIndex((l) => l.includes(needle));
  return rel < 0 ? -1 : start + rel;
};
const GOAL = 'In repos/light-dispatch-vessel/src/index.ts, stop stamping `resolver_tier: "deterministic"` on every task record in runDispatch.';
const PARAPHRASE = 'runDispatch writes `resolver_tier: "deterministic"` for each task it records; light-dispatch-vessel src/index.ts should not.';

describe("(a) the window moves to the goal's quoted literal", () => {
  it("[MUST-FAIL] the whole quoted code span is the FIRST locator (not its last bare word)", () => {
    const c = rp.regionCandidatesFromText(GOAL) as string[];
    expect(c[0]).toBe('resolver_tier: "deterministic"');
  });
  it("[MUST-FAIL] the grounding window for the goal contains the literal at line 824, not the comment at line 10", () => {
    const content = ldShaped();
    const probes = rp.regionCandidatesFromText(GOAL) as string[];
    const sliced = fc.focusedSlice(content, 6000, [GOAL], probes) as { slice: string; centered: boolean };
    expect(sliced.centered).toBe(true);
    expect(sliced.slice).toContain('resolver_tier: "deterministic",');
    expect(lineOf(content, sliced.slice, 'resolver_tier: "deterministic",')).toBe(824);
    expect(sliced.slice).not.toContain("Useful for deterministic multi-task chains");
  });
  it("[PROPERTY] G5: a paraphrase quoting the same literal grounds on the same window (equal on the parent too, where both mis-locate)", () => {
    const content = ldShaped();
    const a = fc.focusedSlice(content, 6000, [GOAL], rp.regionCandidatesFromText(GOAL)) as { slice: string };
    const b = fc.focusedSlice(content, 6000, [PARAPHRASE], rp.regionCandidatesFromText(PARAPHRASE)) as { slice: string };
    expect(b.slice).toBe(a.slice);
  });
  it("[MUST-FAIL] a probe whose first occurrence is a comment centres on its first CODE occurrence (the guard's region)", () => {
    const content = ldShaped();
    const sliced = fc.focusedSlice(content, 6000, [], ["deterministic"]) as { slice: string };
    expect(sliced.slice).toContain('resolver_tier: "deterministic",');
    expect(sliced.slice).not.toContain("Useful for deterministic multi-task chains");
  });
});

describe("(b) a far anchor is re-derived, then refused with a named reason; never trusted anyway", () => {
  it("[MUST-FAIL] far from a mined region the drafter saw a window of -> re-derive (the parent trusted it)", () => {
    expect(typeof fc.anchorRegionVerdict).toBe("function");
    expect(fc.anchorRegionVerdict(800, 160, false, false)).toBe("rederive");
    expect(fc.anchorRegionVerdict(800, 160, true, false)).toBe("rederive");
    expect(fc.anchorRegionVerdict(800, 160, true, true)).toBe("rederive");
  });
  it("[MUST-FAIL] the refusal is named, says how far, and lands as the op's error", () => {
    expect(typeof fc.anchorFarRefusal).toBe("function");
    const r = fc.anchorFarRefusal("800 lines from the grounded region (line 10)") as string;
    expect(r.startsWith("anchor_far_from_grounded_region:")).toBe(true);
    expect(r).toContain("800 lines from the grounded region (line 10)");
    expect(JSON.stringify({ error: r }).slice(0, 200)).toContain("anchor_far_from_grounded_region");
  });
  it("[MUST-FAIL] wiring: the guard decides by the verdict, the trust-anyway branch is gone, and a far anchor that re-derivation could not move is REJECTED (not edited, not repaired)", () => {
    expect(SRC).toContain('anchorRegionVerdict(dist, ANCHOR_REGION_SLACK_LINES, !!regionHint, shownWhole) === "stands_whole"');
    expect(SRC).not.toContain("TRUSTING THE UNIQUE ANCHOR");
    expect(SRC).toContain("const anchorRejected = (anchorNonUnique || anchorFarFromRegion) && !groundedPre;");
    expect(SRC).toContain(": anchorFarRefusal(anchorFarDetail) } as Json }");
    // the blind-edit repair after a failed fs_edit is skipped for a rejected anchor, so the refusal is final
    expect(SRC).toContain("if (!r.ok && !anchorRejected && rederivedRefusal === null) {");
    // the whole-file exception reads the composer's own grounding record
    expect(SRC).toContain('groundingEntries.some((e) => e.mode === "whole" && norm(e.path) === norm(op.path))');
  });
  it("[CONTROL] near anchors stand; a drafter shown the WHOLE file keeps its far unique anchor when no region was given", () => {
    expect(fc.anchorRegionVerdict(100, 160, false, false)).toBe("near");
    expect(fc.anchorRegionVerdict(160, 160, true, false)).toBe("near");
    expect(fc.anchorRegionVerdict(800, 160, false, true)).toBe("stands_whole");
  });
});

describe("(c) a goal with no quoted code span is unchanged", () => {
  it("[CONTROL] single-token quotes and scraped identifiers keep their order; no span is added", () => {
    const g = "Fix `classifyComposeFailure` so TC_EXIT is reported, in src/resolvers/feature-compose.ts.";
    const c = rp.regionCandidatesFromText(g) as string[];
    expect(c[0]).toBe("classifyComposeFailure");
    expect(c).toContain("TC_EXIT");
    expect((rp.regionCandidatesFromText(g) as string[]).some((c) => /\s/.test(c))).toBe(false);
  });
  it("[CONTROL] a probe whose first occurrence is already a code line centres exactly where it did", () => {
    const content = ldShaped();
    const sliced = fc.focusedSlice(content, 6000, [], ["runDispatch"]) as { slice: string };
    const at = content.indexOf("runDispatch");
    const start = Math.max(0, at - Math.floor(Math.min(content.length, 6000) / 3));
    expect(sliced.slice).toBe(content.slice(start, start + Math.min(content.length, 6000)));
  });
});
