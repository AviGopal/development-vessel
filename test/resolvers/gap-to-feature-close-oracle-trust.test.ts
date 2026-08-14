// The close-oracle EARNED-TRUST gate (§12.6 step 1, 2026-08-14) — the fail-open direction.
//
// Closing a gap on an UNMEASURED verdict ('unknown') is permitted ONLY when the evidence class has
// EARNED that trust: >= MIN_SAMPLES graded closes AND reliability >= FLOOR. The load-bearing
// property the whole program forbids violating: a FRESH class at Beta(1,1) (zero evidence) must NOT
// earn fail-open — "trust assumed" is exactly the failure mode. And the live landed_commit class
// ({closes:0, false_closes:8}) must NOT earn trust: provenance-only closes never hold, so it stays
// abstaining forever, which is correct.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CALIB = join(tmpdir(), `close-oracle-trust-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
process.env.CLOSE_ORACLE_CALIB_PATH = CALIB;

async function trust(cls: string): Promise<boolean> {
  const { closeOracleEarnedTrust } = await import("../../src/resolvers/gap-to-feature.js");
  return closeOracleEarnedTrust(cls);
}

afterAll(() => { try { rmSync(CALIB, { force: true }); } catch { /* noop */ } });

describe("closeOracleEarnedTrust — trust is earned, never assumed", () => {
  it("a FRESH class (Beta(1,1), no calib entry) does NOT earn fail-open trust", async () => {
    writeFileSync(CALIB, JSON.stringify({}));
    expect(await trust("brand_new_class")).toBe(false);
  });

  it("the live landed_commit class {closes:0, false_closes:8} does NOT earn trust (never holds)", async () => {
    writeFileSync(CALIB, JSON.stringify({ landed_commit: { closes: 0, false_closes: 8 } }));
    expect(await trust("landed_commit")).toBe(false);
  });

  it("a class with many closes but a POOR hold-rate does NOT earn trust", async () => {
    // 20 closes, 12 later re-landed => reliability = (8+1)/(8+1 + 12+1) = 9/22 ≈ 0.41 < 0.7
    writeFileSync(CALIB, JSON.stringify({ shaky: { closes: 20, false_closes: 12 } }));
    expect(await trust("shaky")).toBe(false);
  });

  it("a class with < MIN_SAMPLES closes does NOT earn trust even at 100% hold", async () => {
    // 5 closes, 0 false => reliability high but only 5 samples < 10
    writeFileSync(CALIB, JSON.stringify({ young: { closes: 5, false_closes: 0 } }));
    expect(await trust("young")).toBe(false);
  });

  it("a class with >= MIN_SAMPLES closes AND a strong hold-rate DOES earn trust", async () => {
    // 15 closes, 1 false => reliability = (14+1)/(14+1 + 1+1) = 15/17 ≈ 0.88 >= 0.7, samples 16 >= 10
    writeFileSync(CALIB, JSON.stringify({ measured: { closes: 15, false_closes: 1 } }));
    expect(await trust("measured")).toBe(true);
  });
});
