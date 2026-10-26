// A CHECK-ONLY STAGING IS NOT REFUSED ON A TEST RED AT ITS PARENT TOO (vessel-mitosis-cutover.ts isCheckOnlyStaging,
// agf_ozt0khtno455, 2026-10-26).
//
// Gap: the 5d PRE-CUTOVER TEST GATE compares the staged run's failing names against the LAST LANDED baseline. A
// staging of only out-of-suite checks (test/checks/<name>.check.ts, which bun's default discovery never collects)
// leaves the suite's tree as it is at the parent, yet a test red at the parent today and absent from that baseline
// read as newly failing, the isolation re-run confirmed it (it really is red), and the cutover was refused. The
// baseline refreshes only on a green landing: node1 refused 9 check-only stagings that way on 2026-10-26.
//
// The fix runs the confirmed names on the parent (base_ref HEAD) at the same tick and drops those red there too, for
// a check-only staging only. Pinned here through the real resolveVesselMitosisCutover (git-aware path, temp clone
// with a bare origin, skip_push, skip_restart), the fixture shell telling the parent run (a detached worktree add)
// from the staged working-tree run:
//   MUST-FAIL: check-only staging, the unrelated test red at BOTH parent and staged -> lands (refused before the fix);
//   CONTROL:   src staging whose staged tree newly fails a test the parent passes -> still refused;
//   CONTROL:   src staging, red at both -> still refused (the subtraction is for check-only stagings only);
//   CONTROL:   check-only staging, green at the parent -> still refused; parent unmeasured -> still refused.
// Harness as cutover-precutover-gate-undirected.test.ts (the shared fetch, fs and exec guards).
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
const GAP = "gap-precutover-check-only-target";
const MVID = "mitosis-2026-10-26T00-00-00-000Z";
const CHECK = "test/checks/the-scribes-shack.check.ts";
const SRC = "src/resolvers/target.ts";
// The unrelated, environment-red test: in neither staged file's reach, absent from the last landed baseline.
const UNRELATED = "the scribe's shack > a monstrous framing reads in reverse";
const UNRELATED_LINE = `(fail) ${UNRELATED}`;
const RED = `bun test v1.3.14 (0d9b296a)\n\ntest/resolvers/shack.test.ts:\n(pass) ok [0.06ms]\n${UNRELATED_LINE} [0.20ms]\n\n 1 pass\n 1 fail\n 2 expect() calls\nRan 2 tests across 1 file. [11.00ms]\n`;
const GREEN = "bun test v1.3.14 (0d9b296a)\n\ntest/resolvers/shack.test.ts:\n(pass) ok [0.06ms]\n(pass) the scribe's shack > a monstrous framing reads in reverse [0.06ms]\n\n 2 pass\n 0 fail\n 2 expect() calls\nRan 2 tests across 1 file. [11.00ms]\n";

let currentHost = "";
const baseCommands: string[] = [];
/** staged = the working-tree runs (whole suite and the isolation re-run); parent = the base_ref run in a detached worktree. */
function suite(staged: "red" | "green", parent: "red" | "green" | "no_result"): void {
  routeShell(guard, (command) => {
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return BUN_NO_TESTS; // post-land call
    if (command.includes("worktree add")) {
      baseCommands.push(command);
      return parent === "no_result" ? BUN_NO_TESTS : parent === "red" ? RED : GREEN;
    }
    return staged === "red" ? RED : GREEN;
  });
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-precutover-check-only-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  currentHost = "";
  baseCommands.length = 0;
  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  execGuard = installCutoverExecGuard();
  execGuard.route({ name: "host-repo-load-state", match: (c) => /^systemctl show \S+\/host-repo\.service -p LoadState --value$/.test(c), respond: () => ({ exitCode: 0, stdout: "not-found\n" }) });
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
  // The last landed baseline holds a standing red, not UNRELATED: UNRELATED reads as newly failing.
  setBaseline(async () => ["(fail) another file > a standing red"]);
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

/** One staged file, `target`, changed from its live content; the staging is check-only exactly when target is CHECK. */
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

describe("cutover: a check-only staging is judged against its parent, measured at the same tick", () => {
  it("MUST-FAIL: a check-only staging with an unrelated test red at BOTH parent and staged is not refused", async () => {
    const s = await setup(CHECK);
    suite("red", "red");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).not.toBe("precutover_regression");
    expect(String(bodyOf(r)["refusal_reason"] ?? "")).toBe("");
    expect(r.shape).toBe("cutoverApplied");
    expect(headSubject(s)).not.toBe("baseline");
    // The parent was measured on the confirmed name only, in a detached worktree of HEAD.
    expect(baseCommands.length).toBe(1);
  });

  it("CONTROL: a src staging whose staged tree newly fails a test the parent passes is still refused", async () => {
    const s = await setup(SRC);
    suite("red", "green");
    const before = git(s.originRoot, "rev-parse", "dev");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).toBe("precutover_regression");
    expect(bodyOf(r)["newly_failing"]).toEqual([UNRELATED_LINE]);
    expect(headSubject(s)).toBe("baseline");
    expect(git(s.originRoot, "rev-parse", "dev")).toBe(before);
  });

  it("CONTROL: a src staging red at both is still refused (the parent subtraction is for check-only stagings)", async () => {
    const s = await setup(SRC);
    suite("red", "red");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).toBe("precutover_regression");
    expect(baseCommands.length).toBe(0);
  });

  it("CONTROL: a check-only staging whose failing test is GREEN at the parent is still refused", async () => {
    const s = await setup(CHECK);
    suite("red", "green");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).toBe("precutover_regression");
    expect(headSubject(s)).toBe("baseline");
  });

  it("CONTROL: a check-only staging whose parent run produced no result is still refused (fails closed)", async () => {
    const s = await setup(CHECK);
    suite("red", "no_result");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).toBe("precutover_regression");
    expect(headSubject(s)).toBe("baseline");
  });
});
