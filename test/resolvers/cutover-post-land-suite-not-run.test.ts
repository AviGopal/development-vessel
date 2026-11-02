// THE POST-LAND SUITE'S BUDGET AND A SUITE THAT DID NOT RUN (vessel-mitosis-cutover.ts, post-land verification; row
// the-post-land-suite-runs-under-the-default-240s-budget-so-development-vessel-and-activity-api-landings-are-never-
// regression-checked-and-still-earn-landed-verified). The post-land call passed no timeout_ms, so test_suite's 240 s
// default killed the development-vessel and activity-api whole suites before their summary (ran false, or a
// structuredError when the client abort fired first). Credit was withheld only for ran === true with newly failing
// tests, so a suite that never ran still earned the landed_verified stamp, and the record dropped why.
// Pinned through the REAL resolveVesselMitosisCutover on its git-aware path, PUSHED to a local bare origin (so the
// pending-land stamp is reached), with the harness of cutover-suite-budget-and-check-landing.test.ts: the own check and
// the gap store through __setOwnCheckDepsForTests, the REAL test_suite resolver behind the shared cutover fetch guard.
//   MUST-FAIL: the post-land suite runs under precutoverSuiteTimeoutMs() (870 s default, the tuning row when set); a
//     post-land suite killed before its summary, or whose shell dispatch failed, withholds the stamp and records why.
//   CONTROL: a post-land suite that ran with nothing newly failing still stamps the landing, with no reason recorded.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCutoverFetchGuard, routeFleetUnreachable, routeShell,
  BUN_PASSING, BUN_KILLED_BY_TIMEOUT, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

const { resolveVesselMitosisCutover, __setOwnCheckDepsForTests } = cutoverMod;

const ENV_KEYS = [
  "WORKSPACE_ROOT", "MITOSIS_CUTOVER_SKIP_SYSTEMCTL", "MITOSIS_DIRECT_PUSH", "MITOSIS_RUNTIME_DIR", "MITOSIS_PUSH_CLONE_DIR",
  "MITOSIS_HOST_SYNC_MODE", "MITOSIS_HOST_REPO_ROOT", "PUSH_POLICY_PATH", "SUBSTRATE_REPO_OWNER", "CUTOVER_PRECHECK_SUITE",
  "MAINTENANCE_LEASE_PATH", "GAP_STORE_ENDPOINT", "ATTEMPT_LEDGER_DIR", "METABOB_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let guard: FetchGuard;
let fsGuard: FsGuard;
let execGuard: ExecGuard;
afterAll(() => {
  restoreCutoverFsModules();
  restoreCutoverExecModules();
  restoreCutoverFetch();
});

const VESSEL = "development-vessel";
const GAP = "gap-post-land-not-run";
const MVID = "mitosis-2026-11-01T16-00-00-000Z";
const TARGET = "src/resolvers/target.ts";
const BASELINE_DIR = "/workspace/post-land-baseline";

type PostLand = "killed" | "dispatch_failed" | "passing";
/** The post-land suite runs' shell commands (the landing clone past its baseline commit), in order. */
const postLandCommands: string[] = [];
let currentHost = "";
/** Pre-cutover (clone at "baseline"): a passing suite. Post-land: `mode`. */
function suite(mode: PostLand): void {
  routeShell(guard, (command) => {
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") === "baseline") {
      return `VERIFIED_ROOT=${currentHost}\nVERIFIED_HEAD=abc1234\n${BUN_PASSING}`;
    }
    // Only suite runs are recorded: the cutover makes other shell-producer calls past the commit (no bun test in them).
    if (/ bun test /.test(command)) postLandCommands.push(command);
    if (mode === "dispatch_failed") throw new Error("shell producer connection reset");
    return `VERIFIED_ROOT=${currentHost}\nVERIFIED_HEAD=abc1234\n${mode === "killed" ? BUN_KILLED_BY_TIMEOUT : BUN_PASSING}`;
  });
}
function tuningRow(value: unknown): void {
  guard.route({ name: "tuning row cutover.precutover_suite_timeout_ms", match: (u) => u.includes("/v2/tuning-params/cutover.precutover_suite_timeout_ms"), respond: () => Response.json({ name: "cutover.precutover_suite_timeout_ms", value }) });
}
/** The suite run's own `timeout <s>` (the last one: an earlier `timeout 120` bounds the dependency install). */
const budgetOf = (cmd: string) => Number([...cmd.matchAll(/(?<![-\w])timeout (\d+) /g)].at(-1)?.[1] ?? NaN);

