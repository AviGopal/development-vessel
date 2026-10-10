// HELD GAPS DO NOT TAKE PENDING-SWEEP SLOTS. The pending-land sweep verifies at most PENDING_VERIFY_SWEEP_LIMIT
// stamped gaps per tick. It sliced FIRST and skipped operator_hold gaps AFTER, so held gaps (which it never closes
// over) spent the slots: 158 of 350 checks in a day went to held gaps skipped on arrival (diag-s1, 2026-10-10).
//
// MUST-FAIL: 30 stamped gaps, 20 of them held and least recently checked (so they sort first). The sweep checks
// the 10 unheld gaps and no held gap consumes a slot; the tally line counts the 20 held. At the parent it checked
// 25 (the 20 held + 5 unheld). Runs the REAL sweep in a fresh process on a temp store (WORKSPACE_ROOT) and an
// empty temp clone root, so every unheld gap stops at not_in_clone: no check runs, no network (fetch stubbed).
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), `pending-sweep-held-slots-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const BIN = join(ROOT, "bin");
const GTF = new URL("../../src/resolvers/gap-to-feature.ts", import.meta.url).pathname;
const HELD = 20;
const UNHELD = 10;

beforeAll(() => {
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  mkdirSync(CLONES, { recursive: true });
  mkdirSync(BIN, { recursive: true });
  symlinkSync(Bun.which("git")!, join(BIN, "git"));
  symlinkSync(process.execPath, join(BIN, "bun"));
  const now = new Date().toISOString();
  const rows = [];
  for (let i = 0; i < HELD + UNHELD; i++) {
    const held = i < HELD;
    rows.push({
      id: `hs-${held ? "held" : "free"}-${i}`, category: "cat_hs", source: "substrate_detected", summary: `held-slots ${i}`,
      detected_at: now, created_at: now, updated_at: now, status: "open",
      classification_metadata: {
        evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: `test/hs${i}.test.ts`, only_tests: ["t"] }, zero_field: "requested_not_passing" },
        pending_outcome_verification: (`${i.toString(16).padStart(2, "0")}c0ffee`.repeat(5)).slice(0, 40),
        pending_set_at: now,
        // Held gaps were checked longest ago, so the least-recently-checked order puts every one of them first.
        pending_last_checked_at: held ? `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` : `2026-06-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        ...(held ? { operator_hold: true, operator_hold_reason: "test hold" } : {}),
      },
    });
  }
  writeFileSync(join(ROOT, "gaps", "gaps.json"), JSON.stringify(rows));
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

function sweepInIsolation(): { exit: number; out: string } {
  const code = [
    `globalThis.fetch = (async () => new Response("{}", { status: 404 }));`,
    `const { sweepPendingLandVerifications } = await import(${JSON.stringify(GTF)});`,
    `const r = await sweepPendingLandVerifications();`,
    `console.log("SWEEP_RESULT " + JSON.stringify(r));`,
  ].join("\n");
  const env: Record<string, string> = {
    HOME: ROOT, PATH: BIN, WORKSPACE_ROOT: ROOT, VESSELS_CLONE_ROOT: CLONES,
    EXPECTATION_CALIB_PATH: join(ROOT, "expectation-calibration.json"),
    CLOSE_ORACLE_CALIB_PATH: join(ROOT, "close-oracle-calibration.json"),
    SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER: "1", NODE_ENV: "test", TZ: "UTC",
  };
  const p = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { exit: p.exitCode ?? -1, out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) };
}

describe("pending-land sweep: held gaps do not take verification slots", () => {
  it("MUST-FAIL: 30 stamped gaps, 20 held and sorted first -> the sweep checks the 10 unheld, no held gap consumes a slot, the tally counts 20 held", () => {
    const run = sweepInIsolation();
    const result = /SWEEP_RESULT (\{.*\})/.exec(run.out)?.[1];
    expect({ exit: run.exit, ran: !!result }, run.out.slice(-2000)).toEqual({ exit: 0, ran: true });
    const tallyLine = /\[gap-sweep\] checked=(\d+) closed=(\d+) (\{.*\})/.exec(run.out);
    expect(tallyLine, run.out.slice(-2000)).not.toBeNull();
    const tally = JSON.parse(tallyLine![3]!) as Record<string, number>;
    expect({ result: JSON.parse(result!), checked: Number(tallyLine![1]), not_in_clone: tally.not_in_clone, held: tally.held }, run.out.slice(-2000))
      .toEqual({ result: { checked: UNHELD, closed: 0 }, checked: UNHELD, not_in_clone: UNHELD, held: HELD });
    // No held gap was taken into the loop at all.
    expect(run.out.includes("held by operator_hold")).toBe(false);
  });
});
