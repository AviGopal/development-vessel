// resolvePoolImpulseWriteMany: many pool writes, ONE load and ONE rewrite, each pointer under exactly the single
// write's checks. A refused pointer refuses only itself (the rest still land), and a runner-only refusal it records is
// saved with the batch rather than overwritten by it.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pool from "../../src/resolvers/pool-impulse.js";

let base = "";
beforeEach(() => { base = mkdtempSync(join(tmpdir(), "pool-many-")); pool.__setPoolFileForTests(join(base, "pool", "standing.json")); });
afterEach(() => { pool.__setPoolFileForTests(null); rmSync(base, { recursive: true, force: true }); });

const many = (pool as Record<string, unknown>)["resolvePoolImpulseWriteMany"] as
  | ((ps: Array<Record<string, unknown>>, auth?: unknown) => Array<{ body: { ok: boolean; id: string; error?: string } }>)
  | undefined;
const all = (shape?: string) => pool.resolvePoolImpulse({ type: "poolImpulse", ...(shape ? { shape } : {}) }).body.impulses;

describe("resolvePoolImpulseWriteMany", () => {
  it("applies every accepted pointer in one rewrite and returns one result per pointer, in order", () => {
    expect(typeof many).toBe("function");
    pool.resolvePoolImpulseWrite({ type: "poolImpulse_write", id: "row:a", shape: "fixtureRow", body: { v: 0 }, source: "test" });
    const out = many!([
      { type: "poolImpulse_write", id: "row:a", shape: "fixtureRow", body: { v: 1 }, source: "test" },
      { type: "poolImpulse_write", id: "row:b", shape: "fixtureRow", body: { v: 2 }, source: "test" },
    ]);
    expect(out.map((r) => [r.body.id, r.body.ok])).toEqual([["row:a", true], ["row:b", true]]);
    expect(all("fixtureRow").map((r) => [r.id, (r.body as { v: number }).v]).sort()).toEqual([["row:a", 1], ["row:b", 2]]);
  });

  it("a refused pointer (trust-root, no operator credential) refuses only itself", () => {
    expect(typeof many).toBe("function");
    const out = many!([
      { type: "poolImpulse_write", id: "row:c", shape: "fixtureRow", body: { v: 3 }, source: "test" },
      { type: "poolImpulse_write", id: "scope:x", shape: "autonomyScope", body: {}, source: "test" },
      { type: "poolImpulse_write", id: "row:d", shape: "fixtureRow", body: { v: 4 }, source: "test" },
    ]);
    expect(out.map((r) => r.body.ok)).toEqual([true, false, true]);
    expect(out[1]!.body.error).toContain("operator_credential_required");
    expect(all("fixtureRow").map((r) => r.id).sort()).toEqual(["row:c", "row:d"]);
    expect(all("autonomyScope")).toHaveLength(0);
  });

  it("a runner-only pointer is refused without a grant, and its recorded refusal survives the batch's save", () => {
    expect(typeof many).toBe("function");
    const out = many!([
      { type: "poolImpulse_write", id: "row:e", shape: "fixtureRow", body: { v: 5 }, source: "test" },
      { type: "poolImpulse_write", shape: pool.VERDICT_CORPUS_STATUS_SHAPE, body: { run_at: new Date().toISOString(), holds: [] }, source: pool.VERDICT_CORPUS_RUN_SOURCE },
    ]);
    expect(out.map((r) => r.body.ok)).toEqual([true, false]);
    expect(all("fixtureRow").map((r) => r.id)).toEqual(["row:e"]);
    expect(all(pool.VERDICT_CORPUS_STATUS_SHAPE)).toHaveLength(0);
    expect(all("verdictCorpusWriteRefusal")).toHaveLength(1);
  });

  it("an empty batch touches nothing", () => {
    expect(typeof many).toBe("function");
    expect(many!([])).toEqual([]);
    expect(all()).toHaveLength(0);
  });
});
