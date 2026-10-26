// AN UNMEASURED CONFIRMATION RE-RUN IS NOT A PASS (vessel-mitosis-cutover.ts 5d gate, isolation_unmeasurable,
// agf_7m6ayx34p3fr, 2026-10-26).
//
// Gap: the pre-cutover gate confirms newly-failing names by re-running them alone (runSuiteOnly), and a re-run with no
// result (failAgain null) cleared the list, so the staging landed on no evidence. test_suite refuses an only_tests
// list longer than ONLY_TESTS_MAX_NAMES (500) before it runs anything, so once failingTests carried the whole failing
// set (test-suite.ts THE WHOLE FAILING SET), a staging breaking more than 500 tests sailed through that way. Now a
// null confirmation refuses (isolation_unmeasurable), and more than ONLY_TESTS_MAX_NAMES names take the whole-suite
// confirmation the block already uses for unparseable names.
//
// Pinned through the real resolveVesselMitosisCutover and resolveTestSuite behind the fixture shell (harness as
// cutover-precutover-baseline-full-set.test.ts); the fixture tells the whole-suite run from the isolation re-run by
// bun's name filter:
//   MUST-FAIL: a src staging with 501 newly failing names is refused;
//   MUST-FAIL: an isolation re-run that produces no result is refused, isolation_unmeasurable;
//   CONTROL:   500 newly failing names, all green alone, still land (an isolation artefact, as today).
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
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
const GAP = "gap-precutover-isolation-target";
const MVID = "mitosis-2026-10-26T00-00-00-000Z";
const SRC = "src/resolvers/target.ts";
const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `the scribe's shack > framing ${String(i + 1).padStart(3, "0")} reads in reverse`);
const out = (fails: string[]): string =>
  `bun test v1.3.14 (0d9b296a)\n\ntest/resolvers/shack.test.ts:\n(pass) ok [0.06ms]\n${fails.map((n) => `(fail) ${n} [0.20ms]`).join("\n")}\n\n 1 pass\n ${fails.length} fail\n ${fails.length + 1} expect() calls\nRan ${fails.length + 1} tests across 1 file. [11.00ms]\n`;
const GREEN_ALONE = "bun test v1.3.14 (0d9b296a)\n\ntest/resolvers/shack.test.ts:\n(pass) ok [0.06ms]\n\n 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file. [11.00ms]\n";

let currentHost = "";
let staged: string[] = [];
/** What an isolation re-run (a run with bun's name filter) prints: the same failures, green alone, or nothing. */
let isolation: "red" | "green" | "no_result" = "red";
const isolationCommands: string[] = [];
function suite(): void {
  routeShell(guard, (command) => {
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return BUN_NO_TESTS; // post-land call
    if (command.includes("--test-name-pattern")) {
      isolationCommands.push(command);
      return isolation === "no_result" ? BUN_NO_TESTS : isolation === "green" ? GREEN_ALONE : out(staged);
    }
    return out(staged);
  });
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-precutover-isolation-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  currentHost = "";
  staged = [];
  isolation = "red";
  isolationCommands.length = 0;
  setBaseline(async () => ["(fail) another file > a standing red"]);
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

describe("cutover: an unmeasured confirmation re-run is not a pass", () => {
  it("MUST-FAIL: a src staging with 501 newly failing names is refused", async () => {
    const s = await setup(SRC);
    suite();
    staged = names(501);
    const before = git(s.originRoot, "rev-parse", "dev");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).toBe("precutover_regression");
    expect(headSubject(s)).toBe("baseline");
    expect(git(s.originRoot, "rev-parse", "dev")).toBe(before);
  });

  it("MUST-FAIL: an isolation re-run that produces no result is refused (isolation_unmeasurable)", async () => {
    const s = await setup(SRC);
    suite();
    staged = names(3);
    isolation = "no_result";
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).toBe("isolation_unmeasurable");
    expect(bodyOf(r)["newly_failing"]).toEqual(names(3).map((n) => `(fail) ${n}`));
    expect(isolationCommands.length).toBe(1);
    expect(headSubject(s)).toBe("baseline");
  });

  it("CONTROL: 500 newly failing names, all green when re-run alone, still land", async () => {
    const s = await setup(SRC);
    suite();
    staged = names(500);
    isolation = "green";
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(String(bodyOf(r)["refusal_reason"] ?? "")).toBe("");
    expect(r.shape).toBe("cutoverApplied");
    expect(isolationCommands.length).toBe(1);
    expect(headSubject(s)).not.toBe("baseline");
  });
});
