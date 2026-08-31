import { describe, it, expect } from "bun:test";
import { admitActionableGaps } from "../../src/resolvers/gap-to-feature.js";

// gap-to-feature and feature-compose disagreed about gaps that name no existing file.
// gap-to-feature logged "no existing edit targets found — composer will scaffold new file"
// and dispatched; feature-compose answered "[fc-grounding] REFUSED ungrounded decompose;
// targetFiles=[] verify_vessels=[]" and returned without writing a report.
//
// Measured on the live fleet 2026-08-31 01:55-03:16: 14 picks, 12 ungrounded refusals, ZERO
// compose reports. At ~2 composes/hour that was the entire budget, and it was invisible from
// outside — a refusal claims and releases a slot without creating a worktree, so the lane
// reads idle (load 4, 0 slots held) while fully consumed.
//
// The admission gate's old comment asserted "the localizer may still derive a site
// downstream". These pin the measured behaviour instead: it does not.
// citedExistingFile resolves paths under MITOSIS_RUNTIME_DIR (default /vessels, the
// container's runtime copy). Point it at this checkout so the REAL predicate runs: without
// this every path fails to resolve, every gap looks ungroundable, the fail-open admits
// everything, and the assertions below silently pass on nothing. Read at call time, so
// setting it here is enough.
process.env["MITOSIS_RUNTIME_DIR"] = new URL("../../", import.meta.url).pathname.replace(/\/$/, "") + "/..";

const gap = (id: string, meta: Record<string, unknown> = {}) => ({
  id,
  category: "systematic_failure",
  summary: `gap ${id}`,
  classification_metadata: meta,
});

describe("admitActionableGaps — groundable-target requirement", () => {
  it("defers a gap that names no existing file when groundable work exists", async () => {
    // The real shape: `systematic-failure-feature_compose-zero` carried target=None and
    // failed_attempts=21 while still winning picks.
    const withTarget = gap("has-target", { edit_site: "repos/development-vessel/src/resolvers/gap-to-feature.ts" });
    const noTarget = gap("systematic-failure-feature_compose-zero");
    const { admitted, excluded } = await admitActionableGaps([noTarget, withTarget]);
    const ids = admitted.map((g) => String(g.id));
    expect(ids).toContain("has-target");
    expect(ids).not.toContain("systematic-failure-feature_compose-zero");
    expect(excluded.some((e) => e.reason === "no_groundable_target")).toBe(true);
  });

  it("FAILS OPEN when nothing groundable exists — a starved lane is worse", async () => {
    // This gate must never be the reason the substrate stops trying. With no groundable
    // candidate, the ungroundable ones are admitted rather than leaving an empty set.
    const { admitted, excluded } = await admitActionableGaps([gap("a"), gap("b")]);
    expect(admitted.map((g) => String(g.id)).sort()).toEqual(["a", "b"]);
    expect(excluded.some((e) => e.reason === "no_groundable_target")).toBe(false);
  });

  it("does not defer on failed_attempts — that would recreate hopeless() at gap grain", async () => {
    // Explicitly warned against by the picker-starves gap's own do_not_fix_by. A gap with a
    // real target stays admitted no matter how many times it has failed.
    const beaten = gap("beaten-but-groundable", {
      edit_site: "repos/development-vessel/src/resolvers/gap-to-feature.ts",
      failed_attempts: 99,
    });
    const { admitted } = await admitActionableGaps([beaten, gap("filler-no-target")]);
    expect(admitted.map((g) => String(g.id))).toContain("beaten-but-groundable");
  });

  it("admits as soon as a target is supplied — deferred, not condemned", async () => {
    // The deferral is a property of the gap, not a verdict on it. Naming a real file is
    // enough to bring it straight back on the next tick.
    const before = gap("gains-a-target");
    const other = gap("other-with-target", { edit_site: "repos/development-vessel/src/resolvers/gap-to-feature.ts" });
    const first = await admitActionableGaps([before, other]);
    expect(first.admitted.map((g) => String(g.id))).not.toContain("gains-a-target");

    const after = gap("gains-a-target", { edit_site: "repos/development-vessel/src/resolvers/gap-to-feature.ts" });
    const second = await admitActionableGaps([after, other]);
    expect(second.admitted.map((g) => String(g.id))).toContain("gains-a-target");
  });

  it("ignores a cited file that does not exist on disk", async () => {
    // citedExistingFile requires the path to resolve. A gap naming an invented vessel is
    // exactly the phantom-land case the grounding gate exists to stop.
    const phantom = gap("phantom", { edit_site: "repos/executive/src/index.ts" });
    const real = gap("real", { edit_site: "repos/development-vessel/src/resolvers/gap-to-feature.ts" });
    const { admitted } = await admitActionableGaps([phantom, real]);
    expect(admitted.map((g) => String(g.id))).not.toContain("phantom");
  });
});
