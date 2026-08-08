import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The store path is workspaceRoot()/gaps/gaps.json, resolved per call, so each
// test gets its own WORKSPACE_ROOT and the real file path is exercised.
let dir: string;
let gapsPath: string;

const OK_GAP = { id: "some-real-gap", category: "source_divergence", source: "substrate_detected", status: "open", summary: "a gap that describes itself" };

function writeStore(rows: unknown[]): void {
  writeFileSync(gapsPath, JSON.stringify(rows));
}
function readStore(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(gapsPath, "utf-8"));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gapstore-"));
  mkdirSync(join(dir, "gaps"), { recursive: true });
  gapsPath = join(dir, "gaps", "gaps.json");
  process.env.WORKSPACE_ROOT = dir;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("gapClassKey — total over untrusted stored rows", async () => {
  const { gapClassKey } = await import("./substrate-gap");

  it("strips volatile tokens as before", () => {
    expect(gapClassKey("responsibility-x-1786176268124")).toBe("responsibility-x-M");
    expect(gapClassKey("probe-2026-08-08")).toBe("probe-D");
  });

  it("REGRESSION: does not throw on a row whose id is missing", () => {
    // The live crash: `undefined is not an object (evaluating 'id.replace')`.
    expect(() => gapClassKey(undefined as unknown as string)).not.toThrow();
    expect(() => gapClassKey(null as unknown as string)).not.toThrow();
  });
});

describe("substrateGap_write — one malformed row must not brick the store", async () => {
  const { resolveSubstrateGapWrite } = await import("./substrate-gap");

  it("OBSERVED LIVE 2026-08-08: a {gap_id,gap_status} row 500'd every write for days", async () => {
    // The exact row from the hub. Wrong field names, so `status` is undefined —
    // which passes `status !== "closed"` and then threw on the undefined id.
    writeStore([{ gap_id: "terminal-write-bound-before-compute-and-bridge-targets-only-obsidian", gap_status: "closed" }]);
    const res = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: OK_GAP } as never);
    expect(res.shape).not.toBe("structuredError");
    // The good gap landed; the malformed row was left alone, not silently dropped.
    const rows = readStore();
    expect(rows.some((r) => r["id"] === "some-real-gap")).toBe(true);
    expect(rows.some((r) => r["gap_id"] === "terminal-write-bound-before-compute-and-bridge-targets-only-obsidian")).toBe(true);
  });

  it("still dedups by class against well-formed rows", async () => {
    writeStore([{ ...OK_GAP, id: "dupe-1786176268124" }]);
    const res = await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: { ...OK_GAP, id: "dupe-1786176268999" },
    } as never);
    expect(res.shape).not.toBe("structuredError");
    // Same class (trailing epoch-ms stripped) — upserts onto one row, not two.
    expect(readStore()).toHaveLength(1);
  });

  it("rejects a gap with no id as validation, not a 500", async () => {
    writeStore([]);
    const res = await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: { category: "x", source: "substrate_detected", status: "open", summary: "no id here" },
    } as never);
    expect(res.shape).toBe("structuredError");
    const body = res.body as Record<string, unknown>;
    expect(body["field"]).toBe("gap.id");
    // The detail is fed to pointer-arg synthesis — it must name the right key.
    expect(String(body["detail"])).toMatch(/gap_id/);
  });

  it("a malformed row does not distort the consumption gate's open count", async () => {
    // The gate counts open rows in a class; an unclassifiable row is not in any
    // class, so it must neither be counted nor throw while counting.
    writeStore([{ gap_id: "junk", gap_status: "closed" }, { ...OK_GAP, id: "class-a-1786176268124" }]);
    const res = await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: { ...OK_GAP, id: "class-b-1786176268124", summary: "different class member" },
    } as never);
    expect(res.shape).not.toBe("structuredError");
  });
});
