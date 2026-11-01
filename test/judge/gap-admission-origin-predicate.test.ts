// Admission's system-first order reads the autonomy judge's origin predicate (operator-acts.ts lineageOrigin): inside a
// landability band a row whose source is missing or free text, or whose lineage ancestor's is, is not system-born, so
// it orders after the system-born rows, as an operator-filed row already did. Nothing else in the order changes.
//   MUST-FAIL  a free-text row and a source-less row order after a system-born row of the same score;
//   MUST-FAIL  a substrate_detected recommit child of a source-less root (in the lineage index) orders after it too;
//   CONTROL    with substrate_detected and operator rows only, the order is what it was (landability, then origin);
//   CONTROL    an ancestor the index does not hold decides nothing (the auto-pick's index is the open read).
import { describe, expect, it } from "bun:test";

const { orderByLandability } = await import("../../src/judge/gap-admission.js") as unknown as { orderByLandability: (rows: Row[], byId?: Map<string, Row>) => Row[] };
type Row = Record<string, unknown>;
const SITE = "repos/goal-host-vessel/src/shared.ts";
const gap = (id: string, source: string | undefined, fa = 0): Row => ({ id, category: "failing_test", ...(source === undefined ? {} : { source }), summary: "fix the thing", status: "open", classification_metadata: { edit_site: SITE, falsifier: "class1", failed_attempts: fa } });
const ids = (rows: Row[]) => rows.map((r) => String(r.id));

describe("orderByLandability reads the shared origin predicate", () => {
  it("MUST-FAIL: free-text and source-less rows order after a system-born row of the same score", () => {
    const rows = [gap("text-row", "development vessel"), gap("nosrc-row", undefined), gap("sys-row", "substrate_detected")];
    expect(ids(orderByLandability(rows))).toEqual(["sys-row", "text-row", "nosrc-row"]);
  });
  it("MUST-FAIL: a child linked to a source-less parent in the lineage index orders after a system-born row", () => {
    const child = gap("linked-child", "substrate_detected"), sys = gap("sys-row", "substrate_detected");
    (child.classification_metadata as Row).parent_gap_id = "nosrc-parent";
    const index = new Map<string, Row>([["nosrc-parent", gap("nosrc-parent", undefined)], [String(child.id), child], [String(sys.id), sys]]);
    expect(ids(orderByLandability([child, sys], index))).toEqual(["sys-row", "linked-child"]);
  });
  it("CONTROL: substrate_detected and operator rows keep landability-then-origin order", () => {
    const rows = [gap("op-90", "operator:qa"), gap("sys-50", "substrate_detected", 4), gap("sys-90", "substrate_detected"), gap("op-50", "operator:qa", 4)];
    expect(ids(orderByLandability(rows))).toEqual(["sys-90", "op-90", "sys-50", "op-50"]);
  });
  it("CONTROL: an ancestor the index does not hold decides nothing", () => {
    const child = gap("linked-child", "substrate_detected"), other = gap("sys-row", "substrate_detected");
    (child.classification_metadata as Row).parent_gap_id = "closed-parent-not-read";
    expect(ids(orderByLandability([child, other], new Map([[String(child.id), child], [String(other.id), other]])))).toEqual(["linked-child", "sys-row"]);
  });
});
