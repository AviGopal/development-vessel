import { describe, it, expect } from "bun:test";
import { pickRemovedLinePredicate, removedLinesFromDiff, MIN_REMOVED_LINE_LEN } from "../src/removed-line-predicate.js";

// A gap with nothing measurable can never close even when its fix lands: the sweep closes
// only on a MEASURED 'absent' and a predicate-less gap yields 'pending'. Measured 2026-08-31:
// 1366 of 1368 gaps carried no predicate.
//
// The previous attempt derived the literal from the gap SUMMARY (be26a6b, reverted): it ran
// after the cutover had already mirrored the fix, so the literal matched the POST-FIX file and
// read 'present' by construction. A line the diff REMOVED is present-in-parent and
// absent-at-commit by definition — there is no window in which that can be wrong.
const DIFF = [
  "diff --git a/src/resolvers/rhythm-conductor-tick.ts b/src/resolvers/rhythm-conductor-tick.ts",
  "--- a/src/resolvers/rhythm-conductor-tick.ts",
  "+++ b/src/resolvers/rhythm-conductor-tick.ts",
  "@@ -12,7 +12,7 @@",
  ' -  let present = process.env["DEV_OPERATOR_PRESENT"] === "1";'.slice(1),
  "+  const present = await operatorPresenceFromDiscovery();",
  " unchanged context line",
].join("\n");

describe("removedLinesFromDiff", () => {
  it("takes '-' lines and tags them with the destination path", () => {
    const out = removedLinesFromDiff(DIFF);
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("src/resolvers/rhythm-conductor-tick.ts");
    expect(out[0]!.line).toContain('process.env["DEV_OPERATOR_PRESENT"]');
  });

  it("ignores the '---' header, '+' lines and context", () => {
    // A naive `startsWith("-")` swallows the `--- a/…` header as a removed line.
    const out = removedLinesFromDiff(DIFF);
    expect(out.some((r) => r.line.startsWith("- a/"))).toBe(false);
    expect(out.some((r) => r.line.includes("operatorPresenceFromDiscovery"))).toBe(false);
    expect(out.some((r) => r.line.includes("unchanged context"))).toBe(false);
  });

  it("reports the destination path on a rename, not the source", () => {
    // The oracle will read the file that exists after the fix.
    const d = ["--- a/old/path.ts", "+++ b/new/path.ts", "-const somethingLongEnough = 1;"].join("\n");
    expect(removedLinesFromDiff(d)[0]!.path).toBe("new/path.ts");
  });

  it("emits nothing for a deletion into /dev/null", () => {
    const d = ["--- a/src/x.ts", "+++ /dev/null", "-const somethingLongEnough = 1;"].join("\n");
    expect(removedLinesFromDiff(d)).toHaveLength(0);
  });

  it("is safe on empty or non-string input", () => {
    expect(removedLinesFromDiff("")).toEqual([]);
    expect(removedLinesFromDiff(undefined as unknown as string)).toEqual([]);
  });
});

describe("pickRemovedLinePredicate", () => {
  it("picks the removed line — present in the parent, absent at the commit, by construction", () => {
    const p = pickRemovedLinePredicate(DIFF);
    expect(p).not.toBeNull();
    expect(p!.line).toBe('let present = process.env["DEV_OPERATOR_PRESENT"] === "1";');
  });

  it("PREFERS a candidate the gap summary also names — provably absent AND named by the spec", () => {
    const d = [
      "+++ b/src/a.ts",
      "-const incidentalButVeryLongIndeed = computeSomething(alpha, beta);",
      "-let present = process.env[\"DEV_OPERATOR_PRESENT\"];",
    ].join("\n");
    const summary = 'law-1 violation: `let present = process.env["DEV_OPERATOR_PRESENT"];` is read at module load';
    // The incidental line is LONGER, so this only passes if summary-naming wins over length.
    expect(pickRemovedLinePredicate(d, summary)!.line).toBe('let present = process.env["DEV_OPERATOR_PRESENT"];');
  });

  it("falls back to the longest candidate when the summary names none", () => {
    const d = ["+++ b/src/a.ts", "-const shortOneHereOk = 1;", "-const aMuchLongerRemovedLineHere = compute(x);"].join("\n");
    expect(pickRemovedLinePredicate(d, "prose that quotes nothing")!.line)
      .toBe("const aMuchLongerRemovedLineHere = compute(x);");
  });

  it("REFUSES a comment — reworded, not fixed", () => {
    // A comment-anchored predicate reads absent the moment someone edits the comment, closing
    // the gap green with the defect untouched. This is the exact failure 196e755 chased.
    const d = ["+++ b/src/a.ts", "-  // re-test path (penalty, not hard exclusion)"].join("\n");
    expect(pickRemovedLinePredicate(d)).toBeNull();
  });

  it("REFUSES punctuation, short lines and imports", () => {
    for (const line of ["-  }", "-  });", "-  return;", '-import { x } from "./y";']) {
      expect(pickRemovedLinePredicate(["+++ b/src/a.ts", line].join("\n"))).toBeNull();
    }
    expect(MIN_REMOVED_LINE_LEN).toBeGreaterThan(8);
  });

  it("returns null for a pure-insertion diff — no predicate is the SAFE outcome", () => {
    // Nothing was removed, so nothing is provably absent. The gap stays 'pending' and the
    // sweep abstains and asks a human, which is correct.
    const d = ["+++ b/src/a.ts", "+const addedOnlyLineHere = 1;", " context"].join("\n");
    expect(pickRemovedLinePredicate(d)).toBeNull();
  });
});
