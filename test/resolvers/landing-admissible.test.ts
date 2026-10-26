// ONE LANDING RULE FOR EVERY ROUTE (gap a-mitosis-cutover-landing-bypasses-its-gaps-red-own-check-and-operator-hold;
// user ruling 2026-10-16T23:59:15Z "Before RUN 2"). Substrate-authored 9ab61e0 (light-dispatch, 10-02) landed an
// auth-only fix through apply_proposal_as_patch + vessel_mitosis_cutover although the gap family carried an operator
// ORDERING hold forbidding exactly that change. Both landing routes end in resolveVesselMitosisCutover, which now applies
// landingAdmissible at cutover time: a hold on the gap or any family member (parent_gap_id chain, duplicate_of) refuses;
// an own check already GREEN on the parent tree refuses; a gap with no own check is admitted and says so.
// Driven through the REAL cutover against a temp clone (the harness of staged-mitosis-own-check.test.ts, copied).
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import * as gateMod from "../../src/resolvers/staged-mitosis-gate.js";
// Namespace import: on a tree without the rule the cutover cases still RUN (and show red); only the unit cases need it.
const familyHold = (gateMod as unknown as { familyHold: (...a: unknown[]) => Promise<unknown> }).familyHold;
const landingAdmissible = (gateMod as unknown as { landingAdmissible: (...a: unknown[]) => { ok: boolean; refuse_class?: string; reason?: string } }).landingAdmissible;
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { installCutoverFetchGuard, routeFleetUnreachable, routeShell, BUN_PASSING, BUN_NO_TESTS, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

const { resolveVesselMitosisCutover } = cutoverMod;
type Deps = { readGap?: (p: Record<string, unknown>) => Promise<unknown>; writeGap?: (p: Record<string, unknown>) => Promise<unknown>; runSuite?: (p: Record<string, unknown>) => Promise<unknown> };
// The parent run (base_ref "HEAD") answers RED by default (a check-first gap is red before its change); a test that
// needs the parent GREEN says so. On a tree without the rule the parent is never run and these stubs are inert.
const RED_ON_PARENT = { shape: "test_suite", body: { ran: true, total: 1, pass: 0, fail: 1, skip: 0, requested_not_passing: 1, failingTests: ["(parent)"] } };
let parentRuns = 0;
const setDeps = (d: Deps | null, opt: { parentGreen?: boolean; hostRoot?: string } = {}): void => {
  const run = d?.runSuite;
  const wrapped: Deps | null = d && run ? { ...d, runSuite: async (p) => {
    if (!p["base_ref"]) return run(p);
    parentRuns++;
    // A real base_ref run reports its own worktree as verified_root (never the staged clone).
    const root = { verified_root: "/tmp/test-suite-base-fixture" };
    return opt.parentGreen ? { shape: "test_suite", body: { ...root, ran: true, total: 1, pass: 1, fail: 0, skip: 0, requested_not_passing: 0, failingTests: [] } } : { ...RED_ON_PARENT, body: { ...RED_ON_PARENT.body, ...root } };
  } } : d;
  (cutoverMod as unknown as { __setOwnCheckDepsForTests?: (d: Deps | null) => void }).__setOwnCheckDepsForTests?.(wrapped);
};

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
] as const;
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
/** Pre-cutover suite runs: shell calls made while the landing clone still sat at "baseline". */
let precheckRuns = 0;
let currentHost = "";
const headSubjectSync = (repo: string) => spawnSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).stdout.trim();
// Only the PRE-cutover call (landing clone still at its baseline commit) answers ran=true. Once
// the cutover's commit exists, the post-land suite gets a no-summary answer (ran=false): a
// post-land ran=true writes /workspace/post-land-baseline/<vessel>.json (an absolute path), and on
// a substrate node that would replace the real baseline with this fixture's empty failure list.
function measuredPrecheckOnly(): string {
  if (!currentHost || headSubjectSync(currentHost) !== "baseline") return BUN_NO_TESTS;
  precheckRuns++;
  return BUN_PASSING;
}

const VESSEL = "development-vessel";
const GAP = "gap-own-check-target";
const TEST_FILE = "test/resolvers/target.test.ts";
const OWN_TEST = "target > does what the gap asked";
const STAGED = "// patched by substrate\n";
const MVID = "mitosis-2026-10-02T23-30-03-248Z";

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "own-check-cut-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
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
  precheckRuns = 0;
  routeShell(guard, measuredPrecheckOnly);
});

