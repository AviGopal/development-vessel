// UNRENDERED {{binding}} TOKENS ARE REFUSED AT EVERY STATUS (check-first, 2026-10-03).
//
// Observed in the live store: rows with id "{{goal.id}}" and "{{shape_gap_resolution.id}}", category
// "{{goal.category}}", source "{{goal.source}}", summary "{{goal.summary}}" and closed_by_trace
// "{{goal.trace_id}}", all status closed. A walk's author_producer validation wrote them; the
// description gate that refuses "{{" in id/category ran only when status was open, so a CLOSE
// carried every unbound slot straight into the store.
//
// CONTRACT:
//   - A binding token ({{name}} or {{name.path}}) in id, category, source, summary, or any string
//     anywhere under classification_metadata is refused with a structured error naming the field,
//     whatever the write's status, and the stored row is unchanged.
//   - A token quoted in backticks (`{{goal.id}}`) is a quotation, not an unbound slot: a gap that
//     DESCRIBES an interpolation bug can still name the token.
//   - Template-like text that is not a binding token (JSX style={{ color: x }}) is not refused.
//   - A value byte-identical to the stored row's value at the same field is not refused, so a row
//     that already holds such text (written before this gate) is not wedged: read-modify-write callers
//     re-send stored metadata and summaries. The id gets no such exemption.
//
// SEAM: fresh module instance under this file's temp root; rows are SEEDED into the store file.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-write-placeholder-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"gap-write-placeholder"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { resolveSubstrateGapWrite, gapStoreRootForTest } = sg;

const STORE = join(ROOT, "gaps", "gaps.json");
const AT = "2026-10-03T10:00:00.000Z";
const realFetch = globalThis.fetch;
const REAL = { id: "placeholder-fixture-real-gap", category: "systematic_failure", source: "human_reported", summary: "a real operator gap with a real summary", detected_at: AT, status: "open", classification_metadata: { severity: "high" }, created_at: AT, updated_at: AT };
const JUNK = { id: "{{goal.id}}", category: "other", source: "substrate_detected", summary: "junk row from an unbound walk", detected_at: AT, status: "open", classification_metadata: {}, created_at: AT, updated_at: AT };
const LEGACY = { id: "placeholder-fixture-legacy-gap", category: "systematic_failure", source: "human_reported", summary: "describes the binder: it leaves {{goal.id}} literal in nested fields", detected_at: AT, status: "open", classification_metadata: { note: "observed value {{goal.trace_id}}" }, created_at: AT, updated_at: AT };
const rows = (): Array<Record<string, any>> => JSON.parse(readFileSync(STORE, "utf8"));
const stored = (id: string): Record<string, any> | undefined => rows().find((g) => g.id === id);
const write = (gap: Record<string, unknown>) => resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never, { vocabulary: null } as never) as Promise<{ shape: string; body: Record<string, unknown> }>;
const evidence = { closed_reason: "condition_gone", closed_by: "placeholder-fixture-detector" };

