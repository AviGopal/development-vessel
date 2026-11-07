// A PRE-CUTOVER SUITE THAT TIMED OUT UNDER CONTENTION DEFERS THE CUTOVER UNDER VARIANT-1 (precutover-suite-timeout-defer.ts,
// wired at the pre-cutover gate in vessel-mitosis-cutover.ts).
// The gate refused an undirected landing as pre_cutover_suite_not_run whenever its whole suite printed no summary, a
// suite killed at its budget on a contended host included; the compose then read UNFAVORABLE for a draft nothing had
// judged. Under variant-1 that case returns the cutover's existing deferral (deferred + preserve_pending): the pending
// lock is kept, the clone is put back, nothing lands.
//   (a) MUST-FAIL: variant-1, a timed-out suite on a contended host: refuse_class pre_cutover_suite_timeout_deferred,
//       deferred and preserve_pending set, the pending lock kept, the clone clean, nothing committed or pushed.
//   CONTROL (variant-0, the same timed-out suite): refused pre_cutover_suite_not_run exactly as before, no deferral,
//       the pending lock cleared.
//   CONTROL (variant-1, uncontended): refused pre_cutover_suite_not_run as before.
// SEAMS: the harness of cutover-precutover-gate-undirected.test.ts (temp clone with a bare origin, skip_push,
// skip_restart, the fixture gap store, the shared fetch, fs and exec guards); the decision's mask, rows, PSI, trace
// sink and state file through __setPrecutoverSuiteTimeoutDeferDepsForTests.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCutoverFetchGuard, routeFleetUnreachable, routeShell,
  BUN_NO_TESTS, BUN_KILLED_BY_TIMEOUT, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch,
} from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { existsSync } from "node:fs";
import * as defer from "../../src/resolvers/precutover-suite-timeout-defer.js";
import { TIMED_OUT_MARKER } from "../../src/resolvers/test-suite.js";

const { resolveVesselMitosisCutover, __setOwnCheckDepsForTests } = cutoverMod;

// What test_suite's bun run prints when `timeout` kills it at the default budget (870 s): no summary, then the marker.
const BUN_TIMED_OUT = `${BUN_KILLED_BY_TIMEOUT}${TIMED_OUT_MARKER} rc=124 elapsed=870\n`;
const PSI_HOT = "some avg10=50.00 avg60=44.00 avg300=31.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
const PSI_IDLE = "some avg10=1.00 avg60=2.00 avg300=3.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
let maskVariant: number | null = null;
let psi = PSI_HOT;
const deferTraces: Array<Record<string, unknown>> = [];

const ENV_KEYS = [
  "WORKSPACE_ROOT", "MITOSIS_CUTOVER_SKIP_SYSTEMCTL", "MITOSIS_DIRECT_PUSH", "MITOSIS_RUNTIME_DIR", "MITOSIS_PUSH_CLONE_DIR",
  "MITOSIS_HOST_SYNC_MODE", "MITOSIS_HOST_REPO_ROOT", "PUSH_POLICY_PATH", "SUBSTRATE_REPO_OWNER", "CUTOVER_PRECHECK_SUITE",
  "MAINTENANCE_LEASE_PATH", "GAP_STORE_ENDPOINT",
] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let guard: FetchGuard;
let fsGuard: FsGuard;
// SYSTEMD THROUGH A STUB, never the real tool (the test preload blocks systemctl in the live
// container). registerAttempt's own invariant snapshot (attempt-checks.ts "systemd_units") spawns
// `systemctl show <clone>/host-repo.service -p LoadState --value` on any FRESH attempt-ledger
// registration after a successful landing — same seam cutover-landing-lease.test.ts stubs.
let execGuard: ExecGuard;
afterAll(() => {
  restoreCutoverFsModules();
  restoreCutoverFetch();
  restoreCutoverExecModules();
});

const VESSEL = "development-vessel";
const GAP = "gap-precutover-timeout-target";
const STAGED = "// patched by substrate\n";
const MVID = "mitosis-2000-01-01T00-00-00-000Z";
const TARGET = "src/resolvers/target.ts";

