// THE PRE-CUTOVER SUITE'S BUDGET AND THE CHECK LANDING (vessel-mitosis-cutover.ts; from the diagnosis of 0 of 43 cutovers
// verified by their own check). Two cutover rules, each pinned below through the REAL resolveVesselMitosisCutover on its
// git-aware path against a temp clone with a bare origin (skip_push, skip_restart): the harness is that of
// cutover-no-measurement-refuses.test.ts (the own check and the gap store through __setOwnCheckDepsForTests, the REAL
// test_suite resolver for the pre-cutover suite, the network stood in by the shared cutover fetch guard; every
// unstubbed URL fails the test), plus a capture of the pre-cutover suite's shell commands.
//   B1: a check-only staging whose gap has no own check is a check_landing, not landed_unverified.
//   A1: the pre-cutover suite runs under the shaped budget cutover.precutover_suite_timeout_ms (default and cap 870000),
//       not test_suite's 240 s default.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { resolveMaintenanceLeaseWrite } from "../../src/resolvers/maintenance-lease.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { resolveMitosisPendingObserver } from "../../src/resolvers/mitosis-pending-observer.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import {
  installCutoverFetchGuard, routeFleetUnreachable, routeShell,
  BUN_PASSING, BUN_NO_TESTS, BUN_KILLED_BY_TIMEOUT, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { appendRecord } from "../../src/resolvers/attempt-ledger.js";
import { directedIntentStamp } from "../../src/resolvers/attempt-register.js";

const { resolveVesselMitosisCutover, __setOwnCheckDepsForTests } = cutoverMod;

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
  "ATTEMPT_LEDGER_DIR",
  "METABOB_API_KEY",
] as const;
const FIXTURE_NODE_KEY = "cutover-no-meas-fixture-node-key";
/** A stamped, verified-directed attemptIntent (attempt-register.ts directedIntentStamp), the only
 *  thing directedLandingOrigin honours — not a flag on the pointer or the pending file. */
function registerDirectedIntent(attemptId: string, gapId: string, files: string[]): void {
  const intent = { attempt_id: attemptId, route: "feature_compose", repo: `/workspace/git/vessels/${VESSEL}`, gap_id: gapId, touched_files: files, directed: true };
  const directed_stamp = directedIntentStamp(FIXTURE_NODE_KEY, intent);
  appendRecord("attemptIntent", attemptId, { ...intent, directed_stamp });
}
const saved: Record<string, string | undefined> = {};
let ws: string;
let guard: FetchGuard;
let fsGuard: FsGuard;
let execGuard: ExecGuard;
// Backstop: whatever happened in this file, the next file in the same bun process gets the real
// fs and fetch (bun's mock.restore() does not undo mock.module; see cutover-fs-guard.ts).
afterAll(() => {
  restoreCutoverFsModules();
  restoreCutoverExecModules();
  restoreCutoverFetch();
});

const VESSEL = "development-vessel";
const GAP = "gap-no-measurement-target";
const TEST_FILE = "test/resolvers/target.test.ts";
const OWN_TEST = "target > does what the gap asked";
const STAGED = "// patched by substrate\n";
const MVID = "mitosis-2026-10-02T23-45-00-000Z";
const TARGET = "src/resolvers/target.ts";

type SuiteMode = "no_tests" | "killed" | "dispatch_failed" | "passing";
/** Shell calls made while the landing clone still sat at its baseline commit: the PRE-cutover suite. */
let precheckCalls = 0;
/** The pre-cutover suite's shell commands, in order (their `timeout <s>` is the suite budget test_suite was given). */
const precheckCommands: string[] = [];
let shellCalls = 0;
let currentHost = "";
// `mode` answers only the PRE-cutover call (landing clone still at its baseline commit). Once
// the cutover's commit exists, the post-land suite gets a no-summary answer (ran=false): a
// post-land ran=true writes /workspace/post-land-baseline/<vessel>.json (an absolute path), and on
// a substrate node that would replace the real baseline with this fixture's empty failure list.
function suite(mode: SuiteMode): void {
  routeShell(guard, (command) => {
    shellCalls++;
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return BUN_NO_TESTS;
    precheckCalls++;
    if (mode === "dispatch_failed") throw new Error("shell producer connection reset");
    precheckCommands.push(command);
    const out = mode === "no_tests" ? BUN_NO_TESTS : mode === "killed" ? BUN_KILLED_BY_TIMEOUT : BUN_PASSING;
    return `VERIFIED_ROOT=${currentHost}\nVERIFIED_HEAD=abc1234\n${out}`;
  });
}

