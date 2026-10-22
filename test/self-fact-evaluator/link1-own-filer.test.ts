// qa's eval5 review, B2 (R1, the closure's OWN filer): link 1 read only the row's `source`, so a row the lane wrote as
// substrate_detected but whose classification_metadata.filed_by names an operator passed link 1. The filer rule the
// lineage ancestors are read by (filerOf) now applies to the row itself.
//   MUST-FAIL  source substrate_detected + filed_by operator:x fails LINK 1 (not only the operator-field act);
//   CONTROL    the positive fixture (no filer) still passes link 1 and counts;
//   CONTROL    an operator `source` still fails link 1 in the same form ("origin: operator-filed (source …)").
import { describe, expect, it } from "bun:test";
import { judgeRepairClosure, repairControlInputs } from "../../src/resolvers/self-fact-reconcile.js";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const withRow = (patch: (r: Record<string, unknown>) => void) => {
  const i = repairControlInputs(NOW, false);
  const row = JSON.parse(JSON.stringify(i.row)) as Record<string, unknown>;
  patch(row);
  return { ...i, row, byId: new Map([[String(row["id"]), row]]) };
};

describe("link 1 reads the closure's own filer (B2)", () => {
  it("MUST-FAIL: a substrate_detected row filed_by an operator fails link 1", () => {
    const j = judgeRepairClosure(withRow((r) => { (r["classification_metadata"] as Record<string, unknown>)["filed_by"] = "operator:x"; }));
    expect({ verdict: j.verdict, failing_link: (j as { failing_link?: string }).failing_link ?? null, link1: j.failing_links.includes("link1") }, j.reason)
      .toEqual({ verdict: "not_counted", failing_link: "link1", link1: true });
    expect(j.reason).toContain("origin: operator-filed (filed_by operator:x)");
  });
  it("CONTROL: the positive fixture passes link 1 and counts", () => {
    const j = judgeRepairClosure(repairControlInputs(NOW, false));
    expect({ verdict: j.verdict, link1: j.failing_links.includes("link1") }, j.reason).toEqual({ verdict: "counted", link1: false });
  });
  it("CONTROL: an operator source still fails link 1 in the same form", () => {
    const j = judgeRepairClosure(withRow((r) => { r["source"] = "operator:y"; }));
    expect({ failing_link: (j as { failing_link?: string }).failing_link ?? null }, j.reason).toEqual({ failing_link: "link1" });
    expect(j.reason).toContain("origin: operator-filed (source operator:y)");
  });
});
