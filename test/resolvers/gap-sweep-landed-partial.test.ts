// CHECK-FIRST, END TO END THROUGH THE REAL PENDING-LAND SWEEP: a landing made under the lane's own semantic
// dissent closes `landed_partial`, the verified-landing credit does not move, and the sweep's own check (the
// one the gate doubted) does not settle the dissent as passed. A landing with no dissent is the control.
// Companion to feature-compose-dissent-partial.test.ts (the seams); this file runs sweepPendingLandVerifications
// on a tmp gap store, tmp clone tree and tmp calibration files. Real git, no network (fetch stubbed).
// In a multi-file run the store root is frozen by whichever file imported config.ts first (substrate-gap.ts
// gapStoreRootForTest), so rows are seeded into THAT root, which must be a temp dir, under run-unique ids.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), `sweep-landed-partial-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUN = Math.random().toString(36).slice(2, 8);
const PARTIAL = `sweep-partial-${RUN}`;
const VERIFIED = `sweep-verified-${RUN}`;
let GAPS_PATH = "";
const CALIB = join(ROOT, "expectation-calibration.json");
process.env.WORKSPACE_ROOT = ROOT;
process.env.VESSELS_CLONE_ROOT = CLONES;
process.env.EXPECTATION_CALIB_PATH = CALIB;
process.env.CLOSE_ORACLE_CALIB_PATH = join(ROOT, "close-oracle-calibration.json");

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}

const CHECK = { evidence_resolve: { shape: "health_probe", input: {}, nonzero_field: "count" } };
let partialSha = "";
let verifiedSha = "";
const originalFetch = globalThis.fetch;
beforeAll(async () => {
  // health_probe answers a measured healthy count: the check reads 'absent' (fixed) for both rows.
  globalThis.fetch = (async () => new Response(JSON.stringify({ body: { count: 1 } }), { status: 200 })) as unknown as typeof fetch;
  const repo = join(CLONES, "development-vessel");
  mkdirSync(join(repo, "test"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  // Test-only commits are "running" without a restart (landedCommitRunningHere), so the close is decided here.
  // A root commit has no diff-tree, so the landings sit on top of one.
  writeFileSync(join(repo, "README.md"), "root\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "root");
  writeFileSync(join(repo, "test", "a.test.ts"), "// a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "landed under a 2/2 semantic dissent");
  partialSha = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "test", "b.test.ts"), "// b\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "landed with the gate's agreement");
  verifiedSha = git(repo, "rev-parse", "HEAD");

  const { gapCheckIdentity } = await import("../../src/resolvers/feature-compose.js");
  const { gapStoreRootForTest } = await import("../../src/resolvers/substrate-gap.js");
  const root = gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  GAPS_PATH = join(root, "gaps", "gaps.json");
  mkdirSync(join(root, "gaps"), { recursive: true });
  const existing = existsSync(GAPS_PATH) ? (JSON.parse(readFileSync(GAPS_PATH, "utf8")) as unknown[]) : [];
  const now = new Date().toISOString();
  const base = { source: "substrate_detected", detected_at: now, created_at: now, updated_at: now, status: "open" };
  const dissent = { reason: "2/2 refuters: the key is named but nothing reads it", gate_verdict: { addresses: false, on_live_path: false }, at: now, landed_sha: partialSha, own_check: gapCheckIdentity(CHECK), child_gap_id: `${PARTIAL}-dissent-narrowed`, later_outcome: null };
  writeFileSync(GAPS_PATH, JSON.stringify([
    ...existing,
    { ...base, id: PARTIAL, category: "cat_partial", summary: "landed under dissent", classification_metadata: { ...CHECK, pending_outcome_verification: partialSha, pending_set_at: now, semantic_dissent: [dissent] } },
    { ...base, id: VERIFIED, category: "cat_verified", summary: "landed with the gate", classification_metadata: { ...CHECK, pending_outcome_verification: verifiedSha, pending_set_at: now } },
  ]));
  writeFileSync(CALIB, JSON.stringify({}));
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("the pending-land sweep: a landing under semantic dissent is partial", () => {
  it("MUST-FAIL: the dissent landing closes landed_partial, the sweep's same own check leaves its dissent unsettled, and the verified-landing credit does not count it; the no-dissent CONTROL closes landed_verified and is credited", async () => {
    const { sweepPendingLandVerifications } = await import("../../src/resolvers/gap-to-feature.js");
    await sweepPendingLandVerifications();
    const byId = new Map((JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, unknown>>).map((g) => [g.id, g]));
    const p = byId.get(PARTIAL)!;
    const v = byId.get(VERIFIED)!;
    const pm = p.classification_metadata as Record<string, unknown>;
    const vm = v.classification_metadata as Record<string, unknown>;
    const calib = JSON.parse(readFileSync(CALIB, "utf8")) as Record<string, { attempts: number; lands: number }>;
    expect({
      partial: [p.status, pm.closed_reason],
      partial_dissent_outcome: (pm.semantic_dissent as Array<Record<string, unknown>>)[0]!.later_outcome,
      verified: [v.status, vm.closed_reason],
      verified_credit: calib.cat_verified?.lands ?? 0,
      partial_credit: calib.cat_partial?.lands ?? 0,
    }).toEqual({
      partial: ["closed", "landed_partial"],
      partial_dissent_outcome: null,
      verified: ["closed", "landed_verified"],
      verified_credit: 1,
      partial_credit: 0,
    });
  });
});
