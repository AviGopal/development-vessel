// THE PRE-CUTOVER GATE COMPARES WHOLE FAILING SETS, NEVER CAPPED PREFIXES (test-suite.ts THE WHOLE FAILING SET,
// agf_ma46zpo17hik, 2026-10-26).
//
// Gap: test_suite capped failingTests at 25 names. The post-land baseline is written from that list and the 5d
// PRE-CUTOVER TEST GATE subtracts the staged run's list from it, so on a vessel whose suite fails more than 25 tests
// both were capped prefixes and which names fell past the cap depended on file order. A staging that changes no test
// outcome read the names past the baseline's cap as newly failing, the isolation re-run confirmed them (they really
// are red), and the cutover was refused: node1's goal-host baseline held 25 names for suites failing 27 to 29.
//
// Pinned through the real resolveVesselMitosisCutover (git-aware path, temp clone, bare origin, skip_push,
// skip_restart; harness as cutover-precutover-check-only-red-at-base.test.ts) and the real resolveTestSuite behind
// the fixture shell. The baseline is what the post-land writer stores, the failingTests of a real resolveTestSuite
// run, here over the same 27 failures listed in the other order. A src staging, so the check-only parent re-run
// (isCheckOnlyStaging) is not what decides:
//   MUST-FAIL: 27 failing at the baseline, the same 27 at the staged tree in another order -> nothing newly failing, lands;
//   CONTROL:   the staged tree adds a 28th distinct failure -> refused;
//   MUST-FAIL: that refusal names exactly the 28th, and the baseline holds all 27.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { resolveTestSuite } from "../../src/resolvers/test-suite.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  installCutoverFetchGuard, routeFleetUnreachable, routeShell,
  BUN_NO_TESTS, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch,
} from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

const { resolveVesselMitosisCutover, __setOwnCheckDepsForTests } = cutoverMod;
const setBaseline = (cutoverMod as unknown as { __setPrecutoverBaselineForTests: (f: ((v: string) => Promise<string[] | null>) | null) => void }).__setPrecutoverBaselineForTests;

const ENV_KEYS = [
  "WORKSPACE_ROOT", "MITOSIS_CUTOVER_SKIP_SYSTEMCTL", "MITOSIS_DIRECT_PUSH", "MITOSIS_RUNTIME_DIR", "MITOSIS_PUSH_CLONE_DIR",
  "MITOSIS_HOST_SYNC_MODE", "MITOSIS_HOST_REPO_ROOT", "PUSH_POLICY_PATH", "SUBSTRATE_REPO_OWNER", "CUTOVER_PRECHECK_SUITE",
  "MAINTENANCE_LEASE_PATH", "GAP_STORE_ENDPOINT",
] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let guard: FetchGuard;
let fsGuard: FsGuard;
let execGuard: ExecGuard;
afterAll(() => {
  restoreCutoverFsModules();
  restoreCutoverFetch();
  restoreCutoverExecModules();
});

const VESSEL = "development-vessel";
const GAP = "gap-precutover-full-set-target";
const MVID = "mitosis-2026-10-26T00-00-00-000Z";
const SRC = "src/resolvers/target.ts";
// 27 standing failures (more than the old cap of 25), and one more that only a regression adds.
const NAMES = Array.from({ length: 27 }, (_, i) => `the scribe's shack > framing ${String(i + 1).padStart(2, "0")} reads in reverse`);
const EXTRA = "the scribe's shack > a monstrous new failure";
const out = (names: string[]): string =>
  `bun test v1.3.14 (0d9b296a)\n\ntest/resolvers/shack.test.ts:\n(pass) ok [0.06ms]\n${names.map((n) => `(fail) ${n} [0.20ms]`).join("\n")}\n\n 1 pass\n ${names.length} fail\n ${names.length + 1} expect() calls\nRan ${names.length + 1} tests across 1 file. [11.00ms]\n`;