const writes: Array<Record<string, unknown>> = [];
const recordWrite = async (p: Record<string, unknown>) => {
  writes.push(JSON.parse(JSON.stringify(p)));
  return { shape: "substrateGapWriteResult", body: { ok: true } };
};

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-no-meas-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  process.env["ATTEMPT_LEDGER_DIR"] = join(ws, "attempt-ledger");
  process.env["METABOB_API_KEY"] = FIXTURE_NODE_KEY;
  // CUTOVER_PRECHECK_SUITE deliberately left unset: the suite step runs.
  writes.length = 0;
  precheckCalls = 0;
  precheckCommands.length = 0;
  shellCalls = 0;
  currentHost = "";
  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  // attempt-checks.ts's systemd_units check spawns `systemctl show <vessel>.service -p LoadState --value`
  // (not gated by MITOSIS_CUTOVER_SKIP_SYSTEMCTL above, a different call site): answered as a host with no
  // systemd, as test/drafter-split/harness.ts and auto-revert.test.ts already do for the same check.
  execGuard = installCutoverExecGuard();
  execGuard.route({ name: "attempt-check-unit", match: (c) => /systemctl show \S+ -p LoadState --value/.test(c), respond: () => ({ exitCode: 1, stdout: "" }) });
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE; // never the module-load-captured store
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
});

afterEach(async () => {
  const violations = guard.restore();
  const fsViolations = fsGuard.restore();
  const execViolations = execGuard.restore();
  __setOwnCheckDepsForTests(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(ws, { recursive: true, force: true });
  expect(violations).toEqual([]);
  expect(execViolations).toEqual([]);
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
  // The landing repo: source only, NO test files (the "repo with no tests" of the falsifier).
  const hostRepoRoot = join(ws, "host-repo");
  await mkdir(join(hostRepoRoot, "src", "resolvers"), { recursive: true });
  await writeFile(join(hostRepoRoot, TARGET), "// original\n");
  git(hostRepoRoot, "init", "-q", "-b", "dev");
  git(hostRepoRoot, "config", "user.email", "test@example.com");
  git(hostRepoRoot, "config", "user.name", "Test");
  git(hostRepoRoot, "config", "commit.gpgsign", "false");
  git(hostRepoRoot, "add", ".");
  git(hostRepoRoot, "commit", "-q", "-m", "baseline");
  const baseCommit = git(hostRepoRoot, "rev-parse", "HEAD");
  const originRoot = join(ws, "host-origin.git");
  git(ws, "init", "-q", "--bare", "-b", "dev", originRoot);
  git(hostRepoRoot, "remote", "add", "origin", originRoot);
  git(hostRepoRoot, "push", "-q", "-u", "origin", "dev");
  const originSha = git(originRoot, "rev-parse", "dev");
  currentHost = hostRepoRoot;
  // What patch_with_tools leaves behind: the queue lock naming this mitosis and its gap.
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
      staged_files: [TARGET],
    }, null, 2),
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
  return { mitosisRoot, hostRepoRoot, originRoot, originSha, baseCommit, baseSha, pendingPath, pointer };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

// The gap of the instance: a row that exists but carries no test_suite check.
const noCheckRow = { id: GAP, status: "open", category: "missing_capability", summary: "target does what the gap asked", source: "substrate_detected", classification_metadata: { falsifier: "none", edit_site: `repos/${VESSEL}/${TARGET}` } };
const checkedRow = {
  ...noCheckRow,
  classification_metadata: {
    falsifier: "class2",
    edit_site: `repos/${VESSEL}/${TARGET}`,
    evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: TEST_FILE, only_tests: [OWN_TEST] }, zero_field: "requested_not_passing" },
  },
};
const readRow = (row: Record<string, unknown>) => async (p: Record<string, unknown>) =>
  ({ shape: "substrateGap", body: { gaps: p["id"] === GAP ? [row] : [] } });
