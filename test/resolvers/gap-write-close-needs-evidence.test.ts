// A CLOSE NEEDS EVIDENCE (check-first, 2026-10-03).
//
// Observed in the live store: autonomous walks closed operator gaps through substrateGap_write with no
// verdict at all. The row "the-gap-stores-hold-guard-refuses-only-a-close-..." was closed by a walk whose
// write carried only a rewritten summary and category "gap"; no closed_reason, no exercised check, no
// landing, no named closer. The store accepted any status:"closed" on an existing row.
//
// RULE (close_needs_evidence): a write that moves an EXISTING row from a non-closed status to "closed"
// must carry
//   (1) closed_reason: a non-empty string, in classification_metadata or at the top level of the gap, AND
//   (2) one piece of closure evidence:
//       - classification_metadata.falsifier_exercise: an object with a boolean `passed` (an exercised check:
//         the lane's closeLandedGap and pending-land sweep, closed_via_child, self_fact_reconcile), or
//       - a land signal: classification_metadata.landed_sha or landed_commit, a non-empty string, or
//       - a named closer: closed_by or close_basis, a non-empty string, in classification_metadata or at the
//         top level (the detectors and sweeps: gap_lifecycle_scan, ui_legibility_scan, ...), or
//       - the operator marker: pointer-level `operator: "operator:<id>"` (an operator closing by hand).
// Without it the write is refused with a structured error naming the rule, and the row is unchanged.
// A write to a row that is ALREADY closed (closed -> closed) is not a transition and is not gated.
//
// SEAM: fresh module instance under this file's temp root; rows are SEEDED into the store file.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-write-close-evidence-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"gap-write-close-evidence"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { resolveSubstrateGapWrite, gapStoreRootForTest } = sg;

const STORE = join(ROOT, "gaps", "gaps.json");
const AT = "2026-10-03T10:00:00.000Z";
const realFetch = globalThis.fetch;
const OP = { id: "close-evidence-fixture-operator-gap", category: "systematic_failure", source: "human_reported", summary: "an operator gap whose fix has not landed", detected_at: AT, status: "open", classification_metadata: { severity: "medium", edit_site: "src/resolvers/substrate-gap.ts" }, created_at: AT, updated_at: AT };
const CLOSED = { id: "close-evidence-fixture-closed-gap", category: "systematic_failure", source: "substrate_detected", summary: "a gap already closed by the sweep", detected_at: AT, status: "closed", classification_metadata: { closed_reason: "landed_verified", landed_sha: "abc1234" }, created_at: AT, updated_at: AT, closed_at: AT };
const rows = (): Array<Record<string, any>> => JSON.parse(readFileSync(STORE, "utf8"));
const stored = (id: string): Record<string, any> | undefined => rows().find((g) => g.id === id);
const write = (pointer: Record<string, unknown>) => resolveSubstrateGapWrite({ type: "substrateGap_write", ...pointer } as never, { vocabulary: null } as never) as Promise<{ shape: string; body: Record<string, unknown> }>;
const close = (meta: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}, pointerExtra: Record<string, unknown> = {}) =>
  write({ ...pointerExtra, gap: { id: OP.id, category: OP.category, source: OP.source, summary: OP.summary, detected_at: AT, status: "closed", ...(meta ? { classification_metadata: meta } : {}), ...extra } });

