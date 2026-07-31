// Per-resolver test for the PENDING-LAND VERIFICATION SWEEP added to gap-to-feature.
// Proves the land→close continuity contract:
//   • an open gap whose pending_outcome_verification SHA IS an ancestor of a vessel
//     clone's HEAD flips to status=closed with closed_reason=landed_verified,
//   • an open gap with a pending SHA NOT present in any clone stays open (retry next tick),
//   • an open gap WITHOUT a pending SHA is untouched by the sweep.
// The gap store is pointed at a tmp WORKSPACE_ROOT and the clone tree at a tmp
// VESSELS_CLONE_ROOT (both read at call time) — real git, no network.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), `pending-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const GAPS_PATH = join(ROOT, "gaps", "gaps.json");
process.env.WORKSPACE_ROOT = ROOT;
process.env.VESSELS_CLONE_ROOT = CLONES;
process.env.EXPECTATION_CALIB_PATH = join(ROOT, "expectation-calibration.json");

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}

let landedSha = "";

// Silence the best-effort pool/event emissions from substrateGap_write.
const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  // Fixture clone with one commit = the "landed" SHA.
  const repo = join(CLONES, "development-vessel");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "f.txt"), "landed\n");
  git(repo, "add", "f.txt");
  git(repo, "commit", "-q", "-m", "landed fix");
  landedSha = git(repo, "rev-parse", "HEAD");
  // Gap store: one verified-landable pending gap, one unverifiable pending gap,
  // one ordinary open gap.
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  const now = new Date().toISOString();
  const base = { source: "substrate_detected", detected_at: now, created_at: now, updated_at: now };
  writeFileSync(GAPS_PATH, JSON.stringify([
    { ...base, id: "gap-pending-landed", category: "systematic_failure", summary: "pending gap whose land is now in the clone", status: "open", classification_metadata: { pending_outcome_verification: landedSha, pending_set_at: now } },
    { ...base, id: "gap-pending-unlanded", category: "systematic_failure", summary: "pending gap whose sha never reached a clone", status: "open", classification_metadata: { pending_outcome_verification: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", pending_set_at: now } },
    { ...base, id: "gap-ordinary-open", category: "systematic_failure", summary: "open gap without pending marker", status: "open", classification_metadata: {} },
  ]));
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("sweepPendingLandVerifications", () => {
  it("closes ancestor-verified pending gaps, leaves unverified and ordinary gaps open", async () => {
    const { sweepPendingLandVerifications } = await import("../../src/resolvers/gap-to-feature.js");
    const result = await sweepPendingLandVerifications();
    expect(result.checked).toBe(2); // only the two pending gaps
    expect(result.closed).toBe(1);
    const gaps = JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, unknown>>;
    const byId = new Map(gaps.map((g) => [g.id, g]));
    const closed = byId.get("gap-pending-landed") as Record<string, unknown>;
    expect(closed.status).toBe("closed");
    const meta = closed.classification_metadata as Record<string, unknown>;
    expect(meta.closed_reason).toBe("landed_verified");
    expect(String(meta.resolution)).toContain(landedSha);
    expect((byId.get("gap-pending-unlanded") as Record<string, unknown>).status).toBe("open");
    expect((byId.get("gap-ordinary-open") as Record<string, unknown>).status).toBe("open");
  });

  it("is idempotent: a second sweep finds nothing pending", async () => {
    const { sweepPendingLandVerifications } = await import("../../src/resolvers/gap-to-feature.js");
    const result = await sweepPendingLandVerifications();
    expect(result.closed).toBe(0);
  });
});
