// THE PRE-CUTOVER TEST GATE FAILS CLOSED FOR UNDIRECTED (SYSTEM-AUTHORED) LANDINGS (2026-10-25).
//
// Gap: the 5d PRE-CUTOVER TEST GATE in vessel-mitosis-cutover.ts was FAIL-OPEN by design: "suite did
// not run … proceeds". Tonight a gamed Object.keys shim landed through exactly this path on a
// landing whose own check also read green (8e54fb68) — an own-check pass is itself gameable, so it
// is not a defense on its own. qa ruling (confirmed by the coordinator): for a landing that is NOT
// directed (no stamped, verified feature_compose attemptIntent — directedLandingOrigin, the same
// signal the AUTONOMY-SCOPE CHOKEPOINT already uses; author identity cannot separate operator from
// autonomous), a pre-cutover suite that did not run OR that ran and measured zero tests is treated
// the same as own_check_unmeasurable: refused, no preserve_pending (the tree is not retried — the
// gap stays open and is recomposed), with the same consecutive-unmeasurable escalation counter
// (OWN_CHECK_UNMEASURABLE_ESCALATE_AT) on the landing gap's row. An operator-DIRECTED landing is
// unaffected (see cutover-no-measurement-refuses.test.ts's "CONTROL (directed)" for that contract).
//
// "Did not run" (bun prints no summary at all — no shell producer, a non-test file, a timeout) is
// BUN_NO_TESTS in cutover-fetch-guard.ts; "ran but measured 0 tests" (bun finds a test FILE but no
// test NAME matches — exactly what a gamed filter/shim produces) is a different, real bun summary,
// defined locally below (ran:true, pass:0, fail:0), never widening the shared fixture file for one
// row's test.
//
// SEAMS: the real resolveVesselMitosisCutover through its git-aware path against a temp clone with
// a bare origin (skip_push, skip_restart), same pattern as cutover-no-measurement-refuses.test.ts.
// Own check and gap store go through __setOwnCheckDepsForTests / the fixture gap store; the network
// behind the shared cutover fetch guard.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCutoverFetchGuard, routeFleetUnreachable, routeShell,
  BUN_NO_TESTS, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch,
} from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";

const { resolveVesselMitosisCutover, __setOwnCheckDepsForTests } = cutoverMod;

// A real bun summary for "found the test file, matched zero test names" — NOT "no tests found!"
// (that is BUN_NO_TESTS: ran=false). This is ran=true, pass=0, fail=0, which test-suite.ts's
// `/\d+\s+(pass|fail)\b/` regex reads as ran=true: a gamed filter/shim reads exactly this way.
const BUN_ZERO_TESTS_MATCHED =
  "bun test v1.3.14 (0d9b296a)\n\ntest/resolvers/target.test.ts:\n\n 0 pass\n 0 fail\n 0 expect() calls\nRan 0 tests across 1 file. [2.00ms]\n";

const ENV_KEYS = [
  "WORKSPACE_ROOT", "MITOSIS_CUTOVER_SKIP_SYSTEMCTL", "MITOSIS_DIRECT_PUSH", "MITOSIS_RUNTIME_DIR", "MITOSIS_PUSH_CLONE_DIR",
  "MITOSIS_HOST_SYNC_MODE", "MITOSIS_HOST_REPO_ROOT", "PUSH_POLICY_PATH", "SUBSTRATE_REPO_OWNER", "CUTOVER_PRECHECK_SUITE",
  "MAINTENANCE_LEASE_PATH", "GAP_STORE_ENDPOINT",
] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let guard: FetchGuard;
let fsGuard: FsGuard;
afterAll(() => {
  restoreCutoverFsModules();
  restoreCutoverFetch();
});

const VESSEL = "development-vessel";
const GAP = "gap-precutover-undirected-target";
const STAGED = "// patched by substrate\n";
const MVID = "mitosis-2026-10-25T00-00-00-000Z";
const TARGET = "src/resolvers/target.ts";

type SuiteMode = "no_tests" | "zero_tests_matched";
let currentHost = "";
function suite(mode: SuiteMode): void {
  routeShell(guard, () => {
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return BUN_NO_TESTS; // post-land call
    return mode === "no_tests" ? BUN_NO_TESTS : BUN_ZERO_TESTS_MATCHED;
  });
}

const writes: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-precutover-undirected-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  writes.length = 0;
  currentHost = "";
  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
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
  const reposRoot = join(ws, "git", "super-repo", "repos");
  const baseRoot = join(reposRoot, VESSEL);
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
  const originSha = git(originRoot, "rev-parse", "dev");
  currentHost = hostRepoRoot;
  const pendingPath = join(ws, "mitosis-pending.json");
  await writeFile(
    pendingPath,
    JSON.stringify({ vessel_name: VESSEL, base_version_id: "v1", mitosis_version_id: MVID, mitosis_root: mitosisRoot, base_sha: baseSha, authored_by: "patch_with_tools", gap_id: GAP, proposal: GAP, staged_files: [TARGET] }, null, 2),
  );
  const pointer = {
    type: "vessel_mitosis_cutover" as const,
    vessel_name: VESSEL,
    base_version_id: "v1",
    mitosis_version_id: MVID,
    mitosis_root: mitosisRoot,
    base_root: baseRoot,
    host_repo_root: hostRepoRoot,
    staged_base_sha: baseSha,
    staged_files: [TARGET],
    proposal_id: GAP,
    gap_id: GAP,
    pending_pointer_path: pendingPath,
    applied_log_path: join(ws, "mitosis-applied.jsonl"),
    evaluation_evidence: { verdict: "FAVORABLE", verdict_reason: "static_checks_pass", base_success_rate: 1, mitosis_success_rate: 1, cited_trace_ids: [], cited_check_names: ["bun run typecheck"] },
    skip_push: true,
    skip_restart: true,
    // deliberately NO attempt_id: directedLandingOrigin reads "no attempt id" → undirected.
  };
  return { mitosisRoot, hostRepoRoot, originRoot, originSha, baseSha, pointer };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

