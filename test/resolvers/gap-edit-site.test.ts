// Pins the gap -> target-file resolution feeding the patch_with_tools escalation.
//
// THE DEFECT: the escalation passed `gap.file_path`, but measured over the live store
// on 2026-08-10, 0 of 360 gaps carried a top-level `file_path` while 104 carried
// `classification_metadata.edit_site`. So it always passed `undefined`,
// deriveVesselFromPath threw "undefined is not an object (evaluating
// 'filePath.match')", and the escalation had NEVER run. Compounding it, the caller
// sets pwt_escalated = true BEFORE the attempt, so each gap that reached the crash was
// permanently marked as already-escalated.

import { describe, expect, it } from "bun:test";
import { gapEditSite } from "../../src/resolvers/gap-to-feature.js";

describe("gapEditSite", () => {
  it("reads edit_site — the field real gaps actually carry", () => {
    const meta = { edit_site: "repos/goal-host-vessel/src/index.ts" };
    expect(gapEditSite({}, meta)).toBe("repos/goal-host-vessel/src/index.ts");
  });

  it("returns undefined, NOT a throw, for the shape that crashed (no path anywhere)", () => {
    expect(gapEditSite({ id: "some-gap" }, {})).toBeUndefined();
  });

  it("prefers edit_site over the legacy aliases", () => {
    const meta = { edit_site: "repos/a/src/x.ts", change_site: "repos/b/src/y.ts", path: "repos/c/src/z.ts" };
    expect(gapEditSite({}, meta)).toBe("repos/a/src/x.ts");
  });

  it("falls back through change_site and path", () => {
    expect(gapEditSite({}, { change_site: "repos/b/src/y.ts" })).toBe("repos/b/src/y.ts");
    expect(gapEditSite({}, { path: "repos/c/src/z.ts" })).toBe("repos/c/src/z.ts");
  });

  it("still honours a top-level file_path when one exists", () => {
    expect(gapEditSite({ file_path: "repos/d/src/w.ts" }, {})).toBe("repos/d/src/w.ts");
  });

  it("ignores blank and non-string values instead of returning them", () => {
    expect(gapEditSite({}, { edit_site: "   " })).toBeUndefined();
    expect(gapEditSite({}, { edit_site: 42 })).toBeUndefined();
    expect(gapEditSite({}, { edit_site: null })).toBeUndefined();
  });

  it("trims surrounding whitespace", () => {
    expect(gapEditSite({}, { edit_site: "  repos/a/src/x.ts \n" })).toBe("repos/a/src/x.ts");
  });

  it("survives absent gap and meta objects", () => {
    expect(gapEditSite({}, {})).toBeUndefined();
  });
});

describe("control: the ORIGINAL escalation argument", () => {
  it("gap.file_path is absent on a realistic gap, which is what threw", () => {
    const realisticGap = {
      id: "route-edit-060857b4:3",
      status: "open",
      classification_metadata: { edit_site: "repos/goal-host-vessel/src/index.ts" },
    } as Record<string, unknown>;
    // The old call site read exactly this and handed it downstream.
    expect(realisticGap["file_path"]).toBeUndefined();
    // The new resolution finds the target that was there all along.
    expect(gapEditSite(realisticGap, realisticGap["classification_metadata"] as Record<string, unknown>))
      .toBe("repos/goal-host-vessel/src/index.ts");
  });
});
