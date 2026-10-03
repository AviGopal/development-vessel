// A SEMANTIC-DISSENT STAMP SURVIVES THE PENDING RECORD (check-first, qa follow-up to the dissent fix).
//
// feature_compose lands a draft over an advisory semantic-gate addresses:false (its gap's armed class-2
// check went red->green) stamped semantic_dissent, and the cutover stamps that landing landed_unverified
// until the post-land by-effect check passes. When the landing instead goes through the pending record
// (mitosis-pending.json, written by apply_proposal_as_patch / patch_with_tools from the compose report) and
// mitosis-tick re-runs the cutover, the tick's pointer forwards only four pending fields: the stamp must be
// read from the pending record, or the re-run lands own_check_verified with no trace of the dissent.
//
// Drives the REAL resolveVesselMitosisCutover through its git-aware path against a temp clone with a bare
// origin, exactly as staged-mitosis-own-check.test.ts (whose harness this copies): the gap store read and the
// test_suite run are injected through the cutover's own test seam; the network goes through the shared
// cutover fetch guard; no push, no restart.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { resolveMaintenanceLeaseWrite } from "../../src/resolvers/maintenance-lease.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, routeFleetUnreachable, routeShell, BUN_PASSING, BUN_NO_TESTS, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";

const { resolveVesselMitosisCutover } = cutoverMod;
type Deps = { readGap?: (p: Record<string, unknown>) => Promise<unknown>; writeGap?: (p: Record<string, unknown>) => Promise<unknown>; runSuite?: (p: Record<string, unknown>) => Promise<unknown> };
// Optional on purpose: on a tree without the seam the cutover runs its unpatched path, which is
// exactly the behaviour the RED tests below must expose (it lands).
const setDeps = (d: Deps | null): void => {
  (cutoverMod as unknown as { __setOwnCheckDepsForTests?: (d: Deps | null) => void }).__setOwnCheckDepsForTests?.(d);
};

const ENV_KEYS = [
  "WORKSPACE_ROOT",
  "MITOSIS_CUTOVER_SKIP_SYSTEMCTL",
  "MITOSIS_DIRECT_PUSH",
  "MITOSIS_RUNTIME_DIR",
  "MITOSIS_PUSH_CLONE_DIR",
  "MITOSIS_HOST_SYNC_MODE",
  "MITOSIS_HOST_REPO_ROOT",
  "PUSH_POLICY_PATH",
  "SUBSTRATE_REPO_OWNER",
  "CUTOVER_PRECHECK_SUITE",
  "MAINTENANCE_LEASE_PATH",
  "GAP_STORE_ENDPOINT",
] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let guard: FetchGuard;
let fsGuard: FsGuard;
// Backstop: whatever happened in this file, the next file in the same bun process gets the real
// fs and fetch (bun's mock.restore() does not undo mock.module; see cutover-fs-guard.ts).
afterAll(() => {
  restoreCutoverFsModules();
  restoreCutoverFetch();
});
/** Pre-cutover suite runs: shell calls made while the landing clone still sat at "baseline". */
let precheckRuns = 0;
let currentHost = "";
const headSubjectSync = (repo: string) => spawnSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).stdout.trim();
// Only the PRE-cutover call (landing clone still at its baseline commit) answers ran=true. Once
// the cutover's commit exists, the post-land suite gets a no-summary answer (ran=false): a
// post-land ran=true writes /workspace/post-land-baseline/<vessel>.json (an absolute path), and on
// a substrate node that would replace the real baseline with this fixture's empty failure list.
function measuredPrecheckOnly(): string {
  if (!currentHost || headSubjectSync(currentHost) !== "baseline") return BUN_NO_TESTS;
  precheckRuns++;
  return BUN_PASSING;
}

const VESSEL = "development-vessel";
const GAP = "gap-own-check-target";
const TEST_FILE = "test/resolvers/target.test.ts";
const OWN_TEST = "target > does what the gap asked";
const STAGED = "// patched by substrate\n";
const MVID = "mitosis-2026-10-02T23-30-03-248Z";

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "pending-dissent-cut-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE; // never the module-load-captured store
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
  precheckRuns = 0;
  routeShell(guard, measuredPrecheckOnly);
});

