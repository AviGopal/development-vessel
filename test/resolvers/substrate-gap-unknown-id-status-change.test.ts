// Close-if-open for every writer (2026-10-01): a status change with no exact and no class row is a no-op. Rows are SEEDED
// into the store file, never created through the write path: an open-row write fires the compose
// trigger (systemctl start gap-compose), which a test must not do on a live host.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gapStoreRootForTest, resolveSubstrateGapWrite } from "../../src/resolvers/substrate-gap.js";

const root = gapStoreRootForTest();
const path = join(root, "gaps", "gaps.json");
let saved: string | null = null;
const realFetch = globalThis.fetch;
const NOW = new Date().toISOString();
const seed = [
  { id: "detector-fixture-finding-1788888888888", category: "systematic_failure", source: "substrate_detected", status: "open", summary: "a detector finding", created_at: NOW, detected_at: NOW, updated_at: NOW },
  { id: "known-open-gap-fixture", category: "systematic_failure", source: "human_reported", status: "open", summary: "a known open gap", created_at: NOW, detected_at: NOW, updated_at: NOW },
];
const rows = (): Array<Record<string, unknown>> => JSON.parse(readFileSync(path, "utf8"));
const write = (gap: Record<string, unknown>) => resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never, { vocabulary: null } as never) as Promise<{ shape: string; body: Record<string, unknown> }>;

beforeAll(() => {
  if (!root.startsWith(tmpdir())) throw new Error(`refusing to seed a store root outside ${tmpdir()}: ${root}`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  saved = existsSync(path) ? readFileSync(path, "utf8") : null;
  writeFileSync(path, JSON.stringify(seed));
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (saved === null) writeFileSync(path, "[]"); else writeFileSync(path, saved);
});

describe("close-if-open applies to every writer (no env gate)", () => {
  it("(a) a close for an id with no exact row and no open row of its class inserts nothing", async () => {
    const saved = process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"];
    delete process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"];
    try {
      const r = await write({ id: "never-existed-fixture-gap", category: "other", source: "substrate_detected", status: "closed", summary: "close it" });
      expect(r.body.action).toBe("skipped");
      expect(r.body.skip_reason).toBe("close_without_open_row");
      expect(rows().some((g) => g.id === "never-existed-fixture-gap")).toBe(false);
      const j = await write({ id: "never-existed-fixture-reject", category: "other", source: "substrate_detected", status: "rejected", summary: "reject it" });
      expect(j.body.action).toBe("skipped");
      expect(rows().some((g) => g.id === "never-existed-fixture-reject")).toBe(false);
    } finally {
      if (saved !== undefined) process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = saved;
    }
  });
  it("(b) control: a detector closing its own gap under a fresh timestamped id closes the open row of that class", async () => {
    const r = await write({ id: "detector-fixture-finding-1789999999999", category: "systematic_failure", source: "substrate_detected", status: "closed", summary: "condition cleared", classification_metadata: { closed_reason: "condition_cleared" } });
    expect(r.body.action).toBe("updated");
    const open = rows().find((g) => g.id === "detector-fixture-finding-1788888888888");
    expect(open?.status).toBe("closed");
    expect(rows().some((g) => g.id === "detector-fixture-finding-1789999999999")).toBe(false);
  });
  it("(c) control: a close for an id the store holds closes that row", async () => {
    const r = await write({ id: "known-open-gap-fixture", category: "systematic_failure", source: "human_reported", status: "closed", summary: "a known open gap", classification_metadata: { closed_reason: "test" } });
    expect(r.body.action).toBe("updated");
    expect(rows().find((g) => g.id === "known-open-gap-fixture")?.status).toBe("closed");
  });
});
