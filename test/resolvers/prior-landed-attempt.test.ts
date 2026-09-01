import { describe, it, expect } from "bun:test";
import { priorAttemptFeedbackBlock } from "../../src/resolvers/feature-compose.js";

// Pins that a LANDED attempt reaches the drafter.
//
// Every branch of priorAttemptFeedbackBlock read REJECTION metadata, and its heading said so:
// "a previous draft for THIS gap was REJECTED by the semantic gate". A draft that PASSED the
// gate and LANDED contributed nothing to the next attempt — it arrived as silence.
//
// That is not a rare path. A gap carrying no closure predicate never closes, so it is re-picked
// AFTER its fix has landed, and a fresh drafter reads the same unchanged gap prose against a
// file that has already been changed. Measured 2026-08-31: four substrate-authored commits
// (01e3dd9, 22c3fd2, 7eaf97f, c004878) rewrote the same four lines of gap-to-feature.ts within
// two hours, alternating between removing a duplicated delete and re-adding it — one of them
// introducing a guaranteed TypeError. Net progress over four landings: zero.
//
// The substrate was asked to make this change itself and could not (gap route-edit-f823889a,
// 2 attempts). Its gates worked correctly: it localized to this exact function, refused a
// non-unique anchor, and its adversarial refuters agreed 2/2 that the diff "only adds a comment
// block ... but makes ZERO modifications to the exported function". It could not write the code.

const SHA = "1b7fe81237e8";

describe("priorAttemptFeedbackBlock — landed attempts", () => {
  it("returns EXACTLY nothing when there is no history of any kind", () => {
    // The pre-existing contract. A gap with no history must be unaffected by this change.
    expect(priorAttemptFeedbackBlock(null)).toBe("");
    expect(priorAttemptFeedbackBlock(undefined)).toBe("");
    expect(priorAttemptFeedbackBlock({})).toBe("");
    expect(priorAttemptFeedbackBlock({ failure_lessons: [] })).toBe("");
  });

  it("surfaces a landed attempt, naming the commit and the file's current state", () => {
    const out = priorAttemptFeedbackBlock({ pending_outcome_verification: SHA });
    expect(out).toContain("PRIOR LANDED ATTEMPT");
    expect(out).toContain(SHA);
    expect(out).toContain("ALREADY IN THE FILE");
  });

  it("tells the drafter an EMPTY DIFF is a correct answer", () => {
    // The specific failure being prevented: re-editing lines that already carry the fix.
    // Without this, "produce no edit" is not an option the drafter believes it has.
    const out = priorAttemptFeedbackBlock({ pending_outcome_verification: SHA });
    expect(out).toContain("Do NOT re-apply it");
    expect(out).toContain("do NOT revert it");
    expect(out.toLowerCase()).toContain("empty diff");
  });

  it("explains that STILL-OPEN does not mean the prior attempt was wrong", () => {
    // Otherwise the drafter's only reading of an open gap with a landed fix is "it failed".
    const out = priorAttemptFeedbackBlock({ pending_outcome_verification: SHA });
    expect(out).toContain("could not be VERIFIED");
  });

  it("does NOT claim a rejection when the only history is a successful landing", () => {
    // The heading and the closing "will be REJECTED again" line are both rejection claims.
    // Emitting either under a landed-only block asserts something that never happened.
    const out = priorAttemptFeedbackBlock({ pending_outcome_verification: SHA });
    expect(out).not.toContain("was REJECTED by the semantic gate");
    expect(out).not.toContain("will be REJECTED again");
  });

  it("keeps the rejection block byte-identical when there is no landed attempt", () => {
    // This change ADDS a second kind of evidence; it must not alter the first.
    const meta = {
      semantic_gate_reason: "the diff does not address the gap",
      suspected_real_location: "repos/x/src/y.ts:fn",
      failure_lessons: [{ class: "anchor_not_found", reason: "no unique anchor" }],
    };
    const out = priorAttemptFeedbackBlock(meta);
    expect(out).toContain("PRIOR ATTEMPT FEEDBACK");
    expect(out).toContain("will be REJECTED again");
    expect(out).not.toContain("PRIOR LANDED ATTEMPT");
    expect(out).toContain("- Rejection reason: the diff does not address the gap");
    expect(out).toContain("PER-GAP FAILURE LESSONS");
  });

  it("emits BOTH blocks when a gap has landed once AND been rejected once", () => {
    // A recommit lineage does exactly this: land, fail to close, get re-picked, get rejected.
    const out = priorAttemptFeedbackBlock({
      pending_outcome_verification: SHA,
      semantic_gate_reason: "does not address the gap",
      failure_lessons: [{ class: "semantic_reject", reason: "comment-only diff" }],
    });
    expect(out).toContain("PRIOR LANDED ATTEMPT");
    expect(out).toContain("PRIOR ATTEMPT FEEDBACK");
    expect(out.indexOf("PRIOR LANDED ATTEMPT")).toBeLessThan(out.indexOf("PRIOR ATTEMPT FEEDBACK"));
  });

  it("ignores a placeholder or too-short SHA rather than announcing a landing that did not happen", () => {
    // sweepPendingLandVerifications treats <7 chars as absent; match it. "unknown" is written
    // by markGapPendingVerification when the sha is not known.
    for (const v of ["", "   ", "abc", "unknow"]) {
      expect(priorAttemptFeedbackBlock({ pending_outcome_verification: v })).toBe("");
    }
  });

  it("is safe on a non-string pending_outcome_verification", () => {
    for (const v of [null, 42, {}, []] as unknown[]) {
      expect(priorAttemptFeedbackBlock({ pending_outcome_verification: v })).toBe("");
    }
  });
});