beforeEach(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  writeFileSync(STORE, JSON.stringify([OP, CLOSED]));
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe("substrateGap_write: a close needs a reason and evidence", () => {
  it("isolation: the store under test is the temp root of this file", () => {
    expect(gapStoreRootForTest()).toBe(ROOT);
  });

  it("[MUST-FAIL] the observed walk close, a rewritten summary and category with no verdict, is refused and the row stays open", async () => {
    const r = await write({ gap: { id: OP.id, category: "gap", summary: "Closing the gap where the hold guard is refusing to close gaps.", detected_at: new Date().toISOString(), status: "closed", classification_metadata: { directed: false } } });
    expect(r.shape).toBe("structuredError");
    expect(r.body["rule"]).toBe("close_needs_evidence");
    const row = stored(OP.id)!;
    expect(row.status).toBe("open");
    expect(row.summary).toBe(OP.summary);
  });

  it("[MUST-FAIL] a close carrying falsifier_exercise passed but no closed_reason is refused", async () => {
    const r = await close({ falsifier_exercise: { passed: true } });
    expect(r.shape).toBe("structuredError");
    expect(r.body["rule"]).toBe("close_needs_evidence");
    expect(stored(OP.id)!.status).toBe("open");
  });

  it("[MUST-FAIL] a close carrying a closed_reason and nothing else is refused", async () => {
    const r = await close({ closed_reason: "already_resolved" });
    expect(r.shape).toBe("structuredError");
    expect(String(r.body["detail"])).toContain("closed_reason");
    expect(stored(OP.id)!.status).toBe("open");
  });

  it("[MUST-FAIL] a close whose evidence fields are empty strings is refused", async () => {
    const r = await close({ closed_reason: "already_resolved", closed_by: " ", landed_sha: "" });
    expect(r.shape).toBe("structuredError");
    expect(stored(OP.id)!.status).toBe("open");
  });

  it("[MUST-FAIL] a pointer-level operator value that is not an operator id does not count as the marker", async () => {
    const r = await close({ closed_reason: "fixed_by_hand" }, {}, { operator: "goal-host" });
    expect(r.shape).toBe("structuredError");
    expect(stored(OP.id)!.status).toBe("open");
  });

  it("[CONTROL] the lane landing close shape, closed_reason landed_verified plus an exercised falsifier and landed_sha, closes", async () => {
    const r = await close({ closed_reason: "landed_verified", landed_sha: "deadbee", falsifier_exercise: { detector: "closeLandedGap", verdict: "absent", passed: true, ran_at: AT, commit: "deadbee" } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(OP.id)!.status).toBe("closed");
  });

  it("[CONTROL] a literal-only landing close, falsifier_exercise with passed false, closes: the exercise is recorded either way", async () => {
    const r = await close({ closed_reason: "landed_literal_only", falsifier_exercise: { detector: "gap-sweep", verdict: "literal_present", passed: false, ran_at: AT, commit: "deadbee" } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(OP.id)!.status).toBe("closed");
  });

  it("[CONTROL] closed_reason plus landed_sha closes", async () => {
    const r = await close({ closed_reason: "landed_verified", landed_sha: "deadbee" });
    expect(r.shape).toBe("substrateGapWriteResult");
  });

  it("[CONTROL] a detector close, closed_reason plus closed_by in metadata, closes", async () => {
    const r = await close({ closed_reason: "violation_not_reproduced_on_rescan", closed_by: "ui_legibility_scan" });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(OP.id)!.status).toBe("closed");
  });

  it("[CONTROL] top-level closed_reason and closed_by close, as gap_lifecycle_scan and ingest-docs send them", async () => {
    const r = await close({}, { closed_reason: "producer_now_exists", closed_by: "gap_lifecycle_scan" });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(OP.id)!.status).toBe("closed");
  });

  it("[CONTROL] closed_reason plus close_basis closes, as the condition-gone close sends it", async () => {
    const r = await close({ closed_reason: "condition_gone", close_basis: "condition_gone" });
    expect(r.shape).toBe("substrateGapWriteResult");
  });

  it("[CONTROL] the operator close path, closed_reason plus the pointer-level operator marker, closes", async () => {
    const r = await close({ closed_reason: "superseded_by_landing" }, {}, { operator: "operator:avi" });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(OP.id)!.status).toBe("closed");
  });

  it("[CONTROL] a write to a row that is already closed is not a transition and is not gated", async () => {
    const r = await write({ gap: { id: CLOSED.id, category: CLOSED.category, source: CLOSED.source, summary: CLOSED.summary, detected_at: AT, status: "closed", classification_metadata: { note: "annotated after close" } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(CLOSED.id)!.classification_metadata.note).toBe("annotated after close");
  });

  it("[CONTROL] an open re-emission of an open row is not gated", async () => {
    const r = await write({ gap: { ...OP, classification_metadata: { region: "fixture" } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(OP.id)!.status).toBe("open");
  });
});
