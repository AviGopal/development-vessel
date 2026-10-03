// BIRTH FIELDS ARE IMMUTABLE; A CLOSE DOES NOT REWRITE WHAT THE GAP SAYS (check-first, 2026-10-03).
//
// Observed in the live store: walk writes onto existing operator gaps dropped or rewrote `source`
// (human_reported became absent or substrate_detected), restamped `detected_at` to the write time,
// and, together with a close, replaced the summary with a one-line echo of the closing goal and the
// category with "gap". The store REPLACES rather than merges these fields, so the row lost who filed
// it, when, and what it said, which is the evidence by which a false close could be detected.
// goal-reach-tick attributes reaches by the stored source; a rewritten source moves that attribution.
//
// RULES:
//   - On an EXISTING row, `source`, `detected_at` and `first_detected_at` keep their stored values
//     whatever the write carries (a stored value that is absent or an unbound slot may be filled).
//     A write that tried to change one is logged.
//   - A write that closes or rejects an existing row keeps the stored `summary` and `category` unless
//     it carries the operator marker (pointer-level operator:<id>). The incoming summary, when it
//     differs, is kept beside it as classification_metadata.close_note. Open re-emissions still
//     replace the summary: detectors legitimately refresh what an open gap says.
//
// SEAM: fresh module instance under this file's temp root; rows are SEEDED into the store file.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-write-birth-fields-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"gap-write-birth-fields"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { resolveSubstrateGapWrite, gapStoreRootForTest } = sg;

const STORE = join(ROOT, "gaps", "gaps.json");
const BORN = "2026-09-20T12:00:00.000Z";
const LATER = "2026-10-03T10:59:28.910Z";
const realFetch = globalThis.fetch;
const OP_SUMMARY = "The hold guard refuses only a close, so any writer can reject or otherwise move a held gap. Measured on the live store with three rows; fix direction and falsifier follow.";
const OP = { id: "birth-fixture-operator-gap", category: "systematic_failure", source: "human_reported", summary: OP_SUMMARY, detected_at: BORN, first_detected_at: BORN, status: "open", classification_metadata: { severity: "medium" }, created_at: BORN, updated_at: BORN };
const NOSRC = { id: "birth-fixture-unsourced-gap", category: "systematic_failure", summary: "a legacy row written without a source", detected_at: BORN, status: "open", created_at: BORN, updated_at: BORN };
const rows = (): Array<Record<string, any>> => JSON.parse(readFileSync(STORE, "utf8"));
const stored = (id: string): Record<string, any> | undefined => rows().find((g) => g.id === id);
const write = (pointer: Record<string, unknown>) => resolveSubstrateGapWrite({ type: "substrateGap_write", ...pointer } as never, { vocabulary: null } as never) as Promise<{ shape: string; body: Record<string, unknown> }>;
const evidence = { closed_reason: "condition_gone", closed_by: "birth-fixture-detector" };

let logs: string[] = [];
let logSpy: ReturnType<typeof spyOn> | null = null;
let warnSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  writeFileSync(STORE, JSON.stringify([OP, NOSRC]));
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
  logs = [];
  logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  warnSpy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => { logSpy?.mockRestore(); warnSpy?.mockRestore(); });
afterAll(() => { globalThis.fetch = realFetch; });

describe("substrateGap_write keeps birth fields and does not let a close rewrite the gap", () => {
  it("isolation: the store under test is the temp root of this file", () => {
    expect(gapStoreRootForTest()).toBe(ROOT);
  });

  it("[MUST-FAIL] a re-emission carrying another source keeps the stored source, and the attempt is logged", async () => {
    const r = await write({ gap: { ...OP, source: "substrate_detected", detected_at: LATER, classification_metadata: { region: "fixture" } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(OP.id)!.source).toBe("human_reported");
    expect(logs.some((l) => l.includes(OP.id) && l.includes("source"))).toBe(true);
  });

  it("[MUST-FAIL] a write that omits source does not erase the stored source", async () => {
    const { source: _omit, ...noSource } = OP;
    const r = await write({ gap: { ...noSource, classification_metadata: { region: "fixture" } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(OP.id)!.source).toBe("human_reported");
  });

  it("[MUST-FAIL] detected_at and first_detected_at keep their stored values", async () => {
    const r = await write({ gap: { ...OP, detected_at: LATER, first_detected_at: LATER, classification_metadata: { region: "fixture" } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    const row = stored(OP.id)!;
    expect(row.detected_at).toBe(BORN);
    expect(row.first_detected_at).toBe(BORN);
  });

  it("[MUST-FAIL] a close by a non-operator writer keeps the stored summary and category, and records its own text as close_note", async () => {
    const r = await write({ gap: { id: OP.id, category: "gap", source: OP.source, summary: "Closing the gap where the hold guard is refusing to close gaps.", detected_at: LATER, status: "closed", classification_metadata: evidence } });
    expect(r.shape).toBe("substrateGapWriteResult");
    const row = stored(OP.id)!;
    expect(row.status).toBe("closed");
    expect(row.summary).toBe(OP_SUMMARY);
    expect(row.category).toBe("systematic_failure");
    expect(row.classification_metadata.close_note).toBe("Closing the gap where the hold guard is refusing to close gaps.");
  });

  it("[MUST-FAIL] a reject by a non-operator writer keeps the stored summary and category", async () => {
    const r = await write({ gap: { id: OP.id, category: "other", source: OP.source, summary: "rejected: not a real gap", detected_at: LATER, status: "rejected", classification_metadata: { rejected_reason: "fixture", closed_by: "birth-fixture-detector" } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    const row = stored(OP.id)!;
    expect(row.status).toBe("rejected");
    expect(row.summary).toBe(OP_SUMMARY);
    expect(row.category).toBe("systematic_failure");
  });

  it("[CONTROL] an open re-emission still replaces the summary", async () => {
    const r = await write({ gap: { ...OP, summary: "re-observed: the hold guard still refuses only a close, now on four rows" } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(OP.id)!.summary).toBe("re-observed: the hold guard still refuses only a close, now on four rows");
  });

  it("[CONTROL] an operator-marked close may rewrite the summary and category", async () => {
    const r = await write({ operator: "operator:avi", gap: { id: OP.id, category: "gap", source: OP.source, summary: "closed by hand: superseded by the landed guard", detected_at: LATER, status: "closed", classification_metadata: { closed_reason: "superseded_by_landing" } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    const row = stored(OP.id)!;
    expect(row.summary).toBe("closed by hand: superseded by the landed guard");
    expect(row.category).toBe("gap");
    expect(row.source).toBe("human_reported");
  });

  it("[CONTROL] a new row takes the incoming source and detected_at", async () => {
    const r = await write({ gap: { id: "birth-fixture-new-gap", category: "systematic_failure", source: "substrate_detected", summary: "a new finding", detected_at: LATER, status: "open" } });
    expect(r.shape).toBe("substrateGapWriteResult");
    const row = stored("birth-fixture-new-gap")!;
    expect(row.source).toBe("substrate_detected");
    expect(row.detected_at).toBe(LATER);
  });

  it("[CONTROL] a stored row with no source may have one filled in", async () => {
    const r = await write({ gap: { ...NOSRC, source: "human_reported" } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(NOSRC.id)!.source).toBe("human_reported");
  });
});
