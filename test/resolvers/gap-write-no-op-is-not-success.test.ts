// A GAP WRITE THAT CHANGES NOTHING IS NOT A SUCCESS (check-first, 2026-10-03).
//
// resolveSubstrateGapWrite answered two no-ops with shape substrateGapWriteResult and action
// "skipped": a close or reject for an id with no row (close_without_open_row), and a conditional
// write whose expect_status did not match (status_precondition_failed). The HTTP route maps every
// non-structuredError shape to success:true, so a caller that closed a gap that does not exist was
// told it succeeded. Observed: a walk's terminal substrateGap_write was recorded as applied while the
// store held no such row.
//
// CONTRACT: both no-ops answer shape structuredError (the route then says success:false), keeping
// action "skipped", skip_reason, gap_class / stored_status in the body so callers that branch on
// skip_reason keep working, plus a detail naming why nothing was written. The store is unchanged.
// Controls: a close of an existing open row and a matching expect_status write still succeed.
//
// SEAM: fresh module instance under this file's temp root; rows are SEEDED into the store file.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-write-no-op-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"gap-write-no-op"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { resolveSubstrateGapWrite, gapStoreRootForTest } = sg;

const STORE = join(ROOT, "gaps", "gaps.json");
const AT = "2026-10-03T10:00:00.000Z";
const realFetch = globalThis.fetch;
const OPEN = { id: "no-op-fixture-open-gap", category: "systematic_failure", source: "human_reported", summary: "an open gap the store holds", detected_at: AT, status: "open", classification_metadata: { severity: "low" }, created_at: AT, updated_at: AT };
const rows = (): Array<Record<string, any>> => JSON.parse(readFileSync(STORE, "utf8"));
const stored = (id: string): Record<string, any> | undefined => rows().find((g) => g.id === id);
const write = (pointer: Record<string, unknown>) => resolveSubstrateGapWrite({ type: "substrateGap_write", ...pointer } as never, { vocabulary: null } as never) as Promise<{ shape: string; body: Record<string, unknown> }>;
const evidence = { closed_reason: "condition_gone", closed_by: "no-op-fixture-detector" };

beforeEach(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  writeFileSync(STORE, JSON.stringify([OPEN]));
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe("substrateGap_write: a write that changes nothing is not a success", () => {
  it("isolation: the store under test is this file's temp root", () => {
    expect(gapStoreRootForTest()).toBe(ROOT);
  });

  it("[MUST-FAIL] a close for an id the store does not hold answers structuredError with the skip reason, and creates nothing", async () => {
    const r = await write({ gap: { id: "no-op-fixture-never-existed", category: "other", source: "substrate_detected", summary: "close a gap that is not there", detected_at: AT, status: "closed", classification_metadata: evidence } });
    expect(r.shape).toBe("structuredError");
    expect(r.body["action"]).toBe("skipped");
    expect(r.body["skip_reason"]).toBe("close_without_open_row");
    expect(String(r.body["detail"])).toContain("no-op-fixture-never-existed");
    expect(stored("no-op-fixture-never-existed")).toBeUndefined();
    expect(rows()).toHaveLength(1);
  });

  it("[MUST-FAIL] a reject for an id the store does not hold answers structuredError", async () => {
    const r = await write({ gap: { id: "no-op-fixture-never-rejected", category: "other", source: "substrate_detected", summary: "reject a gap that is not there", detected_at: AT, status: "rejected", classification_metadata: evidence } });
    expect(r.shape).toBe("structuredError");
    expect(r.body["skip_reason"]).toBe("close_without_open_row");
    expect(stored("no-op-fixture-never-rejected")).toBeUndefined();
  });

  it("[MUST-FAIL] a conditional write whose expect_status does not match answers structuredError and leaves the row as stored", async () => {
    const r = await write({ expect_status: "closed", gap: { ...OPEN, summary: "a stale writer's summary", classification_metadata: { severity: "high" } } });
    expect(r.shape).toBe("structuredError");
    expect(r.body["skip_reason"]).toBe("status_precondition_failed");
    expect(r.body["stored_status"]).toBe("open");
    const row = stored(OPEN.id)!;
    expect(row.summary).toBe(OPEN.summary);
    expect(row.classification_metadata.severity).toBe("low");
  });

  it("[CONTROL] a close of a row the store holds succeeds and closes it", async () => {
    const r = await write({ gap: { ...OPEN, status: "closed", classification_metadata: evidence } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(r.body["action"]).toBe("updated");
    expect(stored(OPEN.id)!.status).toBe("closed");
  });

  it("[CONTROL] a conditional write whose expect_status matches succeeds", async () => {
    const r = await write({ expect_status: "open", gap: { ...OPEN, classification_metadata: { severity: "high" } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(OPEN.id)!.classification_metadata.severity).toBe("high");
  });
});
