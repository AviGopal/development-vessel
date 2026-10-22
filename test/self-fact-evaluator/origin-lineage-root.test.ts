// LINK 1 FOLLOWS THE LINEAGE TO ITS ROOT (USER RULING 2026-10-22, "Follow lineage to the root"; qa: as research's
// instrument reads it). A recommit or narrowed child is written by the lane, so it carries source substrate_detected
// even when the gap it descends from was filed by an operator (source operator:* or human_reported, or filed_by
// operator:*). Its closure was then read as the system's own repair at its origin. Now link 1 (origin) FAILS when any
// lineage ancestor (operator-acts.ts lineageAncestors: the explicit links, transitively, and the id rule) is
// operator-filed, and the closure reads not_counted with failing_link "link1" and the reason "origin: operator-filed
// (...)". A row that is ITSELF operator-filed fails link 1 the same way (qa ruling 2026-10-22).
//   MUST-FAIL  a substrate_detected recommit child of an operator-filed root fails link 1;
//   MUST-FAIL  the same through a human_reported root two generations up, and through an explicit parent link to a
//              row filed_by an operator;
//   CONTROL    a lineage rooted entirely in substrate_detected passes link 1 and counts;
//   CONTROL    an operator-filed row that is NOT in the lineage changes nothing;
//   MUST-FAIL  an operator-filed row itself fails link 1 in the same form (its filing is still the operator act too).
import { describe, expect, it } from "bun:test";
import { judgeRepairClosure, repairControlInputs } from "../../src/resolvers/self-fact-reconcile.js";
import type { GapRow } from "../../src/resolvers/operator-acts.js";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const t = (h: number) => new Date(NOW - h * 3600_000).toISOString();
/** The positive control's closure, re-homed on `id` (with `over` on the row), with `others` in the store beside it. */
function closure(id: string, others: GapRow[], meta: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  const inp = repairControlInputs(NOW, false);
  const row: GapRow = { ...inp.row!, ...over, id, classification_metadata: { ...(inp.row!["classification_metadata"] as Record<string, unknown>), ...meta } };
  const events = (inp.acts.events ?? []).map((e) => ({ ...e, gap_id: id }));
  return judgeRepairClosure({ ...inp, row, landing: { ...inp.landing, gap_id: id }, byId: new Map<string, GapRow>([[id, row], ...others.map((o) => [String(o["id"]), o] as [string, GapRow])]), acts: { ...inp.acts, events } });
}
const root = (id: string, source: string, meta: Record<string, unknown> = {}): GapRow => ({ id, status: "closed", source, first_detected_at: t(200), classification_metadata: meta });

describe("repair_autonomy link 1 (origin) follows the lineage to its root", () => {
  it("MUST-FAIL: a substrate_detected recommit child of an operator-filed root fails link 1", () => {
    const j = closure("recommit-op-root-gap", [root("op-root-gap", "operator:qa")]);
    expect({ verdict: j.verdict, failing_link: j.failing_link }).toEqual({ verdict: "not_counted", failing_link: "link1" });
    expect(j.reason).toContain("link1: origin: operator-filed (lineage ancestor op-root-gap is source operator:qa)");
  });
  it("MUST-FAIL: a human_reported root two generations up (recommit of a narrowed child) fails link 1", () => {
    const j = closure("recommit-hr-root-gap-narrowed", [root("hr-root-gap", "human_reported"), root("hr-root-gap-narrowed", "substrate_detected")]);
    expect({ verdict: j.verdict, failing_link: j.failing_link }).toEqual({ verdict: "not_counted", failing_link: "link1" });
  });
  it("MUST-FAIL: an explicit parent link to a row filed_by an operator fails link 1", () => {
    const j = closure("unrelated-child-id", [root("linked-parent", "substrate_detected", { filed_by: "operator:x" })], { parent_gap_id: "linked-parent" });
    expect({ verdict: j.verdict, failing_link: j.failing_link }).toEqual({ verdict: "not_counted", failing_link: "link1" });
  });
  it("CONTROL: a lineage rooted entirely in substrate_detected passes link 1 and counts", () => {
    const j = closure("recommit-sys-root-gap-narrowed", [root("sys-root-gap", "substrate_detected"), root("sys-root-gap-narrowed", "substrate_detected")]);
    expect({ verdict: j.verdict, failing_links: j.failing_links }).toEqual({ verdict: "counted", failing_links: [] });
  });
  it("CONTROL: an operator-filed row outside the lineage changes nothing", () => {
    const j = closure("recommit-sys-root-gap", [root("sys-root-gap", "substrate_detected"), root("op-elsewhere", "operator:qa")]);
    expect(j.verdict).toBe("counted");
  });
  it("MUST-FAIL: an operator-filed row itself fails link 1 in the same form, and its filing is still the operator act", () => {
    const j = closure("op-filed-self", [], {}, { source: "operator:qa" });
    expect({ verdict: j.verdict, failing_links: j.failing_links }).toEqual({ verdict: "not_counted", failing_links: ["link1", "operator_act:operator-filed"] });
    expect(j.reason).toContain("link1: origin: operator-filed (source operator:qa)");
  });
  it("MUST-FAIL: a human_reported row itself reads the same", () => {
    const j = closure("hr-filed-self", [], {}, { source: "human_reported" });
    expect({ failing_link: j.failing_link, origin: j.reason.includes("origin: operator-filed (source human_reported)") }).toEqual({ failing_link: "link1", origin: true });
  });
});
