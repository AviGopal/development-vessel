// A LANDED REGRESSION IS NOT WRITTEN INTO THE NEXT LANDING'S BASELINE (vessel-mitosis-cutover.ts
// postLandBaselineKeepDecision, development-vessel:post-land-baseline-keep).
//
// Gap: the-post-land-suite-overwrites-its-baseline-with-the-newly-failing-set-so-a-landed-regression-becomes-the-next-
// landings-baseline. The post-land suite wrote its whole failing set as the baseline even when it had just found tests
// newly failing, so the next landing's pre-cutover gate read the regression as standing red. Under variant-1 the written
// set is the failing set less the newly failing names; variant-0 writes as before.
//
// Pinned through the real resolveVesselMitosisCutover behind the fixture shell (harness as
// cutover-precutover-unusable-baseline.test.ts), the baseline file in a temp directory (__setPostLandBaselineDirForTests):
//   MUST-FAIL: v1, a landing that newly breaks a test leaves it out of the baseline it writes, and the decision is pending;
//   MUST-FAIL: the next gate settles it: reached unless the baseline it read is unusable or hides a withheld test still red;
//   CONTROL:   variant-0 writes the whole failing set, as at the parent;
//   CONTROL:   nothing newly failing: the whole failing set is written, no mask read, no decision;
//   CONTROL:   a withheld name that fails once and passes alone on the confirm re-run does not hold the next landing.
//
// Run by cutover-post-land-baseline-keep.test.ts in its own process (runCasesIsolated): a post-land suite that finds a
// test newly failing files a gap, and the gap store's root is the one captured when substrate-gap first loaded.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
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
const { POST_LAND_BASELINE_FORMAT } = cutoverMod;
type Hooks = {
  __setBaselineGateDepsForTests?: (d: { readMasks?: () => unknown[]; postTrace?: (t: Record<string, unknown>) => Promise<number | null>; pendingFile?: string; nowMs?: () => number } | null) => void;
  __setPostLandBaselineDirForTests?: (dir: string | null) => void;
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
  "MAINTENANCE_LEASE_PATH", "GAP_STORE_ENDPOINT", "VESSEL_IDENTITY_KEY_PATH",
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
const GAP = "gap-post-land-baseline-keep-target";
const MVID = "mitosis-2000-01-01T00-00-00-000Z";
const SRC = "src/resolvers/target.ts";
// 27 standing failures (more than the old cap of 25), and one more that only a regression adds.

const ACTIVITY = "development-vessel:post-land-baseline-keep";
const NAMES = Array.from({ length: 3 }, (_, i) => `the tide clock > chime ${i + 1} rings late`);
const EXTRA = "the tide clock > a new failure the staged change brings";
const out = (names: string[]): string =>
  `bun test v1.3.14 (0d9b296a)\n\ntest/resolvers/tide.test.ts:\n(pass) ok [0.06ms]\n${names.map((n) => `(fail) ${n} [0.20ms]`).join("\n")}\n\n 1 pass\n ${names.length} fail\n ${names.length + 1} expect() calls\nRan ${names.length + 1} tests across 1 file. [11.00ms]\n`;

let currentHost = "";
let staged: string[] = [];
let parent: string[] | null = [];      // null: the base-tree run measures nothing
let postLand: string[] | null = null;  // null: the post-land suite measures nothing
let confirm: string[] | null = null;   // the isolated confirm re-run's failures (null: as the staged run)
const baseCommands: string[] = [];
function suite(): void {
  routeShell(guard, (command) => {
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return postLand === null ? BUN_NO_TESTS : out(postLand); // post-land call
    if (command.includes("worktree add")) { baseCommands.push(command); return parent === null ? BUN_NO_TESTS : out(parent); }
    if (confirm !== null && command.includes("--test-name-pattern")) return out(confirm);
    return out(staged);
  });
}
const lines = (names: string[]): string[] => names.map((n) => `(fail) ${n}`);
let maskReads = 0;
let traces: Record<string, unknown>[] = [];
let logs: string[] = [];
let origLog: typeof console.log;
function mask(variant: number | null): void {
  hooks.__setBaselineGateDepsForTests?.({
    readMasks: () => { maskReads += 1; return variant === null ? [] : [{ id: "mask-test", body: { activity_id: ACTIVITY, active_variant: variant, from: "2000-01-01T00:00:00.000Z", until: "2099-01-01T00:00:00.000Z", by: "test", reason: "test" } }]; },
    postTrace: async (t) => { traces.push(t); return 200; },
    pendingFile: join(ws, "plk-pending.json"),
  });
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-post-land-baseline-keep-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  // No identity key: the default path is the live node's key, which the preload guard refuses to read.
  process.env["VESSEL_IDENTITY_KEY_PATH"] = join(ws, "no-identity-key.pem");
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  currentHost = "";
  staged = [];
  parent = [];
  postLand = null;
  confirm = null;
  baseCommands.length = 0;
  maskReads = 0;
  traces = [];
  logs = [];
  origLog = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); origLog(...a); };
  hooks.__setPostLandBaselineDirForTests?.(join(ws, "post-land-baseline"));
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
  hooks.__setBaselineGateDepsForTests?.(null);
  hooks.__setPostLandBaselineDirForTests?.(null);
  console.log = origLog;
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