afterEach(async () => {
  const violations = guard.restore();
  const fsViolations = fsGuard.restore();
  setDeps(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(ws, { recursive: true, force: true });
  for (const r of extraRoots.splice(0)) await rm(r, { recursive: true, force: true });
  expect(violations).toEqual([]);               // last, so a violation never skips the cleanup above
  expect(fsViolations).toEqual([]);
});

async function setup(): Promise<{ baseRoot: string; mitosisRoot: string; hostRepoRoot: string; baseSha: string; pendingPath: string }> {
  const reposRoot = join(ws, "git", "super-repo", "repos");
  const baseRoot = join(reposRoot, VESSEL);
  const mitosisRoot = join(ws, "vessels", `${VESSEL}-mitosis-2026-10-02T23-30-03-248Z`);
  await mkdir(join(baseRoot, "src", "resolvers"), { recursive: true });
  await mkdir(join(mitosisRoot, "src", "resolvers"), { recursive: true });
  await writeFile(join(baseRoot, "src", "index.ts"), "// base index\n");
  const live = "// original (live)\n";
  await writeFile(join(baseRoot, "src", "resolvers", "target.ts"), live);
  const baseSha = createHash("sha256").update(live).digest("hex").slice(0, 12);
  await writeFile(join(mitosisRoot, "src", "resolvers", "target.ts"), STAGED);
  const hostRepoRoot = join(ws, "host-repo");
  currentHost = hostRepoRoot;
  await mkdir(join(hostRepoRoot, "src", "resolvers"), { recursive: true });
  await writeFile(join(hostRepoRoot, "src", "resolvers", "target.ts"), "// original\n");
  spawnSync("git", ["init", "-b", "dev"], { cwd: hostRepoRoot });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: hostRepoRoot });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: hostRepoRoot });
  spawnSync("git", ["add", "."], { cwd: hostRepoRoot });
  spawnSync("git", ["commit", "-m", "baseline"], { cwd: hostRepoRoot });
  const originRoot = join(ws, "host-origin.git");
  spawnSync("git", ["init", "--bare", "-b", "dev", originRoot]);
  spawnSync("git", ["remote", "add", "origin", originRoot], { cwd: hostRepoRoot });
  spawnSync("git", ["push", "-u", "origin", "dev"], { cwd: hostRepoRoot });
  // What patch_with_tools leaves behind: the shared queue lock naming this mitosis and its gap.
  const pendingPath = join(ws, "mitosis-pending.json");
  await writeFile(
    pendingPath,
    JSON.stringify({
      vessel_name: VESSEL,
      base_version_id: "v1",
      mitosis_version_id: MVID,
      mitosis_root: mitosisRoot,
      base_sha: baseSha,
      authored_by: "patch_with_tools",
      gap_id: GAP,
      proposal: GAP,
      staged_files: ["src/resolvers/target.ts"],
    }, null, 2),
  );
  return { baseRoot, mitosisRoot, hostRepoRoot, baseSha, pendingPath };
}

/** A second, independent fixture inside one test (fresh workspace root; the first is cleaned by afterEach too). */
async function setup2() {
  const prev = ws;
  ws = await mkdtemp(join(tmpdir(), "pending-dissent-cut2-"));
  process.env["WORKSPACE_ROOT"] = ws;
  extraRoots.push(prev);
  return setup();
}
const extraRoots: string[] = [];

/** The pointer mitosis-tick builds for the deferred cutover: a static-only FAVORABLE citing typecheck alone. */
function deferredPointer(s: { baseRoot: string; mitosisRoot: string; hostRepoRoot: string; baseSha: string; pendingPath: string }) {
  return {
    type: "vessel_mitosis_cutover" as const,
    vessel_name: VESSEL,
    base_version_id: "v1",
    mitosis_version_id: MVID,
    mitosis_root: s.mitosisRoot,
    base_root: s.baseRoot,
    host_repo_root: s.hostRepoRoot,
    staged_base_sha: s.baseSha,
    staged_files: ["src/resolvers/target.ts"],
    proposal_id: GAP,
    gap_id: GAP,
    pending_pointer_path: s.pendingPath,
    applied_log_path: join(ws, "mitosis-applied.jsonl"),
    evaluation_evidence: {
      verdict: "FAVORABLE",
      verdict_reason: "static_checks_pass",
      base_success_rate: 1,
      mitosis_success_rate: 1,
      cited_trace_ids: [],
      cited_check_names: ["bun run typecheck"],
    },
    skip_push: true,
    skip_restart: true,
  };
}

