// A HELD GAP DOES NOT MOVE WITHOUT THE OPERATOR (check-first, 2026-10-03).
//
// classification_metadata.operator_hold is the store's containment field. The write guard refused only
// one thing on a held row: status "closed" without falsifier_exercise.passed === true, read from the
// INCOMING payload. So any writer could REJECT a held gap, rewrite its summary, category or edit_site,
// release the hold by sending operator_hold:false (the carry-forward lets an incoming key win), or close
// it by forging falsifier_exercise:{passed:true} — the live row "{{goal.id}}" carried exactly that.
//
// RULES on a row whose STORED operator_hold is true, for a write without the pointer-level operator
// marker (operator:<id>):
//   - any status change is refused (structured error; the row is unchanged). falsifier_exercise.passed
//     in the payload does not bypass the hold: only the operator marker does.
//   - releasing the hold (operator_hold false) is refused.
//   - summary, category and classification_metadata.edit_site keep their stored values (the write itself
//     proceeds: scanners re-emit held rows with their own text, and that must not unhold or redirect them).
// With the marker: the hold may be released, and the row may be moved under the ordinary rules (a close
// still needs closed_reason; the marker counts as its evidence).
//
// SEAM: fresh module instance under this file's temp root; rows are SEEDED into the store file.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-write-hold-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"gap-write-hold-guard"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { resolveSubstrateGapWrite, gapStoreRootForTest } = sg;

const STORE = join(ROOT, "gaps", "gaps.json");
const AT = "2026-10-03T10:00:00.000Z";
const realFetch = globalThis.fetch;
const HELD_SUMMARY = "held: the redispatch livelock is contained by this hold until the lane fix lands";
const HELD = { id: "hold-guard-fixture-held-gap", category: "systematic_failure", source: "human_reported", summary: HELD_SUMMARY, detected_at: AT, status: "open", classification_metadata: { operator_hold: true, operator_hold_reason: "livelock containment", edit_site: "src/resolvers/gap-to-feature.ts" }, created_at: AT, updated_at: AT };
const FREE = { id: "hold-guard-fixture-unheld-gap", category: "systematic_failure", source: "human_reported", summary: "an unheld twin", detected_at: AT, status: "open", classification_metadata: {}, created_at: AT, updated_at: AT };
const rows = (): Array<Record<string, any>> => JSON.parse(readFileSync(STORE, "utf8"));
const stored = (id: string): Record<string, any> | undefined => rows().find((g) => g.id === id);
const write = (pointer: Record<string, unknown>) => resolveSubstrateGapWrite({ type: "substrateGap_write", ...pointer } as never, { vocabulary: null } as never) as Promise<{ shape: string; body: Record<string, unknown> }>;
const heldWrite = (over: Record<string, unknown>, meta: Record<string, unknown> = {}, pointerExtra: Record<string, unknown> = {}) =>
  write({ ...pointerExtra, gap: { id: HELD.id, category: HELD.category, source: HELD.source, summary: HELD.summary, detected_at: AT, status: "open", classification_metadata: meta, ...over } });

beforeEach(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  writeFileSync(STORE, JSON.stringify([HELD, FREE]));
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe("substrateGap_write: a held gap does not move without the operator marker", () => {
  it("isolation: the store under test is the temp root of this file", () => {
    expect(gapStoreRootForTest()).toBe(ROOT);
  });

  it("[MUST-FAIL] a REJECT of a held gap is refused and the row stays open and held", async () => {
    const r = await heldWrite({ status: "rejected" }, { rejected_reason: "not a real gap" });
    expect(r.shape).toBe("structuredError");
    expect(r.body["rule"]).toBe("operator_hold");
    const row = stored(HELD.id)!;
    expect(row.status).toBe("open");
    expect(row.classification_metadata.operator_hold).toBe(true);
  });

  it("[MUST-FAIL] a close carrying a forged falsifier_exercise passed plus reason and closer is refused on a held gap", async () => {
    const r = await heldWrite({ status: "closed" }, { closed_reason: "landed_verified", closed_by: "gap-sweep", falsifier_exercise: { passed: true } });
    expect(r.shape).toBe("structuredError");
    expect(String(r.body["detail"])).toContain("falsifier_exercise.passed");
    expect(stored(HELD.id)!.status).toBe("open");
  });

  it("[MUST-FAIL] releasing the hold without the operator marker is refused and the hold stays", async () => {
    const r = await heldWrite({}, { operator_hold: false });
    expect(r.shape).toBe("structuredError");
    expect(stored(HELD.id)!.classification_metadata.operator_hold).toBe(true);
  });

  it("[MUST-FAIL] an open write without the marker keeps the held row summary, category and edit_site", async () => {
    const r = await heldWrite({ summary: "rewritten by a walk", category: "gap" }, { edit_site: "src/elsewhere.ts" });
    expect(r.shape).toBe("substrateGapWriteResult");
    const row = stored(HELD.id)!;
    expect(row.summary).toBe(HELD_SUMMARY);
    expect(row.category).toBe("systematic_failure");
    expect(row.classification_metadata.edit_site).toBe("src/resolvers/gap-to-feature.ts");
    expect(row.classification_metadata.operator_hold).toBe(true);
  });

  it("[CONTROL] the operator marker releases the hold", async () => {
    const r = await heldWrite({}, { operator_hold: false }, { operator: "operator:avi" });
    expect(r.shape).toBe("substrateGapWriteResult");
    const row = stored(HELD.id)!;
    expect(row.classification_metadata.operator_hold).toBe(false);
    expect(row.status).toBe("open");
  });

  it("[CONTRACT] an operator-marked close of a held gap with a closed_reason closes it", async () => {
    const r = await heldWrite({ status: "closed" }, { closed_reason: "superseded_by_landing" }, { operator: "operator:avi" });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(HELD.id)!.status).toBe("closed");
  });

  it("[CONTRACT] an operator-marked close of a held gap still needs a closed_reason", async () => {
    const r = await heldWrite({ status: "closed" }, {}, { operator: "operator:avi" });
    expect(r.shape).toBe("structuredError");
    expect(r.body["rule"]).toBe("close_needs_evidence");
    expect(stored(HELD.id)!.status).toBe("open");
  });

  it("[CONTROL] a same-status bookkeeping write on a held gap is accepted and keeps the hold", async () => {
    const r = await heldWrite({}, { failed_attempts: 2 });
    expect(r.shape).toBe("substrateGapWriteResult");
    const row = stored(HELD.id)!;
    expect(row.classification_metadata.failed_attempts).toBe(2);
    expect(row.classification_metadata.operator_hold).toBe(true);
  });

  it("[CONTROL] an unheld gap may be rejected without the marker", async () => {
    const r = await write({ gap: { ...FREE, status: "rejected", classification_metadata: { rejected_reason: "fixture", closed_by: "hold-guard-fixture-detector" } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(FREE.id)!.status).toBe("rejected");
  });
});