/** The decision's own assertions run only where it exists; at the parent each control's core claim is still checked. */
const hasKeep = typeof (cutoverMod as Record<string, unknown>)["postLandBaselineKeepDecision"] === "function";
const decisionLines = () => logs.filter((l) => l.startsWith(`[${ACTIVITY}] decision=`));
const settledLines = () => logs.filter((l) => l.startsWith(`[${ACTIVITY}] settled `));
const baseDir = () => join(ws, "post-land-baseline");
async function putBaseline(names: string[]): Promise<void> {
  await mkdir(baseDir(), { recursive: true });
  await writeFile(join(baseDir(), `${VESSEL}.json`), JSON.stringify({ format: POST_LAND_BASELINE_FORMAT, failing: names }));
}
const written = async (): Promise<string[]> => (JSON.parse(await readFile(join(baseDir(), `${VESSEL}.json`), "utf8")) as { failing: string[] }).failing;
const pending = async (): Promise<Array<{ traceId: string; withheld: string[]; variant: number }>> => {
  try { return JSON.parse(await readFile(join(ws, "plk-pending.json"), "utf8")); } catch { return []; }
};

describe("cutover: the post-land baseline after a landing that newly breaks a test", () => {
  it("MUST-FAIL: v1 leaves the newly failing test out of the baseline it writes, and the decision is pending", async () => {
    const s = await setup(SRC);
    suite();
    mask(1);
    await putBaseline(lines(NAMES));
    staged = [...NAMES];
    postLand = [EXTRA, ...NAMES];
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(await written()).toEqual(lines(NAMES));
    expect(decisionLines()).toHaveLength(1);
    expect(decisionLines()[0]).toContain("kept 1 newly failing out of the baseline");
    const p = await pending();
    expect(p).toHaveLength(1);
    expect(p[0]!.withheld).toEqual(lines([EXTRA]));
    expect(traces.some((t) => t["activity_id"] === `${ACTIVITY}-v1`)).toBe(true);
  });

  it("CONTROL: variant-0 writes the whole failing set, as at the parent", async () => {
    const s = await setup(SRC);
    suite();
    mask(null);
    await putBaseline(lines(NAMES));
    staged = [...NAMES];
    postLand = [EXTRA, ...NAMES];
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(r.shape).toBe("cutoverApplied");
    if (!hooks.__setPostLandBaselineDirForTests) return; // the parent writes the literal path, which the fs guard blocks
    expect(await written()).toEqual(lines([EXTRA, ...NAMES]));
    if (!hasKeep) return;
    expect(decisionLines()[0]).toContain("would keep the newly failing out (variant-0: written as before)");
    expect(traces).toHaveLength(0);
  });

  it("CONTROL: nothing newly failing: the whole failing set is written, no mask read, no decision", async () => {
    const s = await setup(SRC);
    suite();
    mask(1);
    await putBaseline(lines(NAMES));
    staged = [...NAMES];
    postLand = [...NAMES];
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(r.shape).toBe("cutoverApplied");
    if (!hooks.__setPostLandBaselineDirForTests) return;
    expect(await written()).toEqual(lines(NAMES));
    expect(maskReads).toBe(0);
    expect(decisionLines()).toHaveLength(0);
  });

  it("CONTROL: a withheld name that fails once and passes alone on the confirm re-run does not hold the next landing", async () => {
    const s = await setup(SRC);
    suite();
    mask(1);
    await putBaseline(lines(NAMES));            // as variant-1 wrote it: EXTRA left out
    await writeFile(join(ws, "plk-pending.json"), JSON.stringify([{ traceId: "post-land-baseline-keep-x-1", vessel: VESSEL, variant: 1, withheld: lines([EXTRA]), decidedAtMs: Date.now() - 60_000, landedSha: "abc" }]));
    staged = [EXTRA, ...NAMES];                   // the whole-suite run: EXTRA flakes
    confirm = [];                                 // alone, it passes
    postLand = [...NAMES];
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).not.toBe("precutover_regression");
    expect(r.shape).toBe("cutoverApplied");
    expect(headSubject(s)).not.toBe("baseline");
    if (!hasKeep) return;
    expect(settledLines()).toHaveLength(1);
    expect(settledLines()[0]).toContain("reached=true");
  });
});

