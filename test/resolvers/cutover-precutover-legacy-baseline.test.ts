// A LEGACY (CAPPED) POST-LAND BASELINE IS RE-MEASURED AT THE PARENT, NOT TRUSTED (vessel-mitosis-cutover.ts
// parsePostLandBaseline, 2026-10-26).
//
// Gap: until test-suite.ts reported the whole failing set, the post-land writer stored a bare list capped at 25 names.
// Such a file stays in use for up to BASELINE_MAX_AGE_MS (24 h) or until the vessel's next landing rewrites it, and a
// SOURCE staging (so not the check-only parent re-run) on a vessel failing more than 25 tests reads the names past its
// cap as newly failing and is refused. The writer now stamps { format: POST_LAND_BASELINE_FORMAT, failing }; a bare
// list is legacy, and for a staging judged against one the confirmed names are re-run on the parent (base_ref HEAD) at
// the same tick, dropping those red there too.
//
// Pinned through the real resolveVesselMitosisCutover and resolveTestSuite behind the fixture shell (harness as
// cutover-precutover-baseline-full-set.test.ts); the baseline file's TEXT through __setPrecutoverBaselineTextForTests:
//   MUST-FAIL: a 25-name legacy list, 27 failing at base and staged, a no-op src staging -> not refused;
//   CONTROL:   a current-format baseline is used as is (no parent run), and a real new failure is refused;
//   CONTROL:   against a legacy list, a new failure green at the parent is still refused.
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
const { parsePostLandBaseline, POST_LAND_BASELINE_FORMAT } = cutoverMod;
type Hooks = {
  __setPrecutoverBaselineTextForTests?: (f: ((v: string) => Promise<string | null>) | null) => void;
  __setPrecutoverBaselineForTests: (f: ((v: string) => Promise<string[] | null>) | null) => void;
};
const hooks = cutoverMod as unknown as Hooks;
/** The baseline FILE's text. Where the text seam exists the gate parses it as it parses the live file; where it does not
 *  (a tree before the format marker), the gate read the file's JSON as the list itself, which the list seam stands in for. */
function setBaselineText(f: ((v: string) => Promise<string | null>) | null): void {
  if (hooks.__setPrecutoverBaselineTextForTests) { hooks.__setPrecutoverBaselineTextForTests(f); return; }
  hooks.__setPrecutoverBaselineForTests(f === null ? null : async (v) => {
    const text = await f(v);
    if (text === null) return null;
    const raw = JSON.parse(text) as unknown;
    return Array.isArray(raw) ? raw.map(String) : ((raw as { failing?: string[] }).failing ?? null);
  });
}

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
const GAP = "gap-precutover-legacy-baseline-target";
const MVID = "mitosis-2026-10-26T00-00-00-000Z";
const SRC = "src/resolvers/target.ts";
// 27 standing failures (more than the old cap of 25), and one more that only a regression adds.
const NAMES = Array.from({ length: 27 }, (_, i) => `the scribe's shack > framing ${String(i + 1).padStart(2, "0")} reads in reverse`);
const EXTRA = "the scribe's shack > a monstrous new failure";
const out = (names: string[]): string =>
  `bun test v1.3.14 (0d9b296a)\n\ntest/resolvers/shack.test.ts:\n(pass) ok [0.06ms]\n${names.map((n) => `(fail) ${n} [0.20ms]`).join("\n")}\n\n 1 pass\n ${names.length} fail\n ${names.length + 1} expect() calls\nRan ${names.length + 1} tests across 1 file. [11.00ms]\n`;

let currentHost = "";
let staged: string[] = [];
let parent: string[] = [];
const baseCommands: string[] = [];
function suite(): void {
  routeShell(guard, (command) => {
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return BUN_NO_TESTS; // post-land call
    if (command.includes("worktree add")) { baseCommands.push(command); return out(parent); }
    return out(staged);
  });
}
const lines = (names: string[]): string[] => names.map((n) => `(fail) ${n}`);

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-precutover-legacy-baseline-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  currentHost = "";
  staged = [];
  parent = [];
  baseCommands.length = 0;
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
  setBaselineText(null);
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

describe("parsePostLandBaseline", () => {
  it("reads a bare list as legacy, the stamped format as current, and anything else as no baseline", () => {
    expect(parsePostLandBaseline(["(fail) a"])).toEqual({ names: ["(fail) a"], legacy: true });
    expect(parsePostLandBaseline({ format: POST_LAND_BASELINE_FORMAT, failing: ["(fail) a"] })).toEqual({ names: ["(fail) a"], legacy: false });
    expect(parsePostLandBaseline({ format: 1, failing: ["(fail) a"] })).toBeNull();
    expect(parsePostLandBaseline({ failing: ["(fail) a"] })).toBeNull();
    expect(parsePostLandBaseline(null)).toBeNull();
  });
});

describe("cutover: a legacy (capped) post-land baseline is re-measured at the parent", () => {
  it("MUST-FAIL: a 25-name legacy list, 27 failing at base and staged, and a no-op src staging is not refused", async () => {
    const s = await setup(SRC);
    suite();
    setBaselineText(async () => JSON.stringify(lines(NAMES.slice(0, 25))));   // what the capped writer stored
    staged = [...NAMES].reverse();
    parent = [...NAMES];
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).not.toBe("precutover_regression");
    expect(r.shape).toBe("cutoverApplied");
    expect(headSubject(s)).not.toBe("baseline");
    expect(baseCommands.length).toBe(1);
  });

  it("CONTROL: a current-format baseline is used as is (no parent run), and a real new failure is refused", async () => {
    const s = await setup(SRC);
    suite();
    setBaselineText(async () => JSON.stringify({ format: POST_LAND_BASELINE_FORMAT, failing: lines(NAMES) }));
    staged = [EXTRA, ...NAMES];
    parent = [...NAMES];
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).toBe("precutover_regression");
    expect(bodyOf(r)["newly_failing"] as string[]).toContain(`(fail) ${EXTRA}`);
    expect(baseCommands.length).toBe(0);
    expect(headSubject(s)).toBe("baseline");
  });

  it("CONTROL: against a legacy list, a new failure that is green at the parent is still refused", async () => {
    const s = await setup(SRC);
    suite();
    setBaselineText(async () => JSON.stringify(lines(NAMES.slice(0, 25))));
    staged = [EXTRA, ...[...NAMES].reverse()];
    parent = [...NAMES];
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).toBe("precutover_regression");
    expect(bodyOf(r)["newly_failing"] as string[]).toContain(`(fail) ${EXTRA}`);
    expect(headSubject(s)).toBe("baseline");
  });
});
