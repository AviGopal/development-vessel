// A REFUSED LANDING LEAVES THE PUSH CLONE AS IT FOUND IT.
//
// The cutover copies the staged files into the push clone (MITOSIS_PUSH_CLONE_DIR/<vessel>), adds them, and on a
// refusal after that point unstages them (unstage: `git reset HEAD -- <files>`). The index was put back; the work
// tree was not. A test-writing compose's new check (test/checks/<gap>.check.ts) therefore stayed in the clone as an
// UNTRACKED file after its refused landing, and the check supply's arm tick, which then read the work tree, armed the
// gap on a check no tree holds (2026-10-26: refused 16:27:43, rolled back 16:27:44, armed 16:27:46). The refusal now
// also puts the staged paths back to HEAD: new files removed, tracked ones checked out.
//
// Drives the REAL resolveVesselMitosisCutover through its git-aware path with the production layout, as
// cutover-stale-base-over-newer-commit.test.ts does: a temp bare origin, a clone of it, no push, no restart. The
// refusal used is the undirected pre-cutover suite that measured nothing (no attempt id, so the landing is not
// directed): it is reached after the copy and the add, and it is what refuses a check-only landing whose suite finds
// no test. Fixture text from a five-word draw (radiation java shelf setup jot).
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, routeFleetUnreachable, routeShell, BUN_PASSING, BUN_NO_TESTS, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

const { resolveVesselMitosisCutover, __setOwnCheckDepsForTests } = cutoverMod;

const ENV_KEYS = [
  "WORKSPACE_ROOT", "MITOSIS_CUTOVER_SKIP_SYSTEMCTL", "MITOSIS_DIRECT_PUSH", "MITOSIS_RUNTIME_DIR", "MITOSIS_PUSH_CLONE_DIR",
  "MITOSIS_HOST_SYNC_MODE", "MITOSIS_HOST_REPO_ROOT", "MITOSIS_SKIP_CLONE_RESET", "MITOSIS_STAGED_MAX_AGE_MS", "PUSH_POLICY_PATH",
  "SUBSTRATE_REPO_OWNER", "CUTOVER_PRECHECK_SUITE", "MAINTENANCE_LEASE_PATH", "GAP_STORE_ENDPOINT",
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
const MVID = "mitosis-2026-10-26T00-00-00-000Z";
const CHECK = "test/checks/radiation-shelf-setup-jot.check.ts";
const CHECK_SRC = `import { expect, test } from "bun:test";\ntest("java shelf setup jots the radiation reading", () => { expect(1).toBe(2); });\n`;
const SITE = "src/resolvers/shelf.ts";
const SITE_AT_B = "// shelf module\nexport const radiation = 1;\n";
const SITE_STAGED = "// shelf module\nexport const radiation = 2;\n";
/** What the pre-cutover suite answers: nothing measured (refused) or a passing run (lands). */
let precheck: string = BUN_NO_TESTS;

const sha12 = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 12);
/** The base each staged file was built on: "" for a new file (the net-new freshness assertion), else B's content. */
const baseOf = (rel: string): string => (rel === SITE ? SITE_AT_B : "");

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}
function gitIdentity(cwd: string): void {
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "commit.gpgsign", "false");
}
async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), content);
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-clean-clone-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  process.env["MITOSIS_DIRECT_PUSH"] = "1";
  process.env["MITOSIS_RUNTIME_DIR"] = join(ws, "runtime");
  process.env["MITOSIS_PUSH_CLONE_DIR"] = join(ws, "git", "vessels");
  const fail = (what: string) => async () => { throw new Error(`${what} must not be reached from this test`); };
  __setOwnCheckDepsForTests({
    readGap: async () => ({ shape: "substrateGap", body: { gaps: [] } }),
    writeGap: fail("gap write"),
    runSuite: fail("test_suite run"),
  });
  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  execGuard = installCutoverExecGuard();
  execGuard.route({ name: "attempt-check-unit", match: (c) => /systemctl show \S+ -p LoadState --value/.test(c), respond: () => ({ exitCode: 1, stdout: "" }) });
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
  precheck = BUN_NO_TESTS;
  // Pre-cutover: the answer under test. After the cutover's own commit: no summary, so no post-land baseline is written.
  routeShell(guard, () => {
    const r = spawnSync("git", ["log", "-1", "--format=%s"], { cwd: join(ws, "git", "vessels", VESSEL), encoding: "utf8" });
    if (String(r.stdout).startsWith("substrate-authored")) return BUN_NO_TESTS;
    return precheck;
  });
});