describe("settlePostLandBaselineKeep: the next pre-cutover gate grades the decision", () => {
  const row = (variant: number, ageMs: number) => ({ traceId: `post-land-baseline-keep-x-${variant}-${ageMs}`, vessel: VESSEL, variant, withheld: [`(fail) ${EXTRA}`], decidedAtMs: Date.now() - ageMs, landedSha: "abc" });
  async function settle(rows: unknown[], a: { unusable: string | null; failNow: string[]; baseline: string[] | null }): Promise<void> {
    await writeFile(join(ws, "plk-pending.json"), JSON.stringify(rows));
    cutoverMod.settlePostLandBaselineKeep(VESSEL, a);
  }
  it("MUST-FAIL: a withheld test still red and hidden by the baseline is not reached (variant-0's case)", async () => {
    mask(null);
    await settle([row(0, 60_000)], { unusable: null, failNow: lines([EXTRA, ...NAMES]), baseline: lines([EXTRA, ...NAMES]) });
    expect(settledLines()[0]).toContain("reached=false");
    expect(settledLines()[0]).toContain("hidden=1");
    expect(traces).toHaveLength(0);
    expect(await pending()).toHaveLength(0);
  });
  it("MUST-FAIL: under variant-1 a withheld test still red but not hidden is reached, as a credit trace", async () => {
    mask(1);
    await settle([row(1, 60_000)], { unusable: null, failNow: lines([EXTRA, ...NAMES]), baseline: lines(NAMES) });
    expect(settledLines()[0]).toContain("reached=true");
    const credit = traces.find((t) => t["activity_id"] === `${ACTIVITY}-credit`);
    expect(credit!["tags"] as string[]).toContain("reached:true");
    expect(credit!["composition_chain"]).toEqual([`post-land-baseline-keep-x-1-60000`]);
  });
  it("MUST-FAIL: an unusable baseline is not reached; past 72 h the decision is ungraded; another vessel's row stays pending", async () => {
    mask(1);
    const other = { ...row(1, 60_000), traceId: "post-land-baseline-keep-other", vessel: "boredom-vessel" };
    await settle([row(1, 60_000), row(1, 73 * 3_600_000), other], { unusable: "stale (age=30.0h > 24h)", failNow: [], baseline: null });
    expect(settledLines()).toHaveLength(1);
    expect(settledLines()[0]).toContain("reached=false");
    expect(logs.some((l) => l.includes("ungraded post-land-baseline-keep-x-1-") && l.includes("within 72 h"))).toBe(true);
    expect((await pending()).map((p) => p.traceId)).toEqual(["post-land-baseline-keep-other"]);
  });
  it("MUST-FAIL: postLandBaselineToWrite leaves the newly failing out under variant-1 only, and the decision never decides its own reach", () => {
    expect(cutoverMod.postLandBaselineToWrite(["a", "b", "c"], ["b"], 1)).toEqual(["a", "c"]);
    expect(cutoverMod.postLandBaselineToWrite(["a", "b", "c"], ["b"], 0)).toEqual(["a", "b", "c"]);
    expect(String(cutoverMod.postLandBaselineKeepDecision)).not.toContain("reached");
  });
});
