// A RECOMMIT'S PARENT IS SEEN THROUGH ITS EXPLICIT LINK (judge recommit fix, user ruling).
//
// Recommit ids carry a reason SUFFIX as well as the recommit- prefix (recommit-X-verify_failed, -semantic_reject,
// -anchor_not_found, -narrowed, -step-N). lineageUnknown's recommit rule looked for a row of the same core at a lower
// depth, where the core strips only the prefix, so recommit-X-verify_failed (core "X-verify_failed") never found X, and
// the repair_autonomy judge returned it unjudged ("unread, so an operator act cannot be ruled out") even when its real
// parent was in the store and named by its source_gap_id. Now:
//   - source_gap_id is a LINK_FIELD: lineage follows it, so an operator- or human-filed original fails link 1;
//   - a recommit's parent is SEEN when the row's own explicit link field names a row the store read holds (or, as
//     before, a key of exactly its core sits at a lower depth). No id-prefix or suffix-strip guessing.
//   MUST-FAIL  X + recommit-X-verify_failed (source_gap_id X): no unread-lineage entry; the closure is not unjudged by it;
//   MUST-FAIL  a recommit linked to X only by source_gap_id (an id that does not derive from X), X operator-sourced:
//              link 1 fails for the recommit;
//   CONTROL    the same with recommit-X-verify_failed's own id (the id rule already reached X): link 1 fails at both ends;
//   MUST-FAIL  a source_gap_id naming an id absent from the store flags, as every link to an unseen row does (red at
//              the parent, where source_gap_id was not a link field);
//   CONTROL    a non-recommit is unchanged; an unlinked suffixed recommit still flags;
//   CONTROL    an unlinked exact recommit (recommit-X with X present) stays seen, as before;
//   PARITY     the indexed reader agrees with the plain one on every case.
import { describe, expect, it } from "bun:test";
import { judgeRepairClosure, repairControlInputs } from "../../src/resolvers/self-fact-reconcile.js";
import { indexedLineageUnknown, lineageIndex, lineageUnknown, type GapRow } from "../../src/resolvers/operator-acts.js";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const t = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const row = (id: string, source: string, meta: Record<string, unknown> = {}): GapRow => ({ id, status: "closed", source, first_detected_at: t(200), classification_metadata: meta });
const store = (...rows: GapRow[]) => new Map<string, GapRow>(rows.map((r) => [String(r["id"]), r]));
const recommitUnread = (u: string[]) => u.filter((x) => x.includes("is a recommit"));
/** The positive control's closure, re-homed on `id` with `meta` on its row, `others` in the store beside it. */
function closure(id: string, others: GapRow[], meta: Record<string, unknown> = {}) {
  const inp = repairControlInputs(NOW, false);
  const r: GapRow = { ...inp.row!, id, classification_metadata: { ...(inp.row!["classification_metadata"] as Record<string, unknown>), ...meta } };
  const events = (inp.acts.events ?? []).map((e) => ({ ...e, gap_id: id }));
  return judgeRepairClosure({ ...inp, row: r, landing: { ...inp.landing, gap_id: id }, byId: new Map<string, GapRow>([[id, r], ...others.map((o) => [String(o["id"]), o] as [string, GapRow])]), acts: { ...inp.acts, events } });
}
const X = "gap-the-thing-that-broke";
const RX = `recommit-${X}-verify_failed`;

describe("a recommit's parent is seen through its explicit link", () => {
  it("MUST-FAIL: X + recommit-X-verify_failed with source_gap_id X: no unread-lineage entry", () => {
    const s = store(row(X, "substrate_detected"), row(RX, "substrate_detected", { source_gap_id: X }));
    expect(recommitUnread(lineageUnknown(RX, s))).toEqual([]);
    expect(lineageUnknown(RX, s)).toEqual([]);
  });
  it("MUST-FAIL: the closure of that recommit, system-born throughout, is not unjudged by its lineage (it counts)", () => {
    const j = closure(RX, [row(X, "substrate_detected")], { source_gap_id: X });
    expect(j.reason).not.toContain("is a recommit");
    expect({ verdict: j.verdict, failing_links: j.failing_links }).toEqual({ verdict: "counted", failing_links: [] });
  });
  it("MUST-FAIL: linked to an operator-filed X only by source_gap_id, the recommit fails link 1", () => {
    const j = closure("recommit-renamed-after-split-verify_failed", [row(X, "operator:qa")], { source_gap_id: X });
    expect({ verdict: j.verdict, failing_link: j.failing_link }).toEqual({ verdict: "not_counted", failing_link: "link1" });
    expect(j.reason).toContain(`lineage ancestor ${X} is source operator:qa`);
  });
  it("CONTROL: recommit-X-verify_failed with an operator-filed X fails link 1 (the id rule reaches X too)", () => {
    const j = closure(RX, [row(X, "operator:qa")], { source_gap_id: X });
    expect({ verdict: j.verdict, failing_link: j.failing_link }).toEqual({ verdict: "not_counted", failing_link: "link1" });
  });
  it("MUST-FAIL: a source_gap_id naming an id absent from the store flags, like any link to an unseen row", () => {
    const s = store(row(RX, "substrate_detected", { source_gap_id: X }));
    const u = lineageUnknown(RX, s);
    expect(u.some((x) => x.includes(`links source_gap_id=${X}`) && x.includes("not in the gap store read"))).toBe(true);
    expect(closure(RX, [], { source_gap_id: X }).verdict).toBe("unjudged");
  });
  it("CONTROL: a non-recommit is unchanged; an unlinked suffixed recommit still flags", () => {
    const s = store(row(X, "substrate_detected"), row(`${X}-narrowed`, "substrate_detected"), row(RX, "substrate_detected"));
    expect(lineageUnknown(`${X}-narrowed`, s)).toEqual([]);
    expect(recommitUnread(lineageUnknown(RX, s)).length).toBe(1);
  });
  it("CONTROL: an unlinked exact recommit (recommit-X with X present) stays seen", () => {
    const s = store(row(X, "substrate_detected"), row(`recommit-${X}`, "substrate_detected"));
    expect(lineageUnknown(`recommit-${X}`, s)).toEqual([]);
  });
  it("PARITY: the indexed reader agrees on every case", () => {
    const cases: Array<[string, Map<string, GapRow>]> = [
      [RX, store(row(X, "substrate_detected"), row(RX, "substrate_detected", { source_gap_id: X }))],
      [RX, store(row(RX, "substrate_detected", { source_gap_id: X }))],
      [RX, store(row(X, "substrate_detected"), row(RX, "substrate_detected"))],
      [`recommit-${X}`, store(row(X, "substrate_detected"), row(`recommit-${X}`, "substrate_detected"))],
      [RX, store(row(X, "substrate_detected"), { id: RX, source: "substrate_detected", source_gap_id: X })],
    ];
    for (const [id, s] of cases) expect(indexedLineageUnknown(id, lineageIndex(s))).toEqual(lineageUnknown(id, s));
  });
});
