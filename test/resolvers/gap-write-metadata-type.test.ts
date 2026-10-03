// CLASSIFICATION_METADATA MUST BE AN OBJECT (check-first, 2026-10-03).
//
// Observed in the live store: an autonomous walk wrote substrateGap_write with
// classification_metadata as the unrendered STRING "{{goal.classification_metadata}}". The writer
// cast it to a record and the carry-forward loop spread it one character per key, so the stored row
// held {"0":"{","1":"{","2":"g",...} beside the real keys. A non-object metadata value carries no
// fields the store can read; it can only corrupt the row it lands on.
//
// CONTRACT: a write whose classification_metadata is present and is not a plain object (a string,
// number, boolean or array) is refused with a structured error naming the field, on the enveloped
// and the flat pointer alike, and the stored row is unchanged. Absent or null metadata is "no
// metadata" and stays accepted.
//
// SEAM: a FRESH substrate-gap module instance (query-string import) loaded after WORKSPACE_ROOT
// points at this file's temp root, asserted before any write. Rows are SEEDED into the store file.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-write-metadata-type-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"gap-write-metadata-type"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { resolveSubstrateGapWrite, gapStoreRootForTest } = sg;

const STORE = join(ROOT, "gaps", "gaps.json");
const AT = "2026-10-03T10:00:00.000Z";
const realFetch = globalThis.fetch;
const SEEDED = { id: "metadata-type-fixture-gap", category: "systematic_failure", source: "human_reported", summary: "a seeded open gap with real metadata", detected_at: AT, status: "open", classification_metadata: { severity: "high", edit_site: "src/x.ts" }, created_at: AT, updated_at: AT };
const stored = (id: string): Record<string, any> | undefined => (JSON.parse(readFileSync(STORE, "utf8")) as Array<Record<string, any>>).find((g) => g.id === id);
const write = (pointer: Record<string, unknown>) => resolveSubstrateGapWrite({ type: "substrateGap_write", ...pointer } as never, { vocabulary: null } as never) as Promise<{ shape: string; body: Record<string, unknown> }>;

beforeEach(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  writeFileSync(STORE, JSON.stringify([SEEDED]));
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe("substrateGap_write refuses a non-object classification_metadata", () => {
  it("isolation: the store under test is the temp root of this file", () => {
    expect(gapStoreRootForTest()).toBe(ROOT);
  });

  it("[MUST-FAIL] a string classification_metadata on an existing row is refused and the row is not spread one char per key", async () => {
    const r = await write({ gap: { id: SEEDED.id, category: SEEDED.category, source: SEEDED.source, summary: SEEDED.summary, detected_at: AT, status: "open", classification_metadata: "{{goal.classification_metadata}}" } });
    expect(r.shape).toBe("structuredError");
    expect(String(r.body["field"])).toBe("gap.classification_metadata");
    const row = stored(SEEDED.id)!;
    expect(Object.keys(row.classification_metadata)).toEqual(["severity", "edit_site"]);
  });

  it("[MUST-FAIL] an array classification_metadata on a new row is refused and nothing is created", async () => {
    const r = await write({ gap: { id: "metadata-type-array-fixture", category: "systematic_failure", source: "human_reported", summary: "an array metadata write", detected_at: AT, status: "open", classification_metadata: ["a", "b"] } });
    expect(r.shape).toBe("structuredError");
    expect(stored("metadata-type-array-fixture")).toBeUndefined();
  });

  it("[MUST-FAIL] a number classification_metadata is refused", async () => {
    const r = await write({ gap: { id: SEEDED.id, category: SEEDED.category, source: SEEDED.source, summary: SEEDED.summary, detected_at: AT, status: "open", classification_metadata: 42 } });
    expect(r.shape).toBe("structuredError");
    expect(stored(SEEDED.id)!.classification_metadata).toEqual(SEEDED.classification_metadata);
  });

  it("[MUST-FAIL] a flat pointer carrying a string classification_metadata is refused, not silently dropped", async () => {
    const r = await write({ id: "metadata-type-flat-fixture", summary: "a flat pointer with string metadata", classification_metadata: "severity=high" });
    expect(r.shape).toBe("structuredError");
    expect(stored("metadata-type-flat-fixture")).toBeUndefined();
  });

  it("[CONTROL] an object classification_metadata is accepted and merged onto the stored row", async () => {
    const r = await write({ gap: { id: SEEDED.id, category: SEEDED.category, source: SEEDED.source, summary: SEEDED.summary, detected_at: AT, status: "open", classification_metadata: { region: "fixture" } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    const row = stored(SEEDED.id)!;
    expect(row.classification_metadata.region).toBe("fixture");
    expect(row.classification_metadata.severity).toBe("high");
  });

  it("[CONTROL] absent and null classification_metadata are accepted as no metadata", async () => {
    const a = await write({ gap: { id: SEEDED.id, category: SEEDED.category, source: SEEDED.source, summary: SEEDED.summary, detected_at: AT, status: "open" } });
    expect(a.shape).toBe("substrateGapWriteResult");
    const n = await write({ gap: { id: SEEDED.id, category: SEEDED.category, source: SEEDED.source, summary: SEEDED.summary, detected_at: AT, status: "open", classification_metadata: null } });
    expect(n.shape).toBe("substrateGapWriteResult");
    expect(stored(SEEDED.id)!.classification_metadata.severity).toBe("high");
  });
});