function ownCheckBody(hostRepoRoot: string, over: Record<string, unknown>) {
  return { shape: "test_suite", body: { vessel: `repos/${VESSEL}`, verified_root: hostRepoRoot, ran: true, total: 1, pass: 1, fail: 0, skip: 0, requested_not_passing: 0, failingTests: [], ...over } };
}
function noCheck(s: Fixture): { ownRuns: () => number } {
  let n = 0;
  __setOwnCheckDepsForTests({ readGap: readRow(noCheckRow), writeGap: recordWrite, runSuite: async () => { n++; return ownCheckBody(s.hostRepoRoot, {}); } });
  return { ownRuns: () => n };
}
function ownCheckPasses(s: Fixture): { ownRuns: () => number } {
  let n = 0;
  // Counts the own-check runs on the STAGED tree; the landing-admissibility parent run (base_ref "HEAD") is not one.
  __setOwnCheckDepsForTests({ readGap: readRow(checkedRow), writeGap: recordWrite, runSuite: async (p: Record<string, unknown>) => { if (!p["base_ref"]) n++; return ownCheckBody(s.hostRepoRoot, {}); } });
  return { ownRuns: () => n };
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}
const bodyOf = (r: { body?: unknown }) => (r.body ?? {}) as Record<string, unknown>;
const headSubject = (s: Fixture) => git(s.hostRepoRoot, "log", "-1", "--format=%s");

/** The no-instrument gap writes: name the vessel or the landing gap and say there is no measurement / instrument. */
function noInstrumentWrites(): Array<Record<string, unknown>> {
  return writes.filter((w) => {
    const j = JSON.stringify(w);
    return /no[_ -]?(measurement|instrument)/i.test(j) && (j.includes(VESSEL) || j.includes(GAP));
  });
}
function archivedPatchOf(w: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const gap = (w?.["gap"] ?? {}) as Record<string, unknown>;
  const meta = (gap["classification_metadata"] ?? {}) as Record<string, unknown>;
  const a = meta["archived_patch"];
  return a && typeof a === "object" ? (a as Record<string, unknown>) : null;
}
/** Does the archive the record cites hold the staged content of TARGET (outside mitosis_root)? */
async function archiveHoldsStaged(s: Fixture, a: Record<string, unknown>): Promise<boolean> {
  const path = typeof a["path"] === "string" ? (a["path"] as string) : "";
  const ref = typeof a["ref"] === "string" ? (a["ref"] as string) : "";
  if (path && isAbsolute(path) && !path.startsWith(s.mitosisRoot)) {
    try {
      if ((await stat(path)).isDirectory()) return (await readFile(join(path, TARGET), "utf8")) === STAGED;
      return (await readFile(path, "utf8")).includes(STAGED.trim());
    } catch { return false; }
  }
  if (ref) {
    const r = spawnSync("git", ["show", `${ref}:${TARGET}`], { cwd: s.hostRepoRoot, encoding: "utf8" });
    return r.status === 0 && r.stdout === STAGED;
  }
  return false;
}

/** The archive's bytes (every file under a directory archive, a patch file, or a ref's tree), or null. */
async function archiveSnapshot(s: Fixture, a: Record<string, unknown>): Promise<Record<string, string> | null> {
  const path = typeof a["path"] === "string" ? (a["path"] as string) : "";
  const ref = typeof a["ref"] === "string" ? (a["ref"] as string) : "";
  try {
    if (path) {
      if (!(await stat(path)).isDirectory()) return { [path]: await readFile(path, "utf8") };
      const out: Record<string, string> = {};
      for (const rel of (await readdir(path, { recursive: true })) as string[]) {
        const full = join(path, rel);
        if ((await stat(full)).isFile()) out[rel] = await readFile(full, "utf8");
      }
      return out;
    }
    if (ref) {
      const r = spawnSync("git", ["ls-tree", "-r", ref], { cwd: s.hostRepoRoot, encoding: "utf8" });
      return r.status === 0 ? { [ref]: r.stdout } : null;
    }
  } catch { return null; }
  return null;
}

/** Refused for no measurement, nothing committed or pushed, the lock released, the patch archived and cited. */
async function expectRefusedReleasedArchived(s: Fixture, r: { shape: string; body?: unknown }): Promise<void> {
  const body = bodyOf(r);
  expect({
    shape: r.shape,
    refuse_class: body["refuse_class"] ?? null,
    head_subject: headSubject(s),
    origin_dev: git(s.originRoot, "rev-parse", "dev"),
  }).toEqual({
    shape: "vesselMitosisCutoverResult",
    refuse_class: "no_measurement_available",
    head_subject: "baseline",
    origin_dev: s.originSha,
  });
  expect(git(s.hostRepoRoot, "diff", "--cached", "--name-only")).toBe("");
  expect(await exists(s.pendingPath)).toBe(false);
  const a = archivedPatchOf(noInstrumentWrites()[0]);
  expect(a).not.toBeNull();
  expect(await archiveHoldsStaged(s, a!)).toBe(true);
}