afterEach(async () => {
  const violations = guard.restore();
  const fsViolations = fsGuard.restore();
  const execViolations = execGuard.restore();
  __setOwnCheckDepsForTests(null);
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await rm(ws, { recursive: true, force: true });
  expect(violations).toEqual([]);
  expect(fsViolations).toEqual([]);
  expect(execViolations).toEqual([]);
});

/** A bare origin at B, the push clone of it, the runtime tree at B, and a staged mitosis of `files`. */
async function setup(files: Record<string, string>) {
  const origin = join(ws, "origin.git");
  git(ws, "init", "--bare", "-b", "dev", origin);
  const seed = join(ws, "seed");
  await put(seed, SITE, SITE_AT_B);
  git(ws, "init", "-b", "dev", seed);
  gitIdentity(seed);
  git(seed, "add", ".");
  git(seed, "commit", "-m", "B: base");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-u", "origin", "dev");
  const shaB = git(seed, "rev-parse", "HEAD");
  const clone = join(ws, "git", "vessels", VESSEL);
  await mkdir(join(ws, "git", "vessels"), { recursive: true });
  git(ws, "clone", "-q", "-b", "dev", origin, clone);
  gitIdentity(clone);
  await put(join(ws, "runtime", VESSEL), SITE, SITE_AT_B);
  const mitosisRoot = join(ws, "vessels", `${VESSEL}-${MVID}`);
  for (const [rel, content] of Object.entries(files)) await put(mitosisRoot, rel, content);
  const staged = Object.keys(files);
  const pointer = {
    type: "vessel_mitosis_cutover" as const,
    vessel_name: VESSEL,
    base_version_id: "v1",
    mitosis_version_id: MVID,
    mitosis_root: mitosisRoot,
    staged_files: staged,
    staged_base_sha: sha12(baseOf(staged[0]!)),
    staged_base_shas: Object.fromEntries(staged.map((f) => [f, sha12(baseOf(f))])),
    pending_pointer_path: join(ws, "mitosis-pending.json"),
    applied_log_path: join(ws, "mitosis-applied.jsonl"),
    evaluation_evidence: { verdict: "FAVORABLE", verdict_reason: "static_checks_pass", base_success_rate: 1, mitosis_success_rate: 1, cited_trace_ids: [], cited_check_names: ["bun run typecheck"] },
    adhoc: true,
    skip_push: true,
    skip_restart: true,
  };
  return { clone, shaB, pointer };
}

describe("a refused landing leaves no staged file behind in the push clone", () => {
  it("[MUST-FAIL] a refused check-only landing leaves no untracked test/checks file in the clone", async () => {
    const s = await setup({ [CHECK]: CHECK_SRC });
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    const body = (r.body ?? {}) as Record<string, unknown>;
    expect(body["refused"]).toBe(true);
    expect(String(body["refuse_class"] ?? "")).toMatch(/^pre_cutover_suite_/);
    expect(git(s.clone, "rev-parse", "HEAD")).toBe(s.shaB);
    expect({ untracked_check_left: existsSync(join(s.clone, CHECK)), status: git(s.clone, "status", "--porcelain", "--untracked-files=all") })
      .toEqual({ untracked_check_left: false, status: "" });
  });

  it("[MUST-FAIL] a refused landing of a check and a tracked site edit restores the site to HEAD and drops the check", async () => {
    const s = await setup({ [CHECK]: CHECK_SRC, [SITE]: SITE_STAGED });
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    const body = (r.body ?? {}) as Record<string, unknown>;
    expect(body["refused"]).toBe(true);
    expect(String(body["refuse_class"] ?? "")).toMatch(/^pre_cutover_suite_/);
    expect(git(s.clone, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git(s.clone, "show", `HEAD:${SITE}`) + "\n").toBe(SITE_AT_B);
  });

  it("[CONTROL] a landing that proceeds still commits the check (the cleanup runs only on a refusal)", async () => {
    precheck = BUN_PASSING;
    const s = await setup({ [CHECK]: CHECK_SRC });
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(git(s.clone, "rev-parse", "HEAD~1")).toBe(s.shaB);
    expect(git(s.clone, "show", `HEAD:${CHECK}`) + "\n").toBe(CHECK_SRC);
  });
});
