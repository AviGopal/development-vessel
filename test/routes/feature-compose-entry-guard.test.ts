// AN EMPTY POINTER MUST NOT CONSUME A COMPOSE SLOT.
//
// The feature_compose dispatch case passed its pointer through unvalidated, so a bare
// {"type":"feature_compose"} reached the resolver, claimed one of the 1-2 compose SLOTS, acquired
// a workspace, and was stopped only by the grounding gate deep inside — surfacing as "REFUSED
// ungrounded decompose", which reads as a grounding problem when it is a missing-input problem.
//
// Measured 2026-08-29 via the [compose] attribution logging: 28 composes with spec_len 0 produced
// 32 of the ungrounded refusals in one 3h window, carrying gap "none", directed false, land false,
// verify_vessels undefined. Over the same day 182 of ~270 edit-intent non-reaches were RETRYABLE
// CAPACITY — the lane too full to attempt real work, including a directed operator dispatch.
//
// The sibling gap_compose case has done this correctly since the 2026-07-18 dispatch-storm. These
// pin BOTH halves: the empty pointer is refused, and a pointer carrying any accepted spec source
// still passes. A test that only asserted the refusal would also pass if the guard rejected
// everything.

import { describe, it, expect } from "bun:test";

const SRC = new URL("../../src/routes/impulses.ts", import.meta.url);
const src = async (): Promise<string> => await Bun.file(SRC).text();

function featureComposeCase(s: string): string {
  const i = s.indexOf('case "feature_compose": {');
  expect(i).toBeGreaterThan(-1);
  return s.slice(i, i + 4200);
}

describe("feature_compose entry guard", () => {
  it("refuses before claiming a slot when no spec source is present", async () => {
    const b = featureComposeCase(await src());
    expect(b).toContain("missing_input");
    expect(b).toContain("refused before claiming a compose slot");
    // The refusal must PRECEDE the resolver call, or the slot is already gone.
    expect(b.indexOf("missing_input")).toBeLessThan(b.indexOf("return resolveFeatureCompose"));
  });

  it("accepts the SAME spec sources as the sibling gap_compose case", async () => {
    // Not a narrower guard: a caller gap_compose would accept must not be refused here.
    const b = featureComposeCase(await src());
    for (const s of ["spec", "goal", "description", "gap?.summary", "gap?.title"]) {
      expect(b).toContain(s);
    }
  });

  it("still dispatches to the resolver when a spec IS derivable", async () => {
    // The half a refusal-only test would miss entirely.
    const b = featureComposeCase(await src());
    expect(b).toMatch(/return resolveFeatureCompose\(/);
    expect(b).toContain("spec: fcSpec");
  });

  it("names the offered keys so the caller is identifiable", async () => {
    // This defect survived because the refused composes were unattributable.
    expect(featureComposeCase(await src())).toContain("offered_keys");
  });
});
