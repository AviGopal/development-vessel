// repair_autonomy LINK 1 reads ONE origin predicate (operator-acts.ts lineageOrigin): a lineage ancestor whose source is
// missing, a bare "operator" or free text is not system-born, so a substrate_detected recommit child of it fails link 1,
// as an operator-filed root already did. The why names the failing ancestor and its source class.
//   MUST-FAIL  a substrate_detected recommit child whose root has NO source fails link 1;
//   MUST-FAIL  the same with a bare "operator" root, and with a free-text root;
//   CONTROL    an all-substrate_detected lineage passes link 1 and counts;
//   CONTROL    an operator:* root fails as before ("origin: operator-filed (...)"); an unset own source fails as before.
import { describe, expect, it } from "bun:test";
import { judgeRepairClosure, repairControlInputs } from "../../src/resolvers/self-fact-reconcile.js";
import type { GapRow } from "../../src/resolvers/operator-acts.js";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const t = (h: number) => new Date(NOW - h * 3600_000).toISOString();
function closure(id: string, others: GapRow[], over: Record<string, unknown> = {}) {
  const inp = repairControlInputs(NOW, false);
  const row: GapRow = { ...inp.row!, ...over, id };
  const events = (inp.acts.events ?? []).map((e) => ({ ...e, gap_id: id }));
  return judgeRepairClosure({ ...inp, row, landing: { ...inp.landing, gap_id: id }, byId: new Map<string, GapRow>([[id, row], ...others.map((o) => [String(o["id"]), o] as [string, GapRow])]), acts: { ...inp.acts, events } });
}
const root = (id: string, source: string | undefined): GapRow => ({ id, status: "closed", ...(source === undefined ? {} : { source }), first_detected_at: t(200), classification_metadata: {} });
const L1 = { verdict: "not_counted", failing_link: "link1" };

describe("repair_autonomy link 1 fails on an ancestor that is not system-born", () => {
  it("MUST-FAIL: a substrate_detected recommit child whose root has no source fails link 1", () => {
    const j = closure("recommit-nosrc-root-gap", [root("nosrc-root-gap", undefined)]);
    expect({ verdict: j.verdict, failing_link: j.failing_link }).toEqual(L1);
    expect(j.reason).toContain("link1: origin: not system-born (lineage ancestor nosrc-root-gap is source unset)");
  });
  it("MUST-FAIL: a bare \"operator\" root fails link 1", () => {
    const j = closure("recommit-bare-root-gap", [root("bare-root-gap", "operator")]);
    expect({ verdict: j.verdict, failing_link: j.failing_link }).toEqual(L1);
    expect(j.reason).toContain(`lineage ancestor bare-root-gap is source "operator" (bare, no operator id)`);
  });
  it("MUST-FAIL: a free-text root fails link 1", () => {
    const j = closure("recommit-text-root-gap", [root("text-root-gap", "development vessel")]);
    expect({ verdict: j.verdict, failing_link: j.failing_link }).toEqual(L1);
    expect(j.reason).toContain(`lineage ancestor text-root-gap is source "development vessel" (free text, no system writer)`);
  });
  it("CONTROL: an all-substrate_detected lineage passes link 1 and counts", () => {
    const j = closure("recommit-sys-root-gap", [root("sys-root-gap", "substrate_detected")]);
    expect({ verdict: j.verdict, failing_links: j.failing_links }).toEqual({ verdict: "counted", failing_links: [] });
  });
  it("CONTROL: an operator:* root and an unset own source fail link 1 as before", () => {
    const op = closure("recommit-op-root-gap", [root("op-root-gap", "operator:qa")]);
    expect({ verdict: op.verdict, failing_link: op.failing_link }).toEqual(L1);
    expect(op.reason).toContain("link1: origin: operator-filed (lineage ancestor op-root-gap is source operator:qa)");
    const own = closure("unset-self-gap", [], { source: undefined });
    expect({ verdict: own.verdict, failing_link: own.failing_link }).toEqual(L1);
    expect(own.reason).toContain("link1: source unset: autonomous only when substrate_detected");
  });
});
