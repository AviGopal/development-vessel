// NO USABLE POST-LAND BASELINE IS A DECISION: variant-1 MEASURES THE BASE TREE (vessel-mitosis-cutover.ts
// precutoverBaselineBaseTreeDecision, development-vessel:precutover-baseline-base-tree).
//
// Gap: a-system-landing-passes-the-pre-cutover-test-gate-unmeasured-when-the-nodes-post-land-baseline-is-older-than-24h.
// A baseline that is absent, unparseable, empty or older than BASELINE_MAX_AGE_MS reached computeNewlyFailing as
// nothing to compare against, so the gate passed every staged tree unmeasured. Under variant-1 the base tree (base_ref
// HEAD) is run once in the same cutover and its failing set is the baseline; a base run that does not measure refuses an
// undirected landing. Variant-0 judges as before.
//
// Pinned through the real resolveVesselMitosisCutover and resolveTestSuite behind the fixture shell (harness as
// cutover-precutover-legacy-baseline.test.ts); the mask and the traces through __setBaselineGateDepsForTests:
//   MUST-FAIL: v1, no baseline, a new failure green on the base tree is refused (at the parent it lands);
//   MUST-FAIL: v1, a stale (25 h) baseline file is not used; the base tree is measured and the new failure refused;
//   MUST-FAIL: v1, an unmeasurable base run refuses the undirected landing (pre_cutover_baseline_unmeasured);
//   MUST-FAIL: the landing's post-land suite settles the decision (reached when nothing fails outside its baseline);
//   CONTROL:   v1, a clean vessel whose baseline is [] runs the base tree once, finds nothing new, and lands;
//   CONTROL:   v1, a fresh current-format baseline is used as is: no base run, and the mask is not read;
//   CONTROL:   no mask in force (variant-0), no baseline: the new failure lands as at the parent; no trace is posted.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
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
  __setBaselineGateDepsForTests?: (d: { readMasks?: () => unknown[]; postTrace?: (t: Record<string, unknown>) => Promise<number | null> } | null) => void;
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
const GAP = "gap-precutover-unusable-baseline-target";
const MVID = "mitosis-2000-01-01T00-00-00-000Z";
const SRC = "src/resolvers/target.ts";
// 27 standing failures (more than the old cap of 25), and one more that only a regression adds.

const ACTIVITY = "development-vessel:precutover-baseline-base-tree";
const NAMES = Array.from({ length: 3 }, (_, i) => `the tide clock > chime ${i + 1} rings late`);
const EXTRA = "the tide clock > a new failure the staged change brings";
const out = (names: string[]): string =>
  `bun test v1.3.14 (0d9b296a)\n\ntest/resolvers/tide.test.ts:\n(pass) ok [0.06ms]\n${names.map((n) => `(fail) ${n} [0.20ms]`).join("\n")}\n\n 1 pass\n ${names.length} fail\n ${names.length + 1} expect() calls\nRan ${names.length + 1} tests across 1 file. [11.00ms]\n`;