let currentHost = "";
function suiteTimesOut(): void {
  routeShell(guard, () => {
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return BUN_NO_TESTS; // post-land call
    return BUN_TIMED_OUT;
  });
}

const writes: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-precutover-timeout-defer-"));
  maskVariant = null; psi = PSI_HOT; deferTraces.length = 0;
  defer.__setPrecutoverSuiteTimeoutDeferDepsForTests({
    readMasks: () => (maskVariant === null ? [] : [{ id: "mask-pstd", body: { activity_id: defer.PRECUTOVER_SUITE_TIMEOUT_DEFER_ACTIVITY, active_variant: maskVariant, from: "2000-01-01T00:00:00Z", until: "2099-12-31T00:00:00Z", by: "operator:test", reason: "fixture" } }]) as never,
    postTrace: async (t) => { deferTraces.push(t); return 201; },
    psiCpu: () => psi,
    readTuning: async (name) => (name === defer.SUITE_CONTENDED_PSI_ROW ? 30 : null),
    stateFile: join(ws, "precutover-suite-timeout-defer.json"),
  });
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  writes.length = 0;
  currentHost = "";
  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  execGuard = installCutoverExecGuard();
  execGuard.route({ name: "host-repo-load-state", match: (c) => /^systemctl show \S+\/host-repo\.service -p LoadState --value$/.test(c), respond: () => ({ exitCode: 0, stdout: "not-found\n" }) });
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
});

afterEach(async () => {
  const violations = guard.restore();
  const fsViolations = fsGuard.restore();
  const unroutedExec = execGuard.restore();
  if (unroutedExec.length > 0) throw new Error(`unrouted systemd call(s): ${unroutedExec.join("; ")}`);
  __setOwnCheckDepsForTests(null);
  defer.__setPrecutoverSuiteTimeoutDeferDepsForTests(null);
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
/** A gap row with NO own check (falsifier: none): the own-check step abstains, so these cases isolate the
 *  pre-cutover suite's decision, not a different gate's. */
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

describe("cutover: a pre-cutover suite that timed out under contention defers under variant-1", () => {
  it("MUST-FAIL: variant-1, timed out on a contended host: deferred with the pending lock kept, the clone clean, nothing landed", async () => {
    const s = await setup();
    suiteTimesOut();
    noOwnCheck();
    maskVariant = 1;
    const before = git(s.originRoot, "rev-parse", "dev");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["refuse_class"]).toBe("pre_cutover_suite_timeout_deferred");
    expect(bodyOf(r)["deferred"]).toBe(true);
    expect(bodyOf(r)["preserve_pending"]).toBe(true);
    expect(existsSync(s.pointer.pending_pointer_path)).toBe(true);
    expect(git(s.hostRepoRoot, "status", "--porcelain")).toBe("");
    expect(headSubject(s)).toBe("baseline");
    expect(git(s.originRoot, "rev-parse", "dev")).toBe(before);
    expect(deferTraces.some((t) => t["activity_id"] === `${defer.PRECUTOVER_SUITE_TIMEOUT_DEFER_ACTIVITY}-v1`)).toBe(true);
  });

  it("CONTROL (variant-0): the same timed-out suite is refused pre_cutover_suite_not_run as before, the pending lock cleared", async () => {
    const s = await setup();
    suiteTimesOut();
    noOwnCheck();
    const before = git(s.originRoot, "rev-parse", "dev");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["refuse_class"]).toBe("pre_cutover_suite_not_run");
    expect(bodyOf(r)["deferred"]).toBeUndefined();
    expect(bodyOf(r)["preserve_pending"]).toBeUndefined();
    expect(existsSync(s.pointer.pending_pointer_path)).toBe(false);
    expect(headSubject(s)).toBe("baseline");
    expect(git(s.originRoot, "rev-parse", "dev")).toBe(before);
    expect(deferTraces).toEqual([]);
  });

  it("CONTROL (variant-1, uncontended): a timed-out suite on an idle host is refused as before", async () => {
    const s = await setup();
    suiteTimesOut();
    noOwnCheck();
    maskVariant = 1;
    psi = PSI_IDLE;
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["refuse_class"]).toBe("pre_cutover_suite_not_run");
    expect(bodyOf(r)["deferred"]).toBeUndefined();
  });
});
