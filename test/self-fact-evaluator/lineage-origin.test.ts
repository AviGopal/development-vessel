// ONE lineage origin predicate (operator-acts.ts isSystemBornLineage / lineageOrigin): a row is system-born only when
// its own source AND every lineage ancestor's source is substrate_detected or a known system writer
// (SYSTEM_GAP_SOURCES), and no filed_by names an operator. Missing, a bare "operator", free text, operator:* and
// human_reported all fail, on the row or on any ancestor. An ancestor the store read does not hold is unseen
// (lineageUnknown), never clean. The walk is lineageAncestors': cycle-safe and bounded by the store read.
//   MUST-FAIL  a substrate_detected recommit child of a root with NO source is not system-born;
//   MUST-FAIL  the same with a bare "operator" root, and with a free-text root;
//   MUST-FAIL  a recommit child whose parent is not in the store read is not system-born (unseen);
//   CONTROL    an all-substrate_detected lineage is system-born; a known system writer's row is too;
//   CONTROL    an operator:* root, an unset own source and an operator filed_by are not (as before);
//   CONTROL    a link cycle terminates.
import { describe, expect, it } from "bun:test";
import { isSystemBornLineage, lineageOrigin, SYSTEM_GAP_SOURCES, type GapRow } from "../../src/resolvers/operator-acts.js";

const row = (id: string, source: string | undefined, meta: Record<string, unknown> = {}): GapRow => ({ id, status: "open", ...(source === undefined ? {} : { source }), classification_metadata: meta });
const store = (...rows: GapRow[]) => new Map<string, GapRow>(rows.map((r) => [String(r["id"]), r]));
const CHILD = "recommit-root-gap-narrowed";

describe("isSystemBornLineage", () => {
  it("MUST-FAIL: a substrate_detected recommit child of a root with no source is not system-born", () => {
    const m = store(row("root-gap", undefined), row("root-gap-narrowed", "substrate_detected"), row(CHILD, "substrate_detected"));
    expect(isSystemBornLineage(m.get(CHILD)!, m)).toBe(false);
    expect(lineageOrigin(CHILD, m.get(CHILD), m).fault).toEqual({ id: "root-gap", operator: false, text: "source unset" });
  });
  it("MUST-FAIL: a bare \"operator\" root and a free-text root are not system-born", () => {
    for (const [src, text] of [["operator", `source "operator" (bare, no operator id)`], ["development vessel", `source "development vessel" (free text, no system writer)`]] as const) {
      const m = store(row("root-gap", src), row("root-gap-narrowed", "substrate_detected"), row(CHILD, "substrate_detected"));
      expect(isSystemBornLineage(m.get(CHILD)!, m)).toBe(false);
      expect(lineageOrigin(CHILD, m.get(CHILD), m).fault).toEqual({ id: "root-gap", operator: false, text });
    }
  });
  it("MUST-FAIL: a recommit whose parent the store read does not hold is unseen, never system-born", () => {
    const m = store(row("recommit-gone-gap", "substrate_detected"));
    const o = lineageOrigin("recommit-gone-gap", m.get("recommit-gone-gap"), m);
    expect({ fault: o.fault, unseen: o.unseen.length }).toEqual({ fault: null, unseen: 1 });
    expect(isSystemBornLineage(m.get("recommit-gone-gap")!, m)).toBe(false);
  });
  it("CONTROL: an all-substrate_detected lineage is system-born, and so is a known system writer's row", () => {
    const m = store(row("root-gap", "substrate_detected"), row("root-gap-narrowed", "substrate_detected"), row(CHILD, "substrate_detected"));
    expect(isSystemBornLineage(m.get(CHILD)!, m)).toBe(true);
    for (const s of SYSTEM_GAP_SOURCES) {
      const n = store(row("w-gap", s));
      expect(isSystemBornLineage(n.get("w-gap")!, n)).toBe(true);
    }
  });
  it("CONTROL: an operator:* root, an unset own source and an operator filed_by are not system-born", () => {
    const op = store(row("root-gap", "operator:qa"), row(CHILD, "substrate_detected"));
    expect(lineageOrigin(CHILD, op.get(CHILD), op).fault).toEqual({ id: "root-gap", operator: true, text: "source operator:qa" });
    const own = store(row("lone-gap", undefined));
    expect(lineageOrigin("lone-gap", own.get("lone-gap"), own).fault).toEqual({ id: "lone-gap", operator: false, text: "source unset" });
    const fb = store(row("fb-gap", "substrate_detected", { filed_by: "operator:x" }));
    expect(lineageOrigin("fb-gap", fb.get("fb-gap"), fb).fault).toEqual({ id: "fb-gap", operator: true, text: "filed_by operator:x" });
    for (const m of [op, own, fb]) for (const r of m.values()) if (r["id"] !== "root-gap") expect(isSystemBornLineage(r, m)).toBe(false);
  });
  it("CONTROL: a link cycle terminates, and an unrelated free-text row changes nothing", () => {
    const m = store(row("a-gap", "substrate_detected", { parent_gap_id: "b-gap" }), row("b-gap", "substrate_detected", { parent_gap_id: "a-gap" }), row("other", "free text"));
    expect(isSystemBornLineage(m.get("a-gap")!, m)).toBe(true);
    m.set("b-gap", row("b-gap", "free text", { parent_gap_id: "a-gap" }));
    expect(lineageOrigin("a-gap", m.get("a-gap"), m).fault?.id).toBe("b-gap");
  });
});