const writes: Array<Record<string, unknown>> = [];
const noCheckRow = { id: GAP, status: "open", category: "missing_capability", summary: "target does what the gap asked", source: "substrate_detected", classification_metadata: { falsifier: "none", edit_site: `repos/${VESSEL}/${TARGET}` } };
function noCheck(hostRepoRoot: string): void {
  __setOwnCheckDepsForTests({
    readGap: async (p: Record<string, unknown>) => ({ shape: "substrateGap", body: { gaps: p["id"] === GAP ? [noCheckRow] : [] } }),
    writeGap: async (p: Record<string, unknown>) => { writes.push(JSON.parse(JSON.stringify(p))); return { shape: "substrateGapWriteResult", body: { ok: true } }; },
    runSuite: async () => ({ shape: "test_suite", body: { vessel: `repos/${VESSEL}`, verified_root: hostRepoRoot, ran: true, total: 1, pass: 1, fail: 0, skip: 0, requested_not_passing: 0, failingTests: [] } }),
  });
}
/** The pending-land stamps written for the landing gap (stampPendingLand's pending_outcome_verification). */
const stampsOf = () => writes
  .map((w) => ((w["gap"] ?? {}) as Record<string, unknown>))
  .filter((g) => g["id"] === GAP && ((g["classification_metadata"] ?? {}) as Record<string, unknown>)["pending_outcome_verification"]);

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-post-land-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  process.env["ATTEMPT_LEDGER_DIR"] = join(ws, "attempt-ledger");
  process.env["METABOB_API_KEY"] = "cutover-post-land-fixture-node-key";
  writes.length = 0;
  postLandCommands.length = 0;
  currentHost = "";
  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  execGuard = installCutoverExecGuard();
  execGuard.route({ name: "attempt-check-unit", match: (c) => /systemctl show \S+ -p LoadState --value/.test(c), respond: () => ({ exitCode: 1, stdout: "" }) });
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
});

afterEach(async () => {
  const violations = guard.restore();
  // A post-land suite that RAN writes its baseline under the literal /workspace/post-land-baseline: the fs guard blocks
  // that write before anything lands (the cutover swallows it, best-effort). Only that path is excused here.
  const fsViolations = fsGuard.restore().filter((v) => !v.includes(BASELINE_DIR));
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
  const baseRoot = join(ws, "git", "super-repo", "repos", VESSEL);
  const mitosisRoot = join(ws, "vessels", `${VESSEL}-${MVID}`);
  await mkdir(join(baseRoot, "src", "resolvers"), { recursive: true });
  await mkdir(join(mitosisRoot, "src", "resolvers"), { recursive: true });
  await writeFile(join(baseRoot, "src", "index.ts"), "// base index\n");
  const live = "// original (live)\n";
  await writeFile(join(baseRoot, TARGET), live);
  const baseSha = createHash("sha256").update(live).digest("hex").slice(0, 12);
  await writeFile(join(mitosisRoot, TARGET), "// patched by substrate\n");
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
  currentHost = hostRepoRoot;
  const pendingPath = join(ws, "mitosis-pending.json");
  await writeFile(pendingPath, JSON.stringify({
    vessel_name: VESSEL, base_version_id: "v1", mitosis_version_id: MVID, mitosis_root: mitosisRoot, base_sha: baseSha,
    authored_by: "patch_with_tools", gap_id: GAP, proposal: GAP, staged_files: [TARGET],
  }, null, 2));
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
    // NOT skip_push: the landing is pushed to the local bare origin, so the pending-land stamp is reached.
    skip_restart: true,
  };
  return { hostRepoRoot, originRoot, pointer };
}

