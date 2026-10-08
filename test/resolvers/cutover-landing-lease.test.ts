// THE CUTOVER LANDS ONLY UNDER THIS NODE'S LANDING LEASE (check-first, 2026-10-08).
//
// The double landing of 2026-10-07 (node1 214f9fbd, compose2 c1a1ed7f, same gap, 75 s apart) happened at
// CUTOVER. The cutover is the harm point, so before anything is applied it re-checks the gap's landing lease
// at the gap-store holder (substrate-gap.ts LANDING LEASE), read through the store:
//   - MUST-FAIL: the lease is held by ANOTHER node -> refused landing_lease_not_held, nothing committed;
//   - MUST-FAIL: this node's lease LAPSED -> refused landing_lease_not_held (a lapsed claim is not renewed);
//   - CONTROL: this node holds an unexpired lease -> lands, and the lease is released on the outcome;
//   - CONTROL: no lease on the row -> the cutover takes it (its own admission), lands, releases it.
// Drives the REAL resolveVesselMitosisCutover through its git-aware path against a temp clone with a bare
// origin (skip_push, skip_restart), as cutover-no-measurement-refuses.test.ts does. The gap row lives in the
// shared fixture store (cutover-fetch-guard.ts), which serves the lease op with the holder's rule.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, routeFleetUnreachable, routeShell, BUN_NO_TESTS, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";

const { resolveVesselMitosisCutover, __setOwnCheckDepsForTests } = cutoverMod;
const { thisNode } = await import("../../src/resolvers/self-fact-reconcile.js");

const ENV_KEYS = ["WORKSPACE_ROOT", "MITOSIS_CUTOVER_SKIP_SYSTEMCTL", "MITOSIS_DIRECT_PUSH", "MITOSIS_RUNTIME_DIR", "MITOSIS_PUSH_CLONE_DIR", "MITOSIS_HOST_SYNC_MODE", "MITOSIS_HOST_REPO_ROOT", "PUSH_POLICY_PATH", "SUBSTRATE_REPO_OWNER", "CUTOVER_PRECHECK_SUITE", "MAINTENANCE_LEASE_PATH", "GAP_STORE_ENDPOINT"] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let guard: FetchGuard;
let fsGuard: FsGuard;
let store: Map<string, Record<string, any>>;
afterAll(() => { restoreCutoverFsModules(); restoreCutoverFetch(); });