let currentHost = "";
/** What the fixture shell's bun prints for a working-tree run of the staged tree (whole suite and isolation re-run). */
let staged: string[] = [];
/** Set while the test measures the baseline itself (the post-land writer's input), outside any cutover. */
let measuring: string[] | null = null;
function suite(): void {
  routeShell(guard, () => {
    if (measuring) return out(measuring);
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return BUN_NO_TESTS; // post-land call
    return out(staged);
  });
}
/** The baseline exactly as the post-land writer stores it: the failingTests of a real test_suite run. */
async function baselineOf(names: string[]): Promise<string[]> {
  measuring = names;
  try {
    const r = (await resolveTestSuite({ vessel: VESSEL })) as { body: Record<string, unknown> };
    expect(r.body["ran"]).toBe(true);
    return (r.body["failingTests"] as unknown[]).map(String);
  } finally { measuring = null; }
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-precutover-full-set-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  currentHost = "";
  staged = [];
  measuring = null;
  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  execGuard = installCutoverExecGuard();
  execGuard.route({ name: "host-repo-load-state", match: (c) => /^systemctl show \S+\/host-repo\.service -p LoadState --value$/.test(c), respond: () => ({ exitCode: 0, stdout: "not-found\n" }) });
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
  const row = { id: GAP, status: "open", category: "missing_capability", summary: "target gap", source: "substrate_detected", classification_metadata: { falsifier: "none" } };
  __setOwnCheckDepsForTests({
    readGap: async (p: Record<string, unknown>) => ({ shape: "substrateGap", body: { gaps: p["id"] === GAP ? [row] : [] } }),
    writeGap: async () => ({ shape: "substrateGapWriteResult", body: { ok: true } }),
    runSuite: async () => ({ shape: "test_suite", body: { ran: false } }),
  } as never);
});

afterEach(async () => {
  const violations = guard.restore();
  const fsViolations = fsGuard.restore();
  const unroutedExec = execGuard.restore();
  if (unroutedExec.length > 0) throw new Error(`unrouted systemd call(s): ${unroutedExec.join("; ")}`);
  __setOwnCheckDepsForTests(null);
  setBaseline(null);
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

async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), content);
}

/** One staged file, `target`, changed from its live content. */
async function setup(target: string) {
  const reposRoot = join(ws, "git", "super-repo", "repos");
  const baseRoot = join(reposRoot, VESSEL);
  const mitosisRoot = join(ws, "vessels", `${VESSEL}-${MVID}`);
  await put(baseRoot, "src/index.ts", "// base index\n");
  const live = "// original (live)\n";
  await put(baseRoot, target, live);
  const baseSha = createHash("sha256").update(live).digest("hex").slice(0, 12);
  await put(mitosisRoot, target, "// patched by substrate\n");
  const hostRepoRoot = join(ws, "host-repo");
  await put(hostRepoRoot, target, "// original\n");
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
  await writeFile(
    pendingPath,
    JSON.stringify({ vessel_name: VESSEL, base_version_id: "v1", mitosis_version_id: MVID, mitosis_root: mitosisRoot, base_sha: baseSha, authored_by: "patch_with_tools", gap_id: GAP, proposal: GAP, staged_files: [target] }, null, 2),
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
    staged_files: [target],
    proposal_id: GAP,
    gap_id: GAP,
    pending_pointer_path: pendingPath,
    applied_log_path: join(ws, "mitosis-applied.jsonl"),
    evaluation_evidence: { verdict: "FAVORABLE", verdict_reason: "static_checks_pass", base_success_rate: 1, mitosis_success_rate: 1, cited_trace_ids: [], cited_check_names: ["bun run typecheck"] },
    skip_push: true,
    skip_restart: true,
  };
  return { hostRepoRoot, originRoot, pointer };
}

const bodyOf = (r: { body?: unknown }) => (r.body ?? {}) as Record<string, unknown>;
const headSubject = (s: { hostRepoRoot: string }) => git(s.hostRepoRoot, "log", "-1", "--format=%s");

describe("cutover: the pre-cutover gate compares whole failing sets, never capped prefixes", () => {
  it("MUST-FAIL: 27 failing at the baseline and the same 27 at the staged tree, listed in another order, is not refused", async () => {
    const s = await setup(SRC);
    suite();
    const base = await baselineOf(NAMES);
    setBaseline(async () => base);
    staged = [...NAMES].reverse();
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).not.toBe("precutover_regression");
    expect(bodyOf(r)["newly_failing"]).toBeUndefined();
    expect(r.shape).toBe("cutoverApplied");
    expect(headSubject(s)).not.toBe("baseline");
  });

  it("CONTROL: a staged tree that adds a 28th distinct failure is refused", async () => {
    const s = await setup(SRC);
    suite();
    const base = await baselineOf(NAMES);
    setBaseline(async () => base);
    staged = [EXTRA, ...[...NAMES].reverse()];
    const before = git(s.originRoot, "rev-parse", "dev");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).toBe("precutover_regression");
    expect(bodyOf(r)["newly_failing"] as string[]).toContain(`(fail) ${EXTRA}`);
    expect(headSubject(s)).toBe("baseline");
    expect(git(s.originRoot, "rev-parse", "dev")).toBe(before);
  });

  it("MUST-FAIL: that refusal names exactly the 28th failure, none of the 27 the baseline already holds", async () => {
    const s = await setup(SRC);
    suite();
    const base = await baselineOf(NAMES);
    expect(base.length).toBe(27);
    setBaseline(async () => base);
    staged = [EXTRA, ...[...NAMES].reverse()];
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["newly_failing"]).toEqual([`(fail) ${EXTRA}`]);
  });
});