let currentHost = "";
let staged: string[] = [];
let parent: string[] | null = [];      // null: the base-tree run measures nothing
let postLand: string[] | null = null;  // null: the post-land suite measures nothing
const baseCommands: string[] = [];
function suite(): void {
  routeShell(guard, (command) => {
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return postLand === null ? BUN_NO_TESTS : out(postLand); // post-land call
    if (command.includes("worktree add")) { baseCommands.push(command); return parent === null ? BUN_NO_TESTS : out(parent); }
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
  });
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-precutover-unusable-baseline-"));
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

const decisionLines = () => logs.filter((l) => l.startsWith(`[${ACTIVITY}] decision=`));

describe("cutover: with no usable post-land baseline, variant-1 measures the base tree", () => {
  it("MUST-FAIL: v1, no baseline file, a new failure green on the base tree is refused", async () => {
    const s = await setup(SRC);
    suite();
    mask(1);
    setBaselineText(async () => null);
    staged = [EXTRA];
    parent = [];
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).toBe("precutover_regression");
    expect(bodyOf(r)["newly_failing"] as string[]).toContain(`(fail) ${EXTRA}`);
    expect(baseCommands.length).toBe(1);
    expect(headSubject(s)).toBe("baseline");
    expect(decisionLines()).toHaveLength(1);
    expect(decisionLines()[0]).toContain("unusable=absent");
    expect(decisionLines()[0]).toContain("baseline=base_tree_measured");
    expect(logs.some((l) => l.includes("ungraded") && l.includes("refused (precutover_regression)"))).toBe(true);
  });

  it("MUST-FAIL: v1, a stale (25 h) baseline file is not used; the base tree is measured and the new failure refused", async () => {
    const s = await setup(SRC);
    suite();
    mask(1);
    const dir = join(ws, "post-land-baseline");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${VESSEL}.json`);
    await writeFile(file, JSON.stringify({ format: POST_LAND_BASELINE_FORMAT, failing: lines([EXTRA, ...NAMES]) }));
    const old = new Date(Date.now() - 25 * 3_600_000);
    await utimes(file, old, old);
    staged = [EXTRA, ...NAMES];
    parent = [...NAMES];
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).toBe("precutover_regression");
    expect(baseCommands.length).toBe(1);
    expect(decisionLines()[0]).toContain("unusable=stale (age=25.0h > 24h)");
  });

  it("MUST-FAIL: v1, a base run that measures nothing refuses the undirected landing", async () => {
    const s = await setup(SRC);
    suite();
    mask(1);
    setBaselineText(async () => null);
    staged = [EXTRA];
    parent = null;
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).toBe("pre_cutover_baseline_unmeasured");
    expect(bodyOf(r)["baseline_unusable"]).toBe("absent");
    expect(headSubject(s)).toBe("baseline");
    expect(decisionLines()[0]).toContain("baseline=base_tree_unmeasured -> refused");
  });

  it("MUST-FAIL: the landing's post-land suite settles the decision: reached when nothing fails outside its baseline", async () => {
    const s = await setup(SRC);
    suite();
    mask(1);
    setBaselineText(async () => null);
    staged = [...NAMES];
    parent = [...NAMES];
    postLand = [...NAMES];
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(r.shape).toBe("cutoverApplied");
    const credit = traces.find((t) => t["activity_id"] === `${ACTIVITY}-credit`);
    expect(credit).toBeDefined();
    expect(credit!["tags"] as string[]).toContain("reached:true");
    expect((credit!["composition_chain"] as string[])[0]).toBe(String(traces.find((t) => t["activity_id"] === `${ACTIVITY}-v1`)!["execution_id"]));
  });

  it("CONTROL: v1, a clean vessel whose baseline is [] runs the base tree once, finds nothing new, and lands", async () => {
    const s = await setup(SRC);
    suite();
    mask(1);
    setBaselineText(async () => JSON.stringify({ format: POST_LAND_BASELINE_FORMAT, failing: [] }));
    staged = [];
    parent = [];
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["kind"]).not.toBe("precutover_regression");
    expect(r.shape).toBe("cutoverApplied");
    expect(headSubject(s)).not.toBe("baseline");
    if (hooks.__setBaselineGateDepsForTests) {
      expect(baseCommands.length).toBe(1);
      expect(decisionLines()[0]).toContain("unusable=empty");
    }
  });

  it("CONTROL: v1, a fresh current-format baseline is used as is: no base run, and the mask is not read", async () => {
    const s = await setup(SRC);
    suite();
    mask(1);
    setBaselineText(async () => JSON.stringify({ format: POST_LAND_BASELINE_FORMAT, failing: lines(NAMES) }));
    staged = [...NAMES];
    parent = [...NAMES];
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(baseCommands.length).toBe(0);
    expect(maskReads).toBe(0);
    expect(decisionLines()).toHaveLength(0);
  });

  it("CONTROL: no mask in force (variant-0), no baseline: the new failure lands as at the parent", async () => {
    const s = await setup(SRC);
    suite();
    mask(null);
    setBaselineText(async () => null);
    staged = [EXTRA];
    parent = [];
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(baseCommands.length).toBe(0);
    if (hooks.__setBaselineGateDepsForTests) {
      expect(decisionLines()).toHaveLength(1);
      expect(decisionLines()[0]).toContain("would measure the base tree");
      expect(traces).toHaveLength(0);
      expect(logs.some((l) => l.startsWith(`[${ACTIVITY}] ungraded`) || l.startsWith(`[${ACTIVITY}] settled`))).toBe(true);
    }
  });
});

describe("precutoverBaselineBaseTreeDecision", () => {
  it("MUST-FAIL: a directed landing whose base run does not measure keeps the fail-open, named on the decision line", async () => {
    mask(1);
    const d = await cutoverMod.precutoverBaselineBaseTreeDecision({ vessel: VESSEL, unusable: "absent", directed: true, directedWhy: "stamped intent", measureBase: async () => ({ failing: null, ran: false, pass: 0, fail: 0 }) });
    expect(d.used).toBe("base_tree_unmeasured");
    expect(decisionLines()[0]).toContain("directed: fail-open, unmeasured");
    // the refusal at the gate is for undirected landings only
    const src = await Bun.file(new URL("../../src/resolvers/vessel-mitosis-cutover.ts", import.meta.url)).text();
    expect(src).toContain(`else if (pbbDecision.used === "base_tree_unmeasured" && !precutoverOrigin.directed) {`);
  });
  it("MUST-FAIL: an unknown variant, or an unreadable pool, is variant-0 and measures nothing", async () => {
    let measured = 0;
    hooks.__setBaselineGateDepsForTests?.({ readMasks: () => [{ id: "m", body: { activity_id: ACTIVITY, active_variant: 7, from: "2000-01-01T00:00:00.000Z", until: "2099-01-01T00:00:00.000Z" } }], postTrace: async () => 200 });
    expect((await cutoverMod.precutoverBaselineBaseTreeDecision({ vessel: VESSEL, unusable: "absent", directed: false, directedWhy: "", measureBase: async () => { measured += 1; return { failing: [], ran: true, pass: 1, fail: 0 }; } })).variant).toBe(0);
    hooks.__setBaselineGateDepsForTests?.({ readMasks: () => { throw new Error("pool down"); }, postTrace: async () => 200 });
    expect((await cutoverMod.precutoverBaselineBaseTreeDecision({ vessel: VESSEL, unusable: "absent", directed: false, directedWhy: "", measureBase: async () => { measured += 1; return { failing: [], ran: true, pass: 1, fail: 0 }; } })).used).toBe("none");
    expect(measured).toBe(0);
  });
  it("MUST-FAIL: the decision never decides its own reach; only the post-land credit carries a reached tag", () => {
    expect(String(cutoverMod.precutoverBaselineBaseTreeDecision)).not.toContain("reached");
    expect(String(cutoverMod.settlePrecutoverBaselineBaseTree)).toContain("reached:");
  });
  it("MUST-FAIL: newlyFailingVsMeasured treats an empty measured base as a measurement", () => {
    expect(cutoverMod.newlyFailingVsMeasured([], ["(fail) a", "(fail) a"])).toEqual(["(fail) a"]);
    expect(cutoverMod.newlyFailingVsMeasured(["(fail) a"], ["(fail) a", "(fail) b"])).toEqual(["(fail) b"]);
  });
});