afterEach(async () => {
  const violations = guard.restore();
  const fsViolations = fsGuard.restore();
  const execViolations = execGuard.restore();
  setDeps(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(ws, { recursive: true, force: true });
  for (const r of extraRoots.splice(0)) await rm(r, { recursive: true, force: true });
  expect(violations).toEqual([]);               // last, so a violation never skips the cleanup above
  expect(fsViolations).toEqual([]);
  expect(execViolations).toEqual([]);
});

async function setup(): Promise<{ baseRoot: string; mitosisRoot: string; hostRepoRoot: string; baseSha: string; pendingPath: string }> {
  const reposRoot = join(ws, "git", "super-repo", "repos");
  const baseRoot = join(reposRoot, VESSEL);
  const mitosisRoot = join(ws, "vessels", `${VESSEL}-mitosis-2026-10-02T23-30-03-248Z`);
  await mkdir(join(baseRoot, "src", "resolvers"), { recursive: true });
  await mkdir(join(mitosisRoot, "src", "resolvers"), { recursive: true });
  await writeFile(join(baseRoot, "src", "index.ts"), "// base index\n");
  const live = "// original (live)\n";
  await writeFile(join(baseRoot, "src", "resolvers", "target.ts"), live);
  const baseSha = createHash("sha256").update(live).digest("hex").slice(0, 12);
  await writeFile(join(mitosisRoot, "src", "resolvers", "target.ts"), STAGED);
  const hostRepoRoot = join(ws, "host-repo");
  currentHost = hostRepoRoot;
  await mkdir(join(hostRepoRoot, "src", "resolvers"), { recursive: true });
  await writeFile(join(hostRepoRoot, "src", "resolvers", "target.ts"), "// original\n");
  spawnSync("git", ["init", "-b", "dev"], { cwd: hostRepoRoot });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: hostRepoRoot });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: hostRepoRoot });
  spawnSync("git", ["add", "."], { cwd: hostRepoRoot });
  spawnSync("git", ["commit", "-m", "baseline"], { cwd: hostRepoRoot });
  const originRoot = join(ws, "host-origin.git");
  spawnSync("git", ["init", "--bare", "-b", "dev", originRoot]);
  spawnSync("git", ["remote", "add", "origin", originRoot], { cwd: hostRepoRoot });
  spawnSync("git", ["push", "-u", "origin", "dev"], { cwd: hostRepoRoot });
  // What patch_with_tools leaves behind: the shared queue lock naming this mitosis and its gap.
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
      staged_files: ["src/resolvers/target.ts"],
    }, null, 2),
  );
  return { baseRoot, mitosisRoot, hostRepoRoot, baseSha, pendingPath };
}

/** A second, independent fixture inside one test (fresh workspace root; the first is cleaned by afterEach too). */
async function setup2() {
  const prev = ws;
  ws = await mkdtemp(join(tmpdir(), "own-check-cut2-"));
  process.env["WORKSPACE_ROOT"] = ws;
  extraRoots.push(prev);
  return setup();
}
const extraRoots: string[] = [];

/** The pointer mitosis-tick builds for the deferred cutover: a static-only FAVORABLE citing typecheck alone. */
function deferredPointer(s: { baseRoot: string; mitosisRoot: string; hostRepoRoot: string; baseSha: string; pendingPath: string }) {
  return {
    type: "vessel_mitosis_cutover" as const,
    vessel_name: VESSEL,
    base_version_id: "v1",
    mitosis_version_id: MVID,
    mitosis_root: s.mitosisRoot,
    base_root: s.baseRoot,
    host_repo_root: s.hostRepoRoot,
    staged_base_sha: s.baseSha,
    staged_files: ["src/resolvers/target.ts"],
    proposal_id: GAP,
    gap_id: GAP,
    pending_pointer_path: s.pendingPath,
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
}

const gapRow = {
  id: GAP,
  status: "open",
  category: "missing_capability",
  summary: "target does what the gap asked",
  classification_metadata: {
    falsifier: { class: "class2" },
    edit_site: `repos/${VESSEL}/src/resolvers/target.ts`,
    evidence_resolve: {
      shape: "test_suite",
      input: { vessel: `repos/${VESSEL}`, test_file: TEST_FILE, only_tests: [OWN_TEST] },
      zero_field: "requested_not_passing",
    },
  },
};
const readGap = async (p: Record<string, unknown>) =>
  ({ shape: "substrateGap", body: { gaps: p["id"] === GAP ? [gapRow] : [] } });

function suiteBody(hostRepoRoot: string, over: Record<string, unknown>) {
  return { shape: "test_suite", body: { vessel: `repos/${VESSEL}`, verified_root: hostRepoRoot, ran: true, total: 1, pass: 1, fail: 0, skip: 0, requested_not_passing: 0, failingTests: [], ...over } };
}

async function headSubject(repo: string): Promise<string> {
  return spawnSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).stdout.trim();
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}