beforeEach(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  writeFileSync(STORE, JSON.stringify([REAL, JUNK, LEGACY]));
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe("substrateGap_write refuses unrendered binding tokens at every status", () => {
  it("isolation: the store under test is the temp root of this file", () => {
    expect(gapStoreRootForTest()).toBe(ROOT);
  });

  it("[MUST-FAIL] a CLOSE whose id is an unbound slot is refused and the row stays open", async () => {
    const r = await write({ id: "{{goal.id}}", category: "other", source: "substrate_detected", summary: "junk row from an unbound walk", detected_at: AT, status: "closed", classification_metadata: evidence });
    expect(r.shape).toBe("structuredError");
    expect(String(r.body["field"])).toBe("gap.id");
    expect(stored("{{goal.id}}")!.status).toBe("open");
  });

  it("[MUST-FAIL] a CLOSE of a real gap carrying category, source and summary slots is refused and the row is untouched", async () => {
    const r = await write({ id: REAL.id, category: "{{goal.category}}", source: "{{goal.source}}", summary: "{{goal.summary}}", detected_at: AT, status: "closed", classification_metadata: evidence });
    expect(r.shape).toBe("structuredError");
    const row = stored(REAL.id)!;
    expect(row.status).toBe("open");
    expect(row.summary).toBe(REAL.summary);
    expect(row.category).toBe(REAL.category);
  });

  it("[MUST-FAIL] a REJECT whose source is an unbound slot is refused", async () => {
    const r = await write({ id: REAL.id, category: REAL.category, source: "{{goal.source}}", summary: REAL.summary, detected_at: AT, status: "rejected", classification_metadata: evidence });
    expect(r.shape).toBe("structuredError");
    expect(String(r.body["field"])).toBe("gap.source");
    expect(stored(REAL.id)!.status).toBe("open");
  });

  it("[MUST-FAIL] an OPEN write whose summary is an unbound slot is refused", async () => {
    const r = await write({ id: REAL.id, category: REAL.category, source: REAL.source, summary: "{{goal.summary}}", detected_at: AT, status: "open" });
    expect(r.shape).toBe("structuredError");
    expect(String(r.body["field"])).toBe("gap.summary");
    expect(stored(REAL.id)!.summary).toBe(REAL.summary);
  });

  it("[MUST-FAIL] a slot nested anywhere under classification_metadata is refused on a close", async () => {
    const r = await write({ id: REAL.id, category: REAL.category, source: REAL.source, summary: REAL.summary, detected_at: AT, status: "closed", classification_metadata: { ...evidence, falsifier_exercise: { passed: true, trace: "{{goal.trace_id}}" } } });
    expect(r.shape).toBe("structuredError");
    expect(String(r.body["field"])).toBe("gap.classification_metadata.falsifier_exercise.trace");
    expect(stored(REAL.id)!.status).toBe("open");
  });

  it("[MUST-FAIL] a slot inside an array under classification_metadata is refused on an open write", async () => {
    const r = await write({ id: REAL.id, category: REAL.category, source: REAL.source, summary: REAL.summary, detected_at: AT, status: "open", classification_metadata: { related: ["ok-id", "{{goal.related}}"] } });
    expect(r.shape).toBe("structuredError");
    expect(String(r.body["field"])).toBe("gap.classification_metadata.related.1");
  });

  it("[CONTROL] a summary that QUOTES a token in backticks is accepted", async () => {
    const r = await write({ id: REAL.id, category: REAL.category, source: REAL.source, summary: "the binder leaves `{{goal.id}}` literal in nested gap fields", detected_at: AT, status: "open" });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(REAL.id)!.summary).toContain("`{{goal.id}}`");
  });

  it("[CONTROL] JSX-like double braces that are not a binding token are accepted in metadata", async () => {
    const r = await write({ id: REAL.id, category: REAL.category, source: REAL.source, summary: REAL.summary, detected_at: AT, status: "open", classification_metadata: { failure_lessons: [{ reason: "old_string <div style={{ color: x }}> not found" }] } });
    expect(r.shape).toBe("substrateGapWriteResult");
  });

  it("[CONTROL] a row already holding token text is not wedged: re-sending the stored summary and metadata closes it", async () => {
    const r = await write({ id: LEGACY.id, category: LEGACY.category, source: LEGACY.source, summary: LEGACY.summary, detected_at: AT, status: "closed", classification_metadata: { ...LEGACY.classification_metadata, ...evidence } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(LEGACY.id)!.status).toBe("closed");
  });

  it("[CONTROL] a fully rendered close of a real gap is accepted", async () => {
    const r = await write({ id: REAL.id, category: REAL.category, source: REAL.source, summary: REAL.summary, detected_at: AT, status: "closed", classification_metadata: evidence });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(REAL.id)!.status).toBe("closed");
  });
});
