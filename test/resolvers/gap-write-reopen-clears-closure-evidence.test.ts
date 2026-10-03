// A REOPENED GAP CARRIES NO CLOSURE EVIDENCE (check-first, 2026-10-03).
//
// close_needs_evidence reads the incoming write. On a reopen the store deleted only the top-level closed_at
// and closed_by_trace; the metadata carry-forward kept closed_reason, closed_by, close_basis, landed_sha,
// falsifier_exercise and close_note. So a reopened gap still held a complete, valid-looking verdict from its
// LAST close, and a walk that read the row and echoed its metadata with status "closed" passed the gate
// with evidence nobody produced for this close.
//
// RULE: whenever an existing row's resulting status is open (a closed->open or rejected->open reopen, or
// an open->open write echoing a stale snapshot), the closure keys closed_reason, closed_by, close_basis,
// landed_sha, landed_commit, falsifier_exercise and close_note are removed from classification_metadata.
// No reader of an open row needs them (audited: isLiteralOnlyStepClose, the step-replace check in
// gap-to-feature, the pending-land sweep, detector-yield-registry, goal-reach-tick); reopen_count records
// that the gap was closed before.
//
// SEAM: fresh module instance under this file's temp root; rows are SEEDED into the store file.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-write-reopen-clears-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"gap-write-reopen-clears"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { resolveSubstrateGapWrite, gapStoreRootForTest } = sg;

const STORE = join(ROOT, "gaps", "gaps.json");
const AT = "2026-10-03T10:00:00.000Z";
const realFetch = globalThis.fetch;
const CLOSURE_KEYS = ["closed_reason", "closed_by", "close_basis", "landed_sha", "landed_commit", "falsifier_exercise", "close_note"];
const CLOSED = {
  id: "reopen-fixture-closed-gap", category: "systematic_failure", source: "human_reported", summary: "a gap the sweep closed on a landing", detected_at: AT, status: "closed",
  classification_metadata: { severity: "high", closed_reason: "landed_verified", closed_by: "gap-sweep", close_basis: "absent", landed_sha: "abc1234", landed_commit: "abc1234", falsifier_exercise: { detector: "gap-sweep", verdict: "absent", passed: true, commit: "abc1234" }, close_note: "landed" },
  created_at: AT, updated_at: AT, closed_at: AT,
};
const rows = (): Array<Record<string, any>> => JSON.parse(readFileSync(STORE, "utf8"));
const stored = (id: string): Record<string, any> | undefined => rows().find((g) => g.id === id);
const write = (pointer: Record<string, unknown>) => resolveSubstrateGapWrite({ type: "substrateGap_write", ...pointer } as never, { vocabulary: null } as never) as Promise<{ shape: string; body: Record<string, unknown> }>;
const reopen = () => write({ gap: { id: CLOSED.id, category: CLOSED.category, source: CLOSED.source, summary: CLOSED.summary, detected_at: AT, status: "open", classification_metadata: { reopen_note: "still broken" } } });

beforeEach(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  writeFileSync(STORE, JSON.stringify([CLOSED]));
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe("substrateGap_write: a reopen clears the last close's evidence", () => {
  it("isolation: the store under test is this file's temp root", () => {
    expect(gapStoreRootForTest()).toBe(ROOT);
  });

  it("[MUST-FAIL] a reopened row holds none of the closure keys", async () => {
    expect((await reopen()).shape).toBe("substrateGapWriteResult");
    const meta = stored(CLOSED.id)!.classification_metadata;
    for (const k of CLOSURE_KEYS) expect(meta[k]).toBeUndefined();
    expect(meta.severity).toBe("high");
    expect(stored(CLOSED.id)!.reopen_count).toBe(1);
  });

  it("[MUST-FAIL] a read-modify-write echo of a reopened row with status closed and no new evidence is refused", async () => {
    await reopen();
    const row = stored(CLOSED.id)!;
    const r = await write({ gap: { ...row, status: "closed" } });
    expect(r.shape).toBe("structuredError");
    expect(r.body["rule"]).toBe("close_needs_evidence");
    expect(stored(CLOSED.id)!.status).toBe("open");
  });

  it("[MUST-FAIL] a reopen that itself echoes the closed row's metadata still clears the closure keys", async () => {
    const r = await write({ gap: { ...CLOSED, status: "open" } });
    expect(r.shape).toBe("substrateGapWriteResult");
    const meta = stored(CLOSED.id)!.classification_metadata;
    for (const k of CLOSURE_KEYS) expect(meta[k]).toBeUndefined();
  });

  it("[MUST-FAIL] an open write echoing a stale closed snapshot onto a reopened row does not reinstate the evidence", async () => {
    await reopen();
    await write({ gap: { ...CLOSED, status: "open", classification_metadata: { ...CLOSED.classification_metadata, failed_attempts: 1 } } });
    const meta = stored(CLOSED.id)!.classification_metadata;
    for (const k of CLOSURE_KEYS) expect(meta[k]).toBeUndefined();
    expect(meta.failed_attempts).toBe(1);
  });

  it("[CONTROL] a reopen followed by a genuine evidence-carrying close closes it", async () => {
    await reopen();
    const row = stored(CLOSED.id)!;
    const r = await write({ gap: { ...row, status: "closed", classification_metadata: { ...row.classification_metadata, closed_reason: "landed_verified", landed_sha: "def5678", falsifier_exercise: { detector: "gap-sweep", verdict: "absent", passed: true, commit: "def5678" } } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    const after = stored(CLOSED.id)!;
    expect(after.status).toBe("closed");
    expect(after.classification_metadata.landed_sha).toBe("def5678");
  });
});
