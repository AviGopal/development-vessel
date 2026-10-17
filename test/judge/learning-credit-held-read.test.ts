// I4 READ SIDE: THE GAP-CLASS POSTERIOR, THE CLOSE-ORACLE CALIBRATION AND THE DETECTOR CLOSURE CREDIT ARE READ FROM THE
// GAP-STORE HOLDER, as expectation calibration already is. They were node-local files: a compose node's rerank learned
// only from its own composes, and the detector credit had no reader at all. The holder serves them on
// substrateGap{include_calibration:true} (learning_credit); refreshHeldCalibration caches them; each reader prefers the
// held copy and falls back to its local file, logged. (The write side is I4 step 1′, write-through; both land together.)
//
// The holder is stood in for by GAP_STORE_ENDPOINT + a fetch stub; the local files are temp fixtures that DIFFER from the
// holder's tables, so a read that ignores the holder is visible.
import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";

const ROOT = mkdtempSync(join(tmpdir(), "learning-credit-held-"));
const KEYS = ["GAP_STORE_ENDPOINT", "GAP_CLASS_POSTERIOR_PATH", "CLOSE_ORACLE_CALIB_PATH", "DETECTOR_CLOSURE_LEDGER_PATH", "WORKSPACE_ROOT"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT); // learned state (posteriors, calibration, credit) under the temp root too, never /workspace
process.env["GAP_CLASS_POSTERIOR_PATH"] = join(ROOT, "class.json");
process.env["CLOSE_ORACLE_CALIB_PATH"] = join(ROOT, "oracle.json");
process.env["DETECTOR_CLOSURE_LEDGER_PATH"] = join(ROOT, "detector.json");
writeFileSync(join(ROOT, "class.json"), JSON.stringify({ X: { alpha: 1, beta: 9 } }));
writeFileSync(join(ROOT, "oracle.json"), JSON.stringify({ measured: { closes: 1, false_closes: 1 } }));
writeFileSync(join(ROOT, "detector.json"), JSON.stringify({ D: { closures: 1, last_closed_at: "2026-10-01T00:00:00Z" } }));

const credit = await import("../../src/judge/gap-attempt-credit.js");
const verdict = await import("../../src/judge/gap-landing-verdict.js");
const HOLDER = "http://holder.test/v2/impulses/resolve";
const HELD = {
  class_posteriors: { X: { alpha: 9, beta: 1 } },
  close_oracle: { measured: { closes: 20, false_closes: 0 } },
  detector_credit: { D: { closures: 7, last_closed_at: "2026-10-16T00:00:00Z" } },
};
const originalFetch = globalThis.fetch;
let holderUp = true;
let served: unknown = HELD;
const warn = spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  holderUp = true; served = HELD;
  process.env["GAP_STORE_ENDPOINT"] = HOLDER;
  globalThis.fetch = (async (u: unknown) => {
    if (String(u) !== HOLDER) throw new TypeError(`unexpected network call in test: ${String(u)}`);
    if (!holderUp) throw new TypeError("Unable to connect");
    return Response.json({ shape: "substrateGap", body: { gaps: [], total: 0, expectation_calibration: {}, learning_credit: served } });
  }) as unknown as typeof fetch;
  credit.__resetHeldLearningCreditForTests();
  warn.mockClear();
});
afterAll(() => {
  globalThis.fetch = originalFetch; warn.mockRestore();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});

