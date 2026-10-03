// A REJECT NEEDS EVIDENCE; A CLOSED ROW'S VERDICT IS NOT REWRITTEN (check-first, 2026-10-03).
//
// qa: close_needs_evidence gated only the transition into "closed". A "rejected" status takes a gap out of
// every open-gap supply just as surely, and only the hold guard looked at it, so a walk could reject an
// unheld operator gap with nothing at all. And a write that keeps a row closed (closed -> closed) could
// rewrite the verdict it closed on: swap closed_reason, re-point closed_by, add a landed_sha to a hollow
// close after the fact.
//
// RULES:
//   - A transition into "rejected" needs the same as a close: a reason (closed_reason or rejected_reason)
//     plus evidence (falsifier_exercise, landed_sha / landed_commit, closed_by / close_basis, or the
//     operator marker). Refused otherwise, rule close_needs_evidence, row unchanged.
//   - A write that keeps a row closed (or rejected) does not change closed_reason, closed_by, close_basis,
//     landed_sha, landed_commit or falsifier_exercise without the operator marker: stored values are kept,
//     and a key the stored row does not have is not added. The write itself proceeds.
// CONTROLS: orphaned_capability_scan's reject, driven for real into the real store; the escalation "drop"
// close payload; an operator-marked verdict correction.
//
// SEAM: fresh module instance under this file's temp root; rows are SEEDED into the store file.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-write-reject-evidence-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"gap-write-reject-evidence"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { resolveSubstrateGapWrite, gapStoreRootForTest } = sg;
const { rejectUnreachableOrphanGaps } = await import("../../src/resolvers/orphaned-capability-scan.js");

const STORE = join(ROOT, "gaps", "gaps.json");
const AT = "2026-10-03T10:00:00.000Z";
const realFetch = globalThis.fetch;
const OP = { id: "reject-fixture-operator-gap", category: "systematic_failure", source: "human_reported", summary: "an unheld operator gap", detected_at: AT, status: "open", classification_metadata: { severity: "high" }, created_at: AT, updated_at: AT };
const HOLLOW = { id: "reject-fixture-hollow-close", category: "systematic_failure", source: "substrate_detected", summary: "closed by a detector, no landing", detected_at: AT, status: "closed", classification_metadata: { closed_reason: "condition_gone", closed_by: "fixture-detector" }, created_at: AT, updated_at: AT, closed_at: AT };
const ORPHAN = { id: "orphaned-capability-fixtureShape", category: "orphaned_capability", source: "substrate_detected", summary: "resolver fixtureShape has no caller", detected_at: AT, status: "open", classification_metadata: { shape: "fixtureShape" }, created_at: AT, updated_at: AT };
const rows = (): Array<Record<string, any>> => JSON.parse(readFileSync(STORE, "utf8"));
const stored = (id: string): Record<string, any> | undefined => rows().find((g) => g.id === id);
const write = (pointer: Record<string, unknown>) => resolveSubstrateGapWrite({ type: "substrateGap_write", ...pointer } as never, { vocabulary: null } as never) as Promise<{ shape: string; body: Record<string, unknown> }>;

beforeEach(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  writeFileSync(STORE, JSON.stringify([OP, HOLLOW, ORPHAN]));
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe("substrateGap_write: rejects need evidence and a closed verdict is not rewritten", () => {
  it("isolation: the store under test is this file's temp root", () => {
    expect(gapStoreRootForTest()).toBe(ROOT);
  });

  it("[MUST-FAIL] a reject of an unheld operator gap with nothing is refused and the row stays open", async () => {
    const r = await write({ gap: { id: OP.id, category: OP.category, source: OP.source, summary: OP.summary, detected_at: AT, status: "rejected" } });
    expect(r.shape).toBe("structuredError");
    expect(r.body["rule"]).toBe("close_needs_evidence");
    expect(stored(OP.id)!.status).toBe("open");
  });

  it("[MUST-FAIL] a reject with a rejected_reason but no closer or evidence is refused", async () => {
    const r = await write({ gap: { id: OP.id, category: OP.category, source: OP.source, summary: OP.summary, detected_at: AT, status: "rejected", classification_metadata: { rejected_reason: "not a real gap" } } });
    expect(r.shape).toBe("structuredError");
    expect(stored(OP.id)!.status).toBe("open");
  });

  it("[MUST-FAIL] a closed-to-closed rewrite without the marker does not change the stored verdict", async () => {
    const r = await write({ gap: { ...HOLLOW, classification_metadata: { closed_reason: "landed_verified", closed_by: "gap-sweep", close_basis: "absent", falsifier_exercise: { passed: true } } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    const meta = stored(HOLLOW.id)!.classification_metadata;
    expect(meta.closed_reason).toBe("condition_gone");
    expect(meta.closed_by).toBe("fixture-detector");
    expect(meta.close_basis).toBeUndefined();
    expect(meta.falsifier_exercise).toBeUndefined();
  });

  it("[MUST-FAIL] a land signal cannot be added to a hollow close after the fact", async () => {
    const r = await write({ gap: { ...HOLLOW, classification_metadata: { landed_sha: "abc1234", landed_commit: "abc1234", note: "annotation" } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    const meta = stored(HOLLOW.id)!.classification_metadata;
    expect(meta.landed_sha).toBeUndefined();
    expect(meta.landed_commit).toBeUndefined();
    expect(meta.note).toBe("annotation");
  });

  it("[CONTROL] orphaned_capability_scan's reject, driven for real, rejects the orphan gap in the real store", async () => {
    globalThis.fetch = (async (_u: unknown, init?: { body?: unknown }) => {
      const p = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer ?? {};
      if (p.type === "substrateGap") return Response.json({ success: true, body: { gaps: [ORPHAN] } });
      if (p.type === "substrateGap_write") { const r = await resolveSubstrateGapWrite(p as never, { vocabulary: null } as never); return Response.json({ success: r.shape !== "structuredError", shape: r.shape, body: r.body }); }
      return Response.json({ success: true, body: {} });
    }) as unknown as typeof fetch;
    const out = await rejectUnreachableOrphanGaps("http://fixture.invalid/v2/impulses/resolve", "", new Set<string>());
    expect(out.rejected).toEqual([ORPHAN.id]);
    const row = stored(ORPHAN.id)!;
    expect(row.status).toBe("rejected");
    expect(row.classification_metadata.unreachable_reason).toBe("no_live_producer");
  });

  it("[CONTROL] the escalation drop close payload, human_dropped plus its closer, closes", async () => {
    const r = await write({ gap: { ...OP, status: "closed", classification_metadata: { severity: "high", closed_reason: "human_dropped", closed_by: "escalation_disposition_apply", resolution: "closed by human disposition: drop (escalation answered)", closed_at: AT } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(OP.id)!.status).toBe("closed");
  });

  it("[CONTROL] a reject carrying rejected_reason plus a closer rejects", async () => {
    const r = await write({ gap: { ...OP, status: "rejected", classification_metadata: { rejected_reason: "duplicate", closed_by: "fixture-detector" } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(OP.id)!.status).toBe("rejected");
  });

  it("[CONTROL] an operator-marked closed-to-closed write may correct the verdict", async () => {
    const r = await write({ operator: "operator:avi", gap: { ...HOLLOW, classification_metadata: { closed_reason: "landed_verified", landed_sha: "abc1234" } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    const meta = stored(HOLLOW.id)!.classification_metadata;
    expect(meta.closed_reason).toBe("landed_verified");
    expect(meta.landed_sha).toBe("abc1234");
  });
});