// A gap store of fixture rows; writes are recorded (a refusal's reason code lands on the gap row).
function store(rows: Array<Record<string, unknown>>) {
  const byId = new Map(rows.map((r) => [String(r["id"]), r]));
  const writes: Array<Record<string, unknown>> = [];
  return {
    writes,
    readGap: async (p: Record<string, unknown>) => ({ shape: "substrateGap", body: { gaps: byId.has(String(p["id"])) ? [byId.get(String(p["id"]))!] : [] } }),
    writeGap: async (p: Record<string, unknown>) => { writes.push(p["gap"] as Record<string, unknown>); return { shape: "substrateGapWriteResult", body: { action: "updated" } }; },
  };
}
const withMeta = (row: Record<string, unknown>, extra: Record<string, unknown>) => ({ ...row, classification_metadata: { ...(row["classification_metadata"] as Record<string, unknown>), ...extra } });
const HOLD = { operator_hold: true, operator_hold_reason: "ORDERING: an auth-only fix must not land before the criterion fix" };
const refused = (r: { shape?: string; body?: unknown }) => (r.body as Record<string, unknown>)["refuse_class"];
const fcPointer = (s: Awaited<ReturnType<typeof setup>>) => ({ ...deferredPointer(s), authored_by: "feature_compose" });