const bodyOf = (r: { body?: unknown }) => (r.body ?? {}) as Record<string, unknown>;
const headSubject = (s: Fixture) => git(s.hostRepoRoot, "log", "-1", "--format=%s");
/** A gap row with NO own check (falsifier: none) — the own-check step abstains, so this must-fail
 *  isolates the precutover suite's own fail-closed behaviour, not a different gate's. */
/** A gap row with NO own check (falsifier: none), kept live (not a frozen snapshot) and merged on
 *  every write — same merge contract the real gap store keeps — so a repeated unmeasurable run
 *  actually accumulates own_check_unmeasurable_count across calls in this fixture, as it does live. */
let liveRow: Record<string, unknown> = { id: GAP, status: "open", category: "missing_capability", summary: "target gap", source: "substrate_detected", classification_metadata: { falsifier: "none" } };
const readLiveRow = async (p: Record<string, unknown>) => ({ shape: "substrateGap", body: { gaps: p["id"] === GAP ? [liveRow] : [] } });
const writeLiveRow = async (p: Record<string, unknown>) => {
  writes.push(JSON.parse(JSON.stringify(p)));
  const gap = (p["gap"] ?? {}) as Record<string, unknown>;
  const meta = { ...((liveRow["classification_metadata"] ?? {}) as Record<string, unknown>), ...((gap["classification_metadata"] ?? {}) as Record<string, unknown>) };
  liveRow = { ...liveRow, ...gap, classification_metadata: meta };
  return { shape: "substrateGapWriteResult", body: { ok: true } };
};
function noOwnCheck(): void {
  liveRow = { id: GAP, status: "open", category: "missing_capability", summary: "target gap", source: "substrate_detected", classification_metadata: { falsifier: "none" } };
  __setOwnCheckDepsForTests({ readGap: readLiveRow, writeGap: writeLiveRow, runSuite: async () => ({ shape: "test_suite", body: { ran: false } }) });
}

describe("cutover: the precutover gate fails closed for undirected landings on not-run or zero-tests", () => {
  it("MUST-FAIL: a pre-cutover suite that DID NOT RUN (ran=false) on an undirected landing does not cut over", async () => {
    const s = await setup();
    suite("no_tests");
    noOwnCheck();
    const before = git(s.originRoot, "rev-parse", "dev");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["refuse_class"]).toBe("pre_cutover_suite_not_run");
    expect(bodyOf(r)["deferred"]).toBeUndefined();
    expect(bodyOf(r)["preserve_pending"]).toBeUndefined();
    expect(headSubject(s)).toBe("baseline");
    expect(git(s.originRoot, "rev-parse", "dev")).toBe(before);
  });

  it("MUST-FAIL: a pre-cutover suite that RAN but measured ZERO TESTS (ran=true, pass=0, fail=0) on an undirected landing does not cut over", async () => {
    const s = await setup();
    suite("zero_tests_matched");
    noOwnCheck();
    const before = git(s.originRoot, "rev-parse", "dev");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["refuse_class"]).toBe("pre_cutover_suite_zero_tests");
    expect(bodyOf(r)["deferred"]).toBeUndefined();
    expect(bodyOf(r)["preserve_pending"]).toBeUndefined();
    expect(headSubject(s)).toBe("baseline");
    expect(git(s.originRoot, "rev-parse", "dev")).toBe(before);
  });

  it("MUST-FAIL: the consecutive-unmeasurable counter (own_check_unmeasurable shape) increments across repeated zero-tests attempts on the landing gap's row", async () => {
    const s = await setup();
    suite("zero_tests_matched");
    noOwnCheck();
    const r1 = await resolveVesselMitosisCutover(s.pointer as never);
    const r2 = await resolveVesselMitosisCutover(s.pointer as never);
    expect(Number(bodyOf(r1)["own_check_unmeasurable_count"])).toBe(1);
    expect(Number(bodyOf(r2)["own_check_unmeasurable_count"])).toBe(2);
  });

  it("CONTROL: an undirected landing whose pre-cutover suite RAN with a real pass still lands (unaffected)", async () => {
    const s = await setup();
    routeShell(guard, () => {
      if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return BUN_NO_TESTS;
      return "bun test v1.3.14 (0d9b296a)\n\ntest/resolvers/ok.test.ts:\n(pass) ok [0.06ms]\n\n 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file. [11.00ms]\n";
    });
    noOwnCheck();
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(String(bodyOf(r)["refusal_reason"] ?? "")).toBe("");
    expect(r.shape).toBe("cutoverApplied");
    expect(headSubject(s)).not.toBe("baseline");
  });
});
