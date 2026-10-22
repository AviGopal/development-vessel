// qa's eval5 review, B1 (R1 lineage): lineageAncestors adds a linked id only when the store read holds it, so a
// dangling parent_gap_id, or a recommit-X whose X is not in the read, gave no ancestor; no root filer was found, link 1
// passed, and the closure could read counted. An ancestor the read cannot see is unknown, and unknown is unjudged.
//   MUST-FAIL  a dangling parent_gap_id makes the closure unjudged, not counted;
//   MUST-FAIL  a recommit row whose lower-depth row of the same core is absent is unjudged, not counted;
//   MUST-FAIL  a dangling link on a REACHED ancestor is unjudged too;
//   CONTROL    the same rows with their parents present are judged (counted), and the positive fixture still counts.
import { describe, expect, it } from "bun:test";
import { judgeRepairClosure, repairControlInputs } from "../../src/resolvers/self-fact-reconcile.js";

const NOW = Date.parse("2026-10-22T12:00:00Z");
type Row = Record<string, unknown>;
const clone = (r: unknown): Row => JSON.parse(JSON.stringify(r)) as Row;
const parentOf = (id: string): Row => ({ id, status: "closed", source: "substrate_detected", first_detected_at: new Date(NOW - 200 * 3600_000).toISOString(), classification_metadata: {} });
const inputs = (id: string, meta: Row, extra: Row[]) => {
  const i = repairControlInputs(NOW, false);
  const row = clone(i.row); row["id"] = id;
  Object.assign(row["classification_metadata"] as Row, meta);
  const events = (i.acts.events ?? []).map((e) => ({ ...e, gap_id: id }));
  return { ...i, landing: { ...i.landing, gap_id: id }, row, byId: new Map<string, Row>([[id, row], ...extra.map((r) => [String(r["id"]), r] as [string, Row])]), acts: { ...i.acts, events } };
};
const v = (j: { verdict: string; reason: string }) => ({ verdict: j.verdict, lineage: j.reason.includes("lineage:") });

describe("an ancestor the gap store read does not hold is unknown (B1)", () => {
  it("MUST-FAIL: a dangling parent_gap_id is unjudged, not counted", () => {
    const j = judgeRepairClosure(inputs("g-child-1", { parent_gap_id: "g-gone-parent" }, []));
    expect(v(j), j.reason).toEqual({ verdict: "unjudged", lineage: true });
  });
  it("MUST-FAIL: recommit-X with no X in the read is unjudged, not counted", () => {
    const j = judgeRepairClosure(inputs("recommit-g-gone-core", {}, []));
    expect(v(j), j.reason).toEqual({ verdict: "unjudged", lineage: true });
  });
  it("MUST-FAIL: a dangling link on a reached ancestor is unjudged", () => {
    const mid = { ...parentOf("g-mid"), classification_metadata: { root_gap_id: "g-gone-root" } };
    const j = judgeRepairClosure(inputs("g-child-2", { parent_gap_id: "g-mid" }, [mid]));
    expect(v(j), j.reason).toEqual({ verdict: "unjudged", lineage: true });
  });
  it("CONTROL: with the parents present the closure is judged and counts", () => {
    for (const [id, meta, extra] of [["g-child-3", { parent_gap_id: "g-here" }, [parentOf("g-here")]], ["recommit-g-here-core", {}, [parentOf("g-here-core")]]] as Array<[string, Row, Row[]]>) {
      const j = judgeRepairClosure(inputs(id, meta, extra));
      expect(v(j), `${id}: ${j.reason}`).toEqual({ verdict: "counted", lineage: false });
    }
    expect(judgeRepairClosure(repairControlInputs(NOW, false)).verdict).toBe("counted");
  });
});