// CHECK LANDING (B1). A check-only staging (isCheckOnlyStaging: out-of-suite test/checks/<name>.check.ts files only) for
// a gap with no own check verifies nothing in src and claims nothing: its outcome is check_landing, not
// landed_unverified. Accounting only: the stamp keeps the unverified credit guard and says it was a check landing.
// Fixture words from a 5-word draw (2026-10-29T17:52:25Z: lifting aged bulldozer smartness stipulate).
const CHECK = "test/checks/bulldozer-smartness.check.ts";
async function setupCheckOnly(): Promise<Fixture> {
  const s = await setup();
  // The freshness check reads the staged file's live copy under base_root; the setup's base sha is that of "// original (live)".
  await mkdir(join(s.pointer.base_root, "test", "checks"), { recursive: true });
  await writeFile(join(s.pointer.base_root, CHECK), "// original (live)\n");
  await rm(join(s.mitosisRoot, TARGET), { force: true });
  await mkdir(join(s.mitosisRoot, "test", "checks"), { recursive: true });
  await writeFile(join(s.mitosisRoot, CHECK), "// the aged lifting check stipulates\n");
  const pending = JSON.parse(await readFile(s.pendingPath, "utf8")) as Record<string, unknown>;
  await writeFile(s.pendingPath, JSON.stringify({ ...pending, staged_files: [CHECK] }, null, 2));
  return { ...s, pointer: { ...s.pointer, staged_files: [CHECK] } };
}
/** The pending-land stamp (stampPendingLand) runs only for a PUSHED landing, so it is driven directly here. */
async function stampOf(s: Fixture, checkLandingReason: string | null, landedUnverifiedReason: string | null, stagedFiles: string[]): Promise<Record<string, unknown>> {
  const sha = git(s.hostRepoRoot, "rev-parse", "HEAD");
  writes.length = 0;
  await (cutoverMod as unknown as { stampPendingLand: (a: Record<string, unknown>) => Promise<void> }).stampPendingLand({
    gapId: GAP, newSha: sha, appliedAt: "2026-10-29T17:52:25.000Z", vessel_name: VESSEL, hostRepoRoot: s.hostRepoRoot, gitCmd: "git",
    landedUnverifiedReason, checkLandingReason, stagedFiles,
  });
  return { sha, ...(stampMetaOf().at(-1) ?? {}) };
}
const stampMetaOf = () => writes
  .map((w) => ((w["gap"] ?? {}) as Record<string, unknown>))
  .filter((g) => g["id"] === GAP && ((g["classification_metadata"] ?? {}) as Record<string, unknown>)["pending_outcome_verification"])
  .map((g) => (g["classification_metadata"] ?? {}) as Record<string, unknown>);