const bodyOf = (r: { body?: unknown }) => (r.body ?? {}) as Record<string, unknown>;
async function land(mode: PostLand): Promise<{ body: Record<string, unknown>; postLand: Record<string, unknown>; originHead: string }> {
  const s = await setup();
  suite(mode);
  noCheck(s.hostRepoRoot);
  const r = await resolveVesselMitosisCutover(s.pointer as never);
  expect(String(bodyOf(r)["refusal_reason"] ?? "")).toBe("");
  expect(r.shape).toBe("cutoverApplied");
  const body = bodyOf(r);
  expect(body["push_status"]).toBe("pushed");
  return { body, postLand: (body["post_land_suite"] ?? {}) as Record<string, unknown>, originHead: git(s.originRoot, "rev-parse", "dev") };
}

describe("cutover: the post-land suite runs under the shaped suite budget", () => {
  it("[MUST-FAIL] the post-land call gets timeout_ms = precutoverSuiteTimeoutMs() (870 s by default), not test_suite's 240 s", async () => {
    const { postLand } = await land("passing");
    expect(postLandCommands.length).toBe(1);
    expect(budgetOf(postLandCommands[0]!)).toBe(870);
    expect(await cutoverMod.precutoverSuiteTimeoutMs(async () => null)).toBe(870_000);
    expect(postLand["timeout_ms"]).toBe(870_000);
  });

  it("[MUST-FAIL] the tuning row the pre-cutover suite reads sets the post-land budget too", async () => {
    tuningRow(300_000);
    const { postLand } = await land("passing");
    expect(budgetOf(postLandCommands.at(-1)!)).toBe(300);
    expect(postLand["timeout_ms"]).toBe(300_000);
  });
});

describe("cutover: a post-land suite that did not run withholds landed_verified and says why", () => {
  it("[MUST-FAIL] killed before its summary (ran:false): no pending-land stamp, the reason on post_land_suite", async () => {
    const { body, postLand, originHead } = await land("killed");
    expect(body["new_git_sha"]).toBe(originHead);
    expect(postLand["ran"]).toBe(false);
    expect(String(postLand["not_ran_reason"] ?? "")).toBe("no summary within timeout_ms=870000");
    expect(postLand["landing_credit_withheld"]).toBe(true);
    expect(stampsOf()).toEqual([]);
  });

  it("[MUST-FAIL] the shell dispatch failed (a structuredError, no ran): no pending-land stamp, the error detail kept", async () => {
    const { postLand } = await land("dispatch_failed");
    expect(postLand["ran"]).toBe(false);
    const why = String(postLand["not_ran_reason"] ?? "");
    expect(why).toStartWith("structuredError: shell dispatch failed: ");
    expect(why.length).toBeLessThanOrEqual(300);
    expect(postLand["landing_credit_withheld"]).toBe(true);
    expect(stampsOf()).toEqual([]);
  });

  it("[CONTROL] a post-land suite that ran with nothing newly failing still stamps the landing, with no reason", async () => {
    const { body, postLand } = await land("passing");
    expect(postLand["ran"]).toBe(true);
    expect(postLand["not_ran_reason"]).toBeUndefined();
    expect(postLand["landing_credit_withheld"]).toBeUndefined();
    const stamps = stampsOf();
    expect(stamps.length).toBe(1);
    expect(((stamps[0]!["classification_metadata"] ?? {}) as Record<string, unknown>)["pending_outcome_verification"]).toBe(body["new_git_sha"]);
  });
});