describe("the learning credit tables are read from the holder", () => {
  it("[MUST-FAIL] a node with a different local posterior reads the holder's class posterior after a refresh", async () => {
    await credit.refreshHeldCalibration();
    expect(credit.readClassPosteriors()["X"]).toEqual({ alpha: 9, beta: 1 });
  });

  it("[MUST-FAIL] the close-oracle reliability comes from the holder's calibration", async () => {
    await credit.refreshHeldCalibration();
    const r = verdict.closeOracleReliability("measured");
    expect(r.closes).toBe(20);
    expect(r.false_closes).toBe(0);
  });

  it("[MUST-FAIL] detector closure credit has a reader, and it reads the holder's ledger", async () => {
    expect(typeof verdict["readDetectorClosureCredit"]).toBe("function");
    await credit.refreshHeldCalibration();
    expect(verdict.readDetectorClosureCredit()["D"]?.closures).toBe(7);
  });

  it("[CONTROL] the holder unreachable: each reader uses its local file, logged, never a silent empty table", async () => {
    holderUp = false;
    await credit.refreshHeldCalibration();
    expect(credit.readClassPosteriors()["X"]).toEqual({ alpha: 1, beta: 9 });
    expect(verdict.closeOracleReliability("measured").closes).toBe(1);
    expect(verdict.readDetectorClosureCredit()["D"]?.closures).toBe(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("[learning-credit] no held class_posteriors"))).toBe(true);
  });

  it("[CONTROL] a holder that serves no learning_credit (an older holder): local files, logged", async () => {
    served = undefined;
    await credit.refreshHeldCalibration();
    expect(credit.readClassPosteriors()["X"]).toEqual({ alpha: 1, beta: 9 });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("returned no learning_credit"))).toBe(true);
  });

  it("[HELD-OUT] a class the holder lacks is Beta(1,1) at the sampler, not a local seed", async () => {
    await credit.refreshHeldCalibration();
    expect(credit.readClassPosteriors()["Y"]).toBeUndefined();
    const t = credit.sampleClassTheta("Y");
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1);
  });

  it("[MUST-FAIL] the refresh replays I4a's journal first (a credit an outage left pending is re-sent)", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "..", "..", "src", "judge", "gap-attempt-credit.ts"), "utf8") as string;
    const fn = src.slice(src.indexOf("export async function refreshHeldCalibration"), src.indexOf("export async function refreshHeldCalibration") + 900);
    expect(fn).toContain("await replayLearningJournal();");
  });

  it("[HELD-OUT] a node with NO GAP_STORE_ENDPOINT is its own holder: it reads its local table, forwards nothing, and says it is a separate authority", async () => {
    delete process.env["GAP_STORE_ENDPOINT"];
    const calls: string[] = [];
    globalThis.fetch = (async (u: unknown) => { calls.push(String(u)); throw new TypeError("no network in this case"); }) as unknown as typeof fetch;
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(((m: unknown) => { logs.push(String(m)); }) as never);
    try {
      await credit.refreshHeldCalibration();
      expect(calls.filter((u) => u.startsWith("http://holder.test"))).toEqual([]);
      expect(credit.readClassPosteriors()["X"]).toEqual({ alpha: 1, beta: 9 });
      expect(logs.some((l) => l.includes("separate authority"))).toBe(true);
    } finally { logSpy.mockRestore(); }
  });

  it("[PARAPHRASE] the same class reached by a reworded id stem reads the same held posterior", async () => {
    await credit.refreshHeldCalibration();
    served = { ...HELD, class_posteriors: { [credit.gapClassOf({ id: "lane-repicks-fixed-gaps-1a2b3c4d", source: "" })]: { alpha: 5, beta: 2 } } };
    await credit.refreshHeldCalibration();
    const a = credit.gapClassOf({ id: "lane-repicks-fixed-gaps-1a2b3c4d", source: "" });
    const b = credit.gapClassOf({ id: "lane-repicks-fixed-gaps-99887766", source: "" });
    expect(a).toBe(b);
    expect(credit.readClassPosteriors()[b]).toEqual({ alpha: 5, beta: 2 });
  });
});

describe("the held read is PURE, and the holder reads its own files (I4 repair, 2026-10-17)", () => {
  it("[MUST-FAIL] on the holder a refresh and every reader write nothing and read the local files, with no fallback warning", async () => {
    delete process.env["GAP_STORE_ENDPOINT"];
    const { existsSync } = await import("node:fs");
    const journal = join(ROOT, "learning-credit-journal.json");
    await credit.refreshHeldCalibration();
    expect(credit.readClassPosteriors()["X"]).toEqual({ alpha: 1, beta: 9 });
    expect(verdict.readDetectorClosureCredit()["D"]?.closures).toBe(1);
    expect(existsSync(journal)).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("[learning-credit] no held"))).toBe(false);
  });
  it("[MUST-FAIL] on a non-holder with nothing pending, a refresh writes no journal", async () => {
    const { existsSync } = await import("node:fs");
    await credit.refreshHeldCalibration();
    expect(existsSync(join(ROOT, "learning-credit-journal.json"))).toBe(false);
  });
});

describe("held OR local, never summed, and the source is visible (qa conditions 2 and 3)", () => {
  it("[MUST-FAIL] NO SUMMING: a key both the held table and the local fallback hold is read ONCE, from the held table", async () => {
    // local class.json carries X (1,9); the holder serves X (9,1): a summing reader would give (10,10) or (9+1, 1+9)
    await credit.refreshHeldCalibration();
    expect(credit.readClassPosteriors()["X"]).toEqual({ alpha: 9, beta: 1 });
    expect(verdict.closeOracleReliability("measured").closes).toBe(20);
    expect(verdict.readDetectorClosureCredit()["D"]?.closures).toBe(7);
  });
  it("[MUST-FAIL] SOURCE VISIBLE: a read from the held table says 'held'; with the holder down it says 'local_fallback'", async () => {
    await credit.refreshHeldCalibration();
    credit.readClassPosteriors();
    expect(credit.learningTableSource("class_posteriors")).toBe("held");
    holderUp = false;
    await credit.refreshHeldCalibration();
    credit.readClassPosteriors();
    expect(credit.learningTableSource("class_posteriors")).toBe("local_fallback");
  });
  it("[CONTROL] on the holder the source is its own file ('holder_local')", async () => {
    delete process.env["GAP_STORE_ENDPOINT"];
    await credit.refreshHeldCalibration();
    credit.readClassPosteriors();
    expect(credit.learningTableSource("class_posteriors")).toBe("holder_local");
  });
  it("[WIRING] the durable pick-decision record carries the posterior's source; a close-oracle trust read on the fallback is logged", () => {
    const f = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "gap-to-feature.ts"), "utf8");
    expect(f).toContain('posterior_source: learningTableSource("class_posteriors"),');
    const v = readFileSync(join(import.meta.dir, "..", "..", "src", "judge", "gap-landing-verdict.ts"), "utf8");
    expect(v).toContain('if (learningTableSource("close_oracle") === "local_fallback") console.warn(');
  });
});
