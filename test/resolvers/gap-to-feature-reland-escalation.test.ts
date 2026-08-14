// Per-resolver test for abstain->escalate (§12.6 step 1, 2026-08-14): when the pending-land
// sweep meets a RE-LAND gap (>=2 non-reverted landings, none of which resolved the condition),
// the close-oracle is out of coverage, so it (a) leaves the gap OPEN and (b) escalates to the
// human via a uiQuestion_write to stateful-ui. Real git fixture + captured fetch, no network.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), `reland-esc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const GAPS_PATH = join(ROOT, "gaps", "gaps.json");
process.env.WORKSPACE_ROOT = ROOT;
process.env.VESSELS_CLONE_ROOT = CLONES;
process.env.EXPECTATION_CALIB_PATH = join(ROOT, "expectation-calibration.json");
process.env.STATEFUL_UI_VESSEL_ENDPOINT = "http://ui.test.local:8270";

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}

const uiWrites: Array<{ url: string; body: string }> = [];
const originalFetch = globalThis.fetch;

let latestSha = "";
beforeAll(() => {
  // Set env HERE (not just top-level): bun shares one process across test files and
  // vesselsCloneRoot()/WORKSPACE_ROOT are read at call time, so a sibling file's top-level
  // assignment can clobber ours. Setting in beforeAll wins right before this file's test runs.
  process.env.WORKSPACE_ROOT = ROOT;
  process.env.VESSELS_CLONE_ROOT = CLONES;
  process.env.EXPECTATION_CALIB_PATH = join(ROOT, "expectation-calibration.json");
  process.env.CLOSE_ORACLE_CALIB_PATH = join(ROOT, "close-oracle-calibration.json");
  process.env.STATEFUL_UI_VESSEL_ENDPOINT = "http://ui.test.local:8270";
  // Capture uiQuestion_write POSTs to stateful-ui; everything else returns 200 {}.
  // Capture ALL POSTs and match on body: the stateful-ui endpoint is frozen into a module-level
  // const at import time, so its value depends on import order in the suite — matching the body
  // (uiQuestion_write + gap id) instead of the URL is endpoint-independent and robust.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    uiWrites.push({ url, body });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const repo = join(CLONES, "development-vessel");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "commit", "-q", "--allow-empty", "-m", "root");
  // TWO non-reverted landings for the same gap = a RE-LAND.
  writeFileSync(join(repo, "f.txt"), "v1\n"); git(repo, "add", "f.txt");
  git(repo, "commit", "-q", "-m", "substrate-authored: apply gap-reland-sweep-0005-compose-report via mitosis cutover");
  writeFileSync(join(repo, "f.txt"), "v2\n"); git(repo, "add", "f.txt");
  git(repo, "commit", "-q", "-m", "substrate-authored: apply gap-reland-sweep-0005-compose-report via mitosis cutover");
  latestSha = git(repo, "rev-parse", "HEAD");

  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(GAPS_PATH, JSON.stringify([
    {
      id: "gap-reland-sweep-0005", category: "systematic_failure", source: "substrate_detected",
      summary: "condition persists despite repeated landings", status: "open", detected_at: now,
      classification_metadata: {
        edit_site: "repos/development-vessel/src/resolvers/fs-write.ts",
        pending_outcome_verification: latestSha, pending_set_at: now,
      },
    },
  ]));
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("sweep abstain->escalate on a re-land gap", () => {
  it("leaves the re-land gap OPEN and fires a uiQuestion_write to the human", async () => {
    const { sweepPendingLandVerifications } = await import("../../src/resolvers/gap-to-feature.js");
    const result = await sweepPendingLandVerifications();
    // escalateRelandToHuman is fire-and-forget (must not block the sweep); let it flush.
    await new Promise((r) => setTimeout(r, 150));
    expect(result.checked).toBe(1);
    expect(result.closed).toBe(0); // re-land => refuse close
    const gaps = JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, unknown>>;
    expect(gaps[0].status).toBe("open");
    // the abstain escalated to the human
    const q = uiWrites.find((w) => w.body.includes("uiQuestion_write") && w.body.includes("gap-reland-sweep-0005"));
    expect(q).toBeTruthy();
    expect(q!.body).toContain("gap_reland_needs_human");
    // the oracle GRADED itself: the re-land recorded a false-close for the landed-commit class
    const mod = await import("../../src/resolvers/gap-to-feature.js");
    const rel = mod.closeOracleReliability("landed_commit");
    expect(rel.false_closes).toBeGreaterThanOrEqual(1);
    expect(rel.reliability).toBeLessThan(1); // a false-close pulls reliability below the 1.0 prior mean
  });
});