const VESSEL = "development-vessel";
const GAP = "gap-cutover-landing-lease-target";
const TEST_FILE = "test/resolvers/target.test.ts";
const OWN_TEST = "target > does what the gap asked";
const STAGED = "// patched by substrate\n";
const MVID = "mitosis-2026-10-08T01-00-00-000Z";
const TARGET = "src/resolvers/target.ts";
const OTHER = "node-other";

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-lease-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");

  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  store = routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
  // The pre-cutover suite answers "no tests" (ran=false); the gap's own check is the measurement.
  routeShell(guard, () => BUN_NO_TESTS);
});
afterEach(async () => {
  const violations = guard.restore();
  const fsViolations = fsGuard.restore();
  __setOwnCheckDepsForTests(null);
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await rm(ws, { recursive: true, force: true });
  expect(violations).toEqual([]);
  expect(fsViolations).toEqual([]);
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

async function setup() {
  const baseRoot = join(ws, "git", "super-repo", "repos", VESSEL);
  const mitosisRoot = join(ws, "vessels", `${VESSEL}-${MVID}`);
  await mkdir(join(baseRoot, "src", "resolvers"), { recursive: true });
  await mkdir(join(mitosisRoot, "src", "resolvers"), { recursive: true });
  await writeFile(join(baseRoot, "src", "index.ts"), "// base index\n");
  const live = "// original (live)\n";
  await writeFile(join(baseRoot, TARGET), live);
  const baseSha = createHash("sha256").update(live).digest("hex").slice(0, 12);
  await writeFile(join(mitosisRoot, TARGET), STAGED);
  const hostRepoRoot = join(ws, "host-repo");
  await mkdir(join(hostRepoRoot, "src", "resolvers"), { recursive: true });
  await writeFile(join(hostRepoRoot, TARGET), "// original\n");
  git(hostRepoRoot, "init", "-q", "-b", "dev");
  git(hostRepoRoot, "config", "user.email", "test@example.com");
  git(hostRepoRoot, "config", "user.name", "Test");
  git(hostRepoRoot, "config", "commit.gpgsign", "false");
  git(hostRepoRoot, "add", ".");
  git(hostRepoRoot, "commit", "-q", "-m", "baseline");
  const originRoot = join(ws, "host-origin.git");
  git(ws, "init", "-q", "--bare", "-b", "dev", originRoot);
  git(hostRepoRoot, "remote", "add", "origin", originRoot);
  git(hostRepoRoot, "push", "-q", "-u", "origin", "dev");

  const pendingPath = join(ws, "mitosis-pending.json");
  await writeFile(pendingPath, JSON.stringify({ vessel_name: VESSEL, base_version_id: "v1", mitosis_version_id: MVID, mitosis_root: mitosisRoot, base_sha: baseSha, authored_by: "feature_compose", gap_id: GAP, proposal: GAP, staged_files: [TARGET] }, null, 2));
  const pointer = {
    type: "vessel_mitosis_cutover" as const,
    vessel_name: VESSEL, base_version_id: "v1", mitosis_version_id: MVID, mitosis_root: mitosisRoot, base_root: baseRoot,
    host_repo_root: hostRepoRoot, staged_base_sha: baseSha, staged_files: [TARGET], proposal_id: GAP, gap_id: GAP,
    pending_pointer_path: pendingPath, applied_log_path: join(ws, "mitosis-applied.jsonl"),
    evaluation_evidence: { verdict: "FAVORABLE", verdict_reason: "static_checks_pass", base_success_rate: 1, mitosis_success_rate: 1, cited_trace_ids: [], cited_check_names: ["bun run typecheck"] },
    skip_push: true, skip_restart: true,
  };
  return { hostRepoRoot, originRoot, pointer };
}

/** The gap row in the fixture store: an armed class-2 check (so the own check is the measurement) plus `lease`. */
function seedRow(lease?: Record<string, unknown>): void {
  store.set(GAP, {
    id: GAP, status: "open", category: "missing_capability", summary: "target does what the gap asked", source: "substrate_detected",
    classification_metadata: {
      falsifier: "class2", edit_site: `repos/${VESSEL}/${TARGET}`,
      evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: TEST_FILE, only_tests: [OWN_TEST] }, zero_field: "requested_not_passing" },
      ...(lease ? { landing_lease: lease } : {}),
    },
  });
}
/** The gap read stays the real resolver (forwarded to the fixture store); the own check passes. */
function ownCheckPasses(s: { hostRepoRoot: string }): void {
  __setOwnCheckDepsForTests({
    writeGap: async () => ({ shape: "substrateGapWriteResult", body: { ok: true } }),
    runSuite: async () => ({ shape: "test_suite", body: { vessel: `repos/${VESSEL}`, verified_root: s.hostRepoRoot, ran: true, total: 1, pass: 1, fail: 0, skip: 0, requested_not_passing: 0, failingTests: [] } }),
  });
}
const bodyOf = (r: { body?: unknown }) => (r.body ?? {}) as Record<string, unknown>;
const head = (s: { hostRepoRoot: string }) => git(s.hostRepoRoot, "log", "-1", "--format=%s");
const leaseOnRow = () => (store.get(GAP)?.["classification_metadata"] as Record<string, any>)?.["landing_lease"];
const future = () => new Date(Date.now() + 3600_000).toISOString();

describe("cutover: lands only under this node's landing lease", () => {
  it("[MUST-FAIL] the gap's lease is held by ANOTHER node -> refused landing_lease_not_held, nothing committed", async () => {
    const s = await setup();
    seedRow({ holder: OTHER, attempt: "theirs", acquired_at: new Date().toISOString(), until: future() });
    ownCheckPasses(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(r.shape).toBe("vesselMitosisCutoverResult");
    expect(bodyOf(r)["refuse_class"]).toBe("landing_lease_not_held");
    expect(String(bodyOf(r)["refusal_reason"])).toContain(OTHER);
    expect(head(s)).toBe("baseline");
    expect(leaseOnRow()?.holder).toBe(OTHER);
  });

  it("[MUST-FAIL] this node's lease LAPSED -> refused landing_lease_not_held (a lapsed claim is not renewed)", async () => {
    const s = await setup();
    seedRow({ holder: thisNode(), attempt: "mine", acquired_at: "2026-10-07T00:00:00Z", until: "2026-10-07T02:00:00Z" });
    ownCheckPasses(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["refuse_class"]).toBe("landing_lease_not_held");
    expect(head(s)).toBe("baseline");
  });

  it("[CONTROL] this node holds an unexpired lease -> lands, and the lease is released on the outcome", async () => {
    const s = await setup();
    seedRow({ holder: thisNode(), attempt: "mine", acquired_at: new Date().toISOString(), until: future() });
    ownCheckPasses(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(String(bodyOf(r)["refusal_reason"] ?? "")).toBe("");
    expect(r.shape).toBe("cutoverApplied");
    expect(head(s)).not.toBe("baseline");
    expect(leaseOnRow()).toBeUndefined();
  });

  it("[CONTROL] no lease on the row -> the cutover takes it as its own admission, lands, and releases it", async () => {
    const s = await setup();
    seedRow();
    ownCheckPasses(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(guard.hits.filter((h) => h === "fixture gap store").length).toBeGreaterThan(0);
    expect(leaseOnRow()).toBeUndefined();
  });
});
