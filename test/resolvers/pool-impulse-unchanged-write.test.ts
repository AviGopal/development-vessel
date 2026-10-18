// A pool write that would store exactly the row already stored rewrites nothing.
//
// WHY. Every write rewrites the whole pool file (~22 MB live). The substrateGap -> pool mirror ends every gap write
// with an unconditional write whose body is usually identical (a re-classification or attempt bump touches none of
// its fields), and detectors re-file gaps in bursts, so each burst was a run of full rewrites that changed nothing.
// A rewrite is observed here as the file being replaced (a new inode: every save is write-tmp + rename), so the test
// does not depend on the log line this change adds. Pinned:
//   - [MUST-FAIL] writing the same body twice rewrites the file once, and the row keeps its first updated_at;
//   - [MUST-FAIL] a batch of identical writes rewrites nothing;
//   - [CONTROL] a changed body (or status) is written;
//   - [CONTROL] a shape read by its updated_at (timeShapedRhythm: rhythm due-state ages from it) is still refreshed;
//   - [MUST-FAIL] each rewrite logs one line naming its writer.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pool from "../../src/resolvers/pool-impulse.js";

let base = "";
let file = "";
beforeEach(() => { base = mkdtempSync(join(tmpdir(), "pool-unchanged-")); file = join(base, "pool", "standing.json"); pool.__setPoolFileForTests(file); });
afterEach(() => { pool.__setPoolFileForTests(null); rmSync(base, { recursive: true, force: true }); });

const ino = (): number => statSync(file).ino;
const row = (id: string) => (JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string; updated_at: string; body: unknown }>).find((r) => r.id === id);
const mirror = (id: string, summary = "the summary", status: "open" | "retired" = "open") => ({
  type: "poolImpulse_write", id: `gap:${id}`, shape: "substrateGap", source: "substrate-gap-mirror", status,
  body: { gap_id: id, category: "docs_drift", route: "compose", remedy: "align", summary },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("an unchanged pool write is a no-op", () => {
  it("[MUST-FAIL] the same mirror body written twice rewrites the pool file once", async () => {
    pool.resolvePoolImpulseWrite({ type: "poolImpulse_write", id: "other", shape: "fixtureRow", body: { v: 1 }, source: "test" });
    pool.resolvePoolImpulseWrite(mirror("g1"));
    const first = row("gap:g1")!;
    const before = ino();
    await sleep(5);
    const r = pool.resolvePoolImpulseWrite(mirror("g1"));
    expect(r.body.ok).toBe(true);
    expect(ino()).toBe(before);
    expect(row("gap:g1")!.updated_at).toBe(first.updated_at);
  });

  it("[MUST-FAIL] a batch of identical writes rewrites nothing", async () => {
    const many = (pool as Record<string, unknown>)["resolvePoolImpulseWriteMany"] as ((ps: unknown[]) => Array<{ body: { ok: boolean } }>) | undefined;
    expect(typeof many).toBe("function");
    many!([mirror("g1"), mirror("g2")]);
    const before = ino();
    await sleep(5);
    expect(many!([mirror("g1"), mirror("g2")]).map((r) => r.body.ok)).toEqual([true, true]);
    expect(ino()).toBe(before);
  });

  it("[CONTROL] a changed body or status is written", async () => {
    pool.resolvePoolImpulseWrite(mirror("g1"));
    let before = ino();
    await sleep(5);
    pool.resolvePoolImpulseWrite(mirror("g1", "a new summary"));
    expect(ino()).not.toBe(before);
    expect((row("gap:g1")!.body as { summary: string }).summary).toBe("a new summary");
    before = ino();
    pool.resolvePoolImpulseWrite(mirror("g1", "a new summary", "retired"));
    expect(ino()).not.toBe(before);
    expect(pool.resolvePoolImpulse({ type: "poolImpulse", id: "gap:g1", status: "retired" }).body.count).toBe(1);
  });

  it("[CONTROL] a row read by its updated_at (timeShapedRhythm) is refreshed by an identical write", async () => {
    const rhythm = { type: "poolImpulse_write", id: "rhythm:docs", shape: "timeShapedRhythm", source: "test", body: { family: "docs", alpha: 1, beta: 1, staleness: 0 } };
    pool.resolvePoolImpulseWrite(rhythm);
    const first = row("rhythm:docs")!;
    const before = ino();
    await sleep(5);
    pool.resolvePoolImpulseWrite(rhythm);
    expect(ino()).not.toBe(before);
    expect(row("rhythm:docs")!.updated_at > first.updated_at).toBe(true);
  });

  it("[MUST-FAIL] each rewrite logs one line naming its writer; a skipped write logs none", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      pool.resolvePoolImpulseWrite(mirror("g1"));
      pool.resolvePoolImpulseWrite(mirror("g1"));
    } finally { console.log = orig; }
    expect(lines.filter((l) => l.startsWith("[pool-impulse] "))).toEqual(["[pool-impulse] write: 1 impulse(s) from substrate-gap-mirror (gap:g1)"]);
  });
});
