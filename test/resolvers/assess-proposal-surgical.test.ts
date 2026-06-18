import { describe, it, expect } from "bun:test";
import { assessProposalSurgical } from "../../src/resolvers/apply-proposal-as-patch.js";

// Pins the surgical pre-gate's anchor detection (2026-06-18 widening). The gate
// must admit genuinely-surgical edits (add export / add comment / named constant /
// named file) while still refusing feature-sized prose. Regression context: the
// gate originally over-refused surgical proposals as `non_surgical_proposal`,
// starving apply_proposal_as_patch (skipped 50/50, flat `landed` for ~5h). The
// case-sensitivity of the ALL_CAPS-constant alternative is the subtle trap — under
// /i it matched lowercase snake_case and let features through.

const FULL = (s: string) => s.padEnd(320, " .");

describe("assessProposalSurgical", () => {
  it("admits a surgical 'add export of <Type>' proposal", () => {
    const t =
      "Add explicit export of WebSocketMessage type from the websocket/broadcaster module. " +
      "The error TS2459 indicates the type is referenced but not exported; add it to the module export list.";
    expect(assessProposalSurgical(t).surgical).toBe(true);
  });

  it("admits a surgical 'add JSDoc comment near <CONSTANT>' proposal", () => {
    const t =
      "Add a detailed JSDoc comment above or near the MAX_GOAL_LEN constant definition explaining " +
      "the rationale for the 2000 character limit and how it interacts with the goal validation path.";
    expect(assessProposalSurgical(t).surgical).toBe(true);
  });

  it("admits short concrete edits (rename ... to ...)", () => {
    expect(assessProposalSurgical("rename foo to bar in config file").surgical).toBe(true);
  });

  it("refuses a verbose feature with only lowercase snake_case symbols (no real anchor)", () => {
    const t = FULL(
      "Implement gap_landability backward model: extract features (remediation_already_present, score) " +
        "and store residual pairs, wire them back into the selector posterior so the predictor learns over time",
    );
    const r = assessProposalSurgical(t);
    expect(r.surgical).toBe(false);
    expect(r.reason).toContain("non_surgical_proposal");
  });

  it("refuses 'Author the missing seed activity template ...' feature prose", () => {
    const t = FULL(
      "Author the missing seed activity template that closes Loop-C. Must fs_list /workspace to find the scaffold, " +
        "compose a multi-task template, register it via activityTemplate update and verify it dispatches end to end",
    );
    expect(assessProposalSurgical(t).surgical).toBe(false);
  });

  it("refuses 'Introduce P(...) prediction model' feature prose", () => {
    const t = FULL(
      "Introduce P(draft-gap-closing-activity emits non-empty patch_proposal | target_file_pattern) prediction model " +
        "with feature extraction, training loop, and residual feedback into the drafter ranking so the system forecasts",
    );
    expect(assessProposalSurgical(t).surgical).toBe(false);
  });

  it("does not over-block when there is no description", () => {
    expect(assessProposalSurgical("").surgical).toBe(true);
  });

  it("ALL_CAPS-underscore detection is case-sensitive (lowercase snake_case is NOT an anchor)", () => {
    // A verbose proposal whose only symbol-like token is lowercase snake_case must
    // remain non-surgical — the /i trap regression guard.
    const t = FULL("rework the whole patch_proposal handling pipeline end to end across many modules and resolvers");
    expect(assessProposalSurgical(t).surgical).toBe(false);
  });
});