describe("the cutover refuses what the family's hold forbids, on both routes", () => {
  it("[MUST-FAIL] the 9ab61e0 class: a HELD gap through apply -> patch_with_tools -> mitosis is refused, with its reason code on the trace and the gap", async () => {
    const s = await setup();
    const st = store([withMeta(gapRow, HOLD)]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    expect(refused(r)).toBe("landing_hold");
    expect(await headSubject(s.hostRepoRoot)).toBe("baseline");
    const ops = ((r.body as Record<string, unknown>)["operations"] as Array<Record<string, unknown>>);
    expect(ops.some((o) => o["op"] === "landing_admissible" && o["status"] === "fail")).toBe(true);
    expect(st.writes.some((w) => ((w["classification_metadata"] as Record<string, unknown>)?.["landing_refusal"] as Record<string, unknown>)?.["class"] === "hold")).toBe(true);
  });

  it("[MUST-FAIL] the same held gap through the feature_compose route is refused", async () => {
    const s = await setup();
    const st = store([withMeta(gapRow, HOLD)]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    expect(refused(await resolveVesselMitosisCutover(fcPointer(s) as never))).toBe("landing_hold");
  });

  it("[MUST-FAIL] a child whose PARENT is held is refused (family_hold)", async () => {
    const s = await setup();
    const st = store([withMeta(gapRow, { parent_gap_id: "the-parent" }), { id: "the-parent", status: "open", summary: "p", classification_metadata: HOLD }]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    expect(refused(await resolveVesselMitosisCutover(deferredPointer(s) as never))).toBe("landing_family_hold");
  });

  it("[MUST-FAIL] a duplicate_of a held gap is refused (family_hold)", async () => {
    const s = await setup();
    const st = store([withMeta(gapRow, { duplicate_of: "the-original" }), { id: "the-original", status: "open", summary: "o", classification_metadata: HOLD }]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    expect(refused(await resolveVesselMitosisCutover(deferredPointer(s) as never))).toBe("landing_family_hold");
  });

  it("[MUST-FAIL] an own check already GREEN on the parent tree is refused (green_on_parent)", async () => {
    const s = await setup();
    const st = store([gapRow]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) }, { parentGreen: true });
    expect(refused(await resolveVesselMitosisCutover(deferredPointer(s) as never))).toBe("landing_green_on_parent");
    expect(await headSubject(s.hostRepoRoot)).toBe("baseline");
  });

  it("[MUST-FAIL] TOCTOU: a hold set AFTER staging still refuses (read at cutover time, not at staging)", async () => {
    const s = await setup(); // staged above, with no hold anywhere
    const rows = [gapRow as Record<string, unknown>];
    const st = store(rows);
    rows[0] = withMeta(gapRow, HOLD); // the hold arrives between staging and cutover
    const late = store(rows);
    setDeps({ readGap: late.readGap, writeGap: st.writeGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    expect(refused(await resolveVesselMitosisCutover(deferredPointer(s) as never))).toBe("landing_hold");
  });
});

describe("the parent run must measure the parent", () => {
  it("[MUST-KEEP] a parent run that reports the STAGED clone as its root is unmeasurable: admitted with a note, never read as green-on-parent", async () => {
    const s = await setup();
    const st = store([gapRow]);
    // every call (candidate and parent alike) answers pass on the staged clone: the parent was not measured
    (cutoverMod as unknown as { __setOwnCheckDepsForTests: (d: Deps | null) => void }).__setOwnCheckDepsForTests({ readGap: st.readGap, writeGap: st.writeGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(JSON.stringify((r.body as Record<string, unknown>)["operations"] ?? [])).toContain("parent run unmeasurable");
  });
});

describe("G5 controls", () => {
  it("[HELD-OUT] an unheld gap whose check is red on the parent and green on the candidate still lands, on both routes", async () => {
    for (const ptr of [deferredPointer, fcPointer] as const) {
      const s = await setup2();
      parentRuns = 0;
      setDeps({ readGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
      const r = await resolveVesselMitosisCutover(ptr(s) as never);
      expect(r.shape).toBe("cutoverApplied");
      expect(parentRuns).toBe(1);
    }
  });

  it("[PARAPHRASE] the same held gap with a reworded summary is still refused (the rule reads the shaped field, never text)", async () => {
    const s = await setup();
    const st = store([{ ...withMeta(gapRow, HOLD), summary: "an entirely different wording; nothing here says hold, ordering or wait" }]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    expect(refused(await resolveVesselMitosisCutover(deferredPointer(s) as never))).toBe("landing_hold");
    // and the converse: hold WORDS in the summary with no shaped hold do not refuse
    const s2 = await setup2();
    const st2 = store([{ ...gapRow, summary: "HOLD: operator_hold ORDERING do not land" }]);
    setDeps({ readGap: st2.readGap, writeGap: st2.writeGap, runSuite: async () => suiteBody(s2.hostRepoRoot, {}) });
    expect((await resolveVesselMitosisCutover(deferredPointer(s2) as never)).shape).toBe("cutoverApplied");
  });

  it("[CONTROL] a gap with NO own check is admitted, and the trace says so (never a blanket refusal)", async () => {
    const s = await setup();
    const st = store([{ ...gapRow, classification_metadata: { falsifier: "none" } }]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    expect(r.shape).toBe("cutoverApplied");
    const ops = ((r.body as Record<string, unknown>)["operations"] as Array<Record<string, unknown>> | undefined) ?? [];
    expect(JSON.stringify(ops)).toContain("admitted: no own check");
  });
});

describe("familyHold: bounded by a visited set, not a depth constant", () => {
  it("[UNIT] a duplicate_of cycle terminates and reports no hold", async () => {
    const st = store([{ id: "a", classification_metadata: { duplicate_of: "b" } }, { id: "b", classification_metadata: { duplicate_of: "a", parent_gap_id: "a" } }]);
    const h = (await familyHold({ id: "a", classification_metadata: { duplicate_of: "b" } }, st.readGap)) as Record<string, unknown>;
    expect("unreadable" in h).toBe(false);
    expect((h as { held: boolean }).held).toBe(false);
    expect((h as { visited: string[] }).visited.sort()).toEqual(["a", "b"]);
  });
  it("[UNIT] a grandparent's hold is found through the chain; landingAdmissible names the holder", async () => {
    const st = store([{ id: "p", classification_metadata: { parent_gap_id: "gp" } }, { id: "gp", classification_metadata: HOLD }]);
    const h = await familyHold({ id: "c", classification_metadata: { parent_gap_id: "p" } }, st.readGap);
    const a = landingAdmissible({ hold: h as never, ownCheck: null });
    expect(a.ok).toBe(false);
    expect(a.refuse_class).toBe("family_hold");
    expect(a.reason ?? "").toContain("gp");
  });
  it("[WIRING] the cutover applies the rule after its own check, and feature_compose lands through the same cutover", () => {
    const cut = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "vessel-mitosis-cutover.ts"), "utf8");
    expect(cut.indexOf("const adm = landingAdmissible(")).toBeGreaterThan(cut.indexOf('countOwnCheck("own_check_passed"'));
    const fc = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "feature-compose.ts"), "utf8");
    expect(fc).toContain("await resolveVesselMitosisCutover({");
  });
});