const gapRow = {
  id: GAP,
  status: "open",
  category: "missing_capability",
  summary: "target does what the gap asked",
  classification_metadata: {
    falsifier: { class: "class2" },
    edit_site: `repos/${VESSEL}/src/resolvers/target.ts`,
    evidence_resolve: {
      shape: "test_suite",
      input: { vessel: `repos/${VESSEL}`, test_file: TEST_FILE, only_tests: [OWN_TEST] },
      zero_field: "requested_not_passing",
    },
  },
};
const readGap = async (p: Record<string, unknown>) =>
  ({ shape: "substrateGap", body: { gaps: p["id"] === GAP ? [gapRow] : [] } });

function suiteBody(hostRepoRoot: string, over: Record<string, unknown>) {
  return { shape: "test_suite", body: { vessel: `repos/${VESSEL}`, verified_root: hostRepoRoot, ran: true, total: 1, pass: 1, fail: 0, skip: 0, requested_not_passing: 0, failingTests: [], ...over } };
}

async function headSubject(repo: string): Promise<string> {
  return spawnSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).stdout.trim();
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}


const DISSENT = { reason: "the judge misread the requirement as the trace STORE recording the code version", gate_verdict: { addresses: false, on_live_path: false, hard_fail: false, llm_consulted: true }, at: "2026-10-03T07:03:00.000Z", later_outcome: null };

/** The pending record a compose-report staging leaves, with (or without) the dissent stamp, scoped to `mvid`. */
async function writePending(path: string, mitosisRoot: string, baseSha: string, extra: Record<string, unknown>, mvid = MVID): Promise<void> {
  await writeFile(path, JSON.stringify({ vessel_name: VESSEL, base_version_id: "v1", mitosis_version_id: mvid, mitosis_root: mitosisRoot, base_sha: baseSha, authored_by: "apply_proposal_as_patch:multifile", gap_id: GAP, proposal_id: `${GAP}-compose-report`, staged_files: ["src/resolvers/target.ts"], ...extra }, null, 2));
}

describe("a semantic-dissent stamp on the pending record reaches the tick's re-run cutover", () => {
  it("MUST-FAIL: a dissent-carrying pending record re-run by the tick's cutover (pointer without the stamp) lands landed_unverified with the stamp", async () => {
    const s = await setup();
    await writePending(s.pendingPath, s.mitosisRoot, s.baseSha, { semantic_dissent: DISSENT });
    setDeps({ readGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    const pointer = deferredPointer(s) as Record<string, unknown>;
    expect("semantic_dissent" in pointer).toBe(false); // the tick forwards no stamp: only the pending record has it
    const r = await resolveVesselMitosisCutover(pointer as never);
    expect(r.shape).toBe("cutoverApplied");
    const body = r.body as Record<string, unknown>;
    expect(body["landed_unverified"]).toBe(true);
    expect(String(body["landed_unverified_reason"])).toMatch(/^semantic_dissent: /);
    expect(String(body["landed_unverified_reason"])).toContain(DISSENT.reason.slice(0, 60));
    expect(body["own_check_verified"]).toBeUndefined();
    const line = JSON.parse((await readFile(join(ws, "mitosis-applied.jsonl"), "utf8")).trim().split("\n").pop()!);
    expect(String(line.body.landed_unverified_reason)).toMatch(/^semantic_dissent: /);
  });

  it("CONTROL: the same re-run without a stamp lands own_check_verified, not landed_unverified", async () => {
    const s = await setup();
    await writePending(s.pendingPath, s.mitosisRoot, s.baseSha, {});
    setDeps({ readGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    expect(r.shape).toBe("cutoverApplied");
    expect((r.body as Record<string, unknown>)["landed_unverified"]).toBeUndefined();
    expect((r.body as Record<string, unknown>)["own_check_verified"]).toBe(true);
  });

  it("CONTROL: a stamp on a pending record for a DIFFERENT mitosis is not read (the record is scoped by mitosis_version_id)", async () => {
    const s = await setup();
    await writePending(s.pendingPath, s.mitosisRoot, s.baseSha, { semantic_dissent: DISSENT }, "mitosis-some-other-staging");
    setDeps({ readGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    expect(r.shape).toBe("cutoverApplied");
    expect((r.body as Record<string, unknown>)["landed_unverified"]).toBeUndefined();
  });
});
