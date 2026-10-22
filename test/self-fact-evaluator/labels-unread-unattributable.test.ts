// qa parity ruling (eval5): unread oracle labels read UNATTRIBUTABLE, the PREREG/autonomy6 word, not REVIEW. A label
// that IS read and classes review still reads REVIEW (oracle-label-reader.test.ts pins that case, unchanged).
//   MUST-FAIL  labels unread: unjudged, and the reason says unattributable, not REVIEW;
//   CONTROL    a read label that classes review still reads REVIEW (unjudged).
import { describe, expect, it } from "bun:test";
import { judgeRepairClosure, repairControlInputs } from "../../src/resolvers/self-fact-reconcile.js";

const NOW = Date.parse("2026-10-22T12:00:00Z");

describe("unread oracle labels are unattributable (qa parity ruling)", () => {
  it("MUST-FAIL: unread labels read unattributable, not REVIEW", () => {
    const i = repairControlInputs(NOW, false);
    const j = judgeRepairClosure({ ...i, acts: { ...i.acts, labels: null } });
    expect({ verdict: j.verdict, unattributable: /unattributable/i.test(j.reason), review: j.reason.includes("REVIEW"), labels: j.reason.includes("oracle labels unread") }, j.reason)
      .toEqual({ verdict: "unjudged", unattributable: true, review: false, labels: true });
  });
  it("CONTROL: a read label that classes review still reads REVIEW", () => {
    const i = repairControlInputs(NOW, false);
    const row = { ...i.row!, classification_metadata: { ...(i.row!["classification_metadata"] as Record<string, unknown>), execution_id: "exec-prov-1" } };
    const j = judgeRepairClosure({ ...i, row, byId: new Map([[String(row["id"]), row]]), acts: { ...i.acts, labels: [{ execution_id: "exec-prov-1", labeler: "automated", source: null, created_at: new Date(NOW - 60 * 3600_000).toISOString() }] } });
    expect({ verdict: j.verdict, review: j.reason.includes("REVIEW") }, j.reason).toEqual({ verdict: "unjudged", review: true });
  });
});