describe("cutover: a check-only landing with no own check is a check_landing, not landed_unverified", () => {
  it("[MUST-FAIL] a check-only staging whose gap has no own check lands with outcome check_landing", async () => {
    const s = await setupCheckOnly();
    suite("passing");
    noCheck(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(String(bodyOf(r)["refusal_reason"] ?? "")).toBe("");
    expect(r.shape).toBe("cutoverApplied");
    const b = bodyOf(r);
    expect(b["check_landing"]).toBe(true);
    expect(b["landed_unverified"]).toBeUndefined();
    expect(b["own_check_verified"]).toBeUndefined();
    expect(((b["own_check_counters"] ?? {}) as Record<string, number>)["check_landing"]).toBeGreaterThan(0);
    const stamp = await stampOf(s, "gap has no own check", null, [CHECK]);
    expect(stamp["check_landing"]).toBe(stamp["sha"]);
    expect(stamp["landed_unverified"]).toBe(true);
    expect(String(stamp["landed_unverified_reason"])).toStartWith("check_landing: ");
  });

  it("[CONTROL] a src landing whose gap has no own check still reads landed_unverified", async () => {
    const s = await setup();
    suite("passing");
    noCheck(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(r.shape).toBe("cutoverApplied");
    const b = bodyOf(r);
    expect(b["landed_unverified"]).toBe(true);
    expect(b["check_landing"]).toBeUndefined();
    const stamp = await stampOf(s, null, "gap has no own check", [TARGET]);
    expect(stamp["check_landing"]).toBe("");
    expect(stamp["landed_unverified"]).toBe(true);
  });
});

// THE PRE-CUTOVER SUITE'S BUDGET (A1). With no timeout_ms the suite ran under test_suite's 240 s default; the whole
// development-vessel suite needs longer, so every run was killed before its summary and read as unmeasurable. The budget
// is the tuning row cutover.precutover_suite_timeout_ms (readTuningNumber), default and cap 870000. test_suite turns it
// into the shell's `timeout <s>`, which is what these read.
/** The suite run's own `timeout <s>` (the last one: an earlier `timeout 120` bounds the dependency install). */
const budgetOf = (cmd: string) => Number([...cmd.matchAll(/(?<![-\w])timeout (\d+) /g)].at(-1)?.[1] ?? NaN);
/** A suite that needs ~450 s: it prints its summary only when its budget exceeds that, else it is killed first. */
function suiteNeeding(seconds: number): void {
  routeShell(guard, (command) => {
    shellCalls++;
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return BUN_NO_TESTS;
    precheckCalls++;
    precheckCommands.push(command);
    return `VERIFIED_ROOT=${currentHost}\nVERIFIED_HEAD=abc1234\n${budgetOf(command) > seconds ? BUN_PASSING : BUN_KILLED_BY_TIMEOUT}`;
  });
}
function tuningRow(value: unknown): void {
  guard.route({ name: "tuning row cutover.precutover_suite_timeout_ms", match: (u) => u.includes("/v2/tuning-params/cutover.precutover_suite_timeout_ms"), respond: () => Response.json({ name: "cutover.precutover_suite_timeout_ms", value }) });
}

describe("cutover: the pre-cutover suite runs under a shaped budget, not test_suite's 240 s default", () => {
  it("[MUST-FAIL] a suite that needs more than 240 s is measured, not killed: it lands on its measurement", async () => {
    const s = await setup();
    suiteNeeding(450);
    noCheck(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(String(bodyOf(r)["refusal_reason"] ?? "")).toBe("");
    expect(r.shape).toBe("cutoverApplied");
    expect(precheckCommands.length).toBeGreaterThan(0);
    expect(budgetOf(precheckCommands[0]!)).toBe(870);
  });

  it("[CONTROL] a hung suite still times out under the budget and refuses: nothing is committed or pushed", async () => {
    const s = await setup();
    suite("killed");
    noCheck(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(budgetOf(precheckCommands[0]!)).toBe(870);
    expect(r.shape).toBe("vesselMitosisCutoverResult");
    // Whichever unmeasured-refusal class answers (no_measurement_available, or pre_cutover_suite_not_run for an
    // undirected landing), a killed suite is not a measurement and nothing lands.
    expect(["no_measurement_available", "pre_cutover_suite_not_run"]).toContain(String(bodyOf(r)["refuse_class"]));
    expect(headSubject(s)).toBe("baseline");
    expect(git(s.originRoot, "rev-parse", "dev")).toBe(s.originSha);
  });

  it("[CONTROL] the fetch guard answers only that row by default: any OTHER tuning read is still refused and recorded", async () => {
    const url = "http://127.0.0.1:8080/v2/tuning-params/cutover.some_other_row";
    let refused = false;
    try { await fetch(url); } catch { refused = true; }
    expect(refused).toBe(true);
    expect(guard.violations).toEqual([`GET ${url}`]);
    guard.violations.length = 0; // this test's violation is the point; afterEach checks every other test
    const own = await fetch("http://127.0.0.1:8080/v2/tuning-params/cutover.precutover_suite_timeout_ms");
    expect(own.status).toBe(404);
  });

  it("[CONTROL] the tuning row overrides the default (read through readTuningNumber), capped at 870000; <= 0 is the default", async () => {
    for (const [value, want] of [[300_000, 300], [2_000_000, 870], [0, 870], [-5, 870]] as const) {
      const s = await setup();
      suite("passing");
      tuningRow(value);
      noCheck(s);
      await resolveVesselMitosisCutover(s.pointer as never);
      expect([value, budgetOf(precheckCommands.at(-1)!)]).toEqual([value, want]);
      await rm(s.hostRepoRoot, { recursive: true, force: true });
      await rm(s.originRoot, { recursive: true, force: true });
      await rm(join(ws, "vessels"), { recursive: true, force: true });
      await rm(join(ws, "git"), { recursive: true, force: true });
    }
  });
});
