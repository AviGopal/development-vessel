// A LANDING THAT NOTHING MEASURED IS REFUSED, NOT CUT OVER (check-first).
//
// Gap a-landing-with-no-measurement-that-actually-ran-is-cut-over-instead-of-refused.
// General rule: "nothing measured it" must REFUSE, not land. Instance: a commit landed whose gap
// carried no class-2 check (the own-check step stamped it landed_unverified) AND whose
// pre-cutover suite did not run (ran=false). Every instrument abstained, and it still landed:
// step 5d-own lets a check-less gap through as landed_unverified, and the pre-cutover suite gate
// (5d) treats any run without a summary as "could not measure → fail open". On the landing node
// pull-sync's test gate never runs on the cutover's own commit, so this suite is the only
// measurement there.
//
// Expected: a cutover needs at least ONE measurement that actually ran — the gap's own class-2
// check passing, or the pre-cutover suite with ran=true. With none it refuses with
// refuse_class no_measurement_available, commits nothing, and files or bumps a gap saying this
// repo / gap has no instrument. A suite that timed out, was killed, or never started is
// ran=false: no measurement, never a pass.
// A by-effect check is not counted as a measurement; known limitation, out of scope.
//
// PARKING (field contract pinned here). A no-measurement refusal must not wedge the queue:
//   • the pending lock (mitosis-pending.json) is RELEASED by the same call;
//   • the staged patch is ARCHIVED outside mitosis_root, and the no-instrument gap write (through
//     the cutover's gap-write seam, ownCheckDeps.writeGap) cites it as
//       classification_metadata.archived_patch = {
//         gap_id,            // the landing gap
//         original_base,     // the clone's HEAD commit the patch was staged on, or staged_base_sha
//         staged_files,      // the staged relative paths
//         path?: string,     // a directory holding each staged file at its relative path,
//                            //   or a patch file whose text contains the staged content
//         ref?: string,      // or a git ref in the landing clone whose tree holds the staged files
//       }
//     which is what a re-proposal against the CURRENT base needs. The re-proposal itself (when
//     the no-instrument gap closes, the archived patch goes back through the normal compose path,
//     not re-admitted verbatim) lives outside the cutover and is NOT unit-tested here: only the
//     archive record's contents are pinned;
//   • the next tick does not re-refuse the same tree. It is no longer in the queue: the tick's
//     own reader (mitosis_pending_observer) reports has_pending:false, no staged tree for the
//     vessel is left under the staging root, and the cutover the tick then dispatches with the
//     empty pending fields returns its EXPLICIT no-pending result — the one that exists today:
//       { shape: "vesselMitosisCutoverResult", body: { skipped: true, skip_reason: "no_pending_mitosis", cutover_applied: false } }
//     (named outcome; any other answer, an incidental error included, fails). The archived patch
//     is still present and byte-unchanged after that tick.
//
// KILL SWITCH REMOVED (arms with the-precutover-suite-gate-fails-open-and-has-an-env-kill-switch).
// CUTOVER_PRECHECK_SUITE=0 must have no effect. The suite is paused only by a SHAPED hold read at
// dispatch: a maintenanceLease named "precutover_suite" (resolveMaintenanceLease, the same
// lease store the cutover's change_window uses; a named read also sees the unnamed global hold).
// A paused suite did not run, so it is not a measurement.
//
// These drive the REAL resolveVesselMitosisCutover through its git-aware path against a temp
// clone with a bare origin (skip_push, skip_restart). The own check and the gap store go through
// __setOwnCheckDepsForTests. The pre-cutover suite calls the REAL test_suite resolver; only the
// network is stood in, through the shared cutover fetch guard (every unstubbed URL fails the
// test): discovery names a fixture shell that answers with bun 1.3.14's captured output.
// skip_push means no push is ever attempted here, so "does not push" is pinned as "no commit was
// made and the bare origin's dev ref is unchanged".
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
] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let guard: FetchGuard;
let fsGuard: FsGuard;
// Backstop: whatever happened in this file, the next file in the same bun process gets the real
// fs and fetch (bun's mock.restore() does not undo mock.module; see cutover-fs-guard.ts).
afterAll(() => {
  restoreCutoverFsModules();
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
let shellCalls = 0;
let currentHost = "";
// `mode` answers only the PRE-cutover call (landing clone still at its baseline commit). Once
// the cutover's commit exists, the post-land suite gets a no-summary answer (ran=false): a
// post-land ran=true writes /workspace/post-land-baseline/<vessel>.json (an absolute path), and on
// a substrate node that would replace the real baseline with this fixture's empty failure list.
function suite(mode: SuiteMode): void {
  routeShell(guard, () => {
    shellCalls++;
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return BUN_NO_TESTS;
    precheckCalls++;
    if (mode === "dispatch_failed") throw new Error("shell producer connection reset");
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
  // CUTOVER_PRECHECK_SUITE deliberately left unset: the suite step runs.
  writes.length = 0;
  precheckCalls = 0;
  shellCalls = 0;
  currentHost = "";
  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE; // never the module-load-captured store
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
});

afterEach(async () => {
  const violations = guard.restore();
  const fsViolations = fsGuard.restore();
  __setOwnCheckDepsForTests(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(ws, { recursive: true, force: true });
  expect(violations).toEqual([]);
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
  __setOwnCheckDepsForTests({ readGap: readRow(checkedRow), writeGap: recordWrite, runSuite: async () => { n++; return ownCheckBody(s.hostRepoRoot, {}); } });
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

describe("cutover: a landing no instrument measured is refused (no_measurement_available), not cut over", () => {
  it("MUST-FAIL A: no gap check and a pre-cutover suite that did not run (repo with no tests, ran=false) refuses with no_measurement_available, does not push, releases the lock and archives the patch", async () => {
    const s = await setup();
    suite("no_tests");
    const own = noCheck(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    // Positive control on the seam: the pre-cutover suite was really attempted.
    expect(precheckCalls).toBeGreaterThan(0);
    expect(own.ownRuns()).toBe(0);
    await expectRefusedReleasedArchived(s, r);
  });

  it("MUST-FAIL B: no gap check and a pre-cutover suite KILLED by its timeout before the summary refuses — a timeout is ran=false, never a pass", async () => {
    const s = await setup();
    suite("killed");
    noCheck(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(precheckCalls).toBeGreaterThan(0);
    await expectRefusedReleasedArchived(s, r);
  });

  it("MUST-FAIL B': no gap check and a pre-cutover suite that never started (shell dispatch failed) refuses", async () => {
    const s = await setup();
    suite("dispatch_failed");
    noCheck(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(precheckCalls).toBeGreaterThan(0);
    await expectRefusedReleasedArchived(s, r);
  });

  it("MUST-FAIL C: the no-measurement refusal files or bumps a gap saying this repo / gap has no instrument", async () => {
    const s = await setup();
    suite("no_tests");
    noCheck(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["refuse_class"]).toBe("no_measurement_available");
    expect(noInstrumentWrites().length).toBeGreaterThan(0);
  });

  it("MUST-FAIL D (parking a): the no-measurement refusal releases the pending lock in the same call and archives the staged patch outside mitosis_root, cited on the no-instrument gap write", async () => {
    const s = await setup();
    suite("no_tests");
    noCheck(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["refuse_class"]).toBe("no_measurement_available");
    expect(await exists(s.pendingPath)).toBe(false);
    const a = archivedPatchOf(noInstrumentWrites()[0]);
    expect(a).not.toBeNull();
    expect(await archiveHoldsStaged(s, a!)).toBe(true);
  });

  it("MUST-FAIL E (parking b): the archive record carries what a re-proposal against the current base needs — gap id, patch path or ref, original base, staged files", async () => {
    const s = await setup();
    suite("no_tests");
    noCheck(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["refuse_class"]).toBe("no_measurement_available");
    const a = archivedPatchOf(noInstrumentWrites()[0]) ?? {};
    expect(a["gap_id"]).toBe(GAP);
    expect(typeof a["path"] === "string" || typeof a["ref"] === "string").toBe(true);
    expect([s.baseCommit, s.baseSha]).toContain(a["original_base"] as string);
    expect(a["staged_files"]).toEqual([TARGET]);
  });

  it("MUST-FAIL F (parking c): the next tick after a no-measurement refusal sees no pending tree for the vessel and gets the cutover's explicit no_pending_mitosis result; the archived patch is unchanged", async () => {
    const s = await setup();
    suite("no_tests");
    noCheck(s);
    const first = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(first)["refuse_class"]).toBe("no_measurement_available");
    const bumps = noInstrumentWrites().length;
    const archived = archivedPatchOf(noInstrumentWrites()[0]);
    expect(archived).not.toBeNull();
    const archiveBefore = await archiveSnapshot(s, archived!);
    expect(archiveBefore).not.toBeNull();

    // The next tick, as mitosis-tick runs it: read the queue through its own reader...
    const obs = (await resolveMitosisPendingObserver({ type: "mitosis_pending_observer", workspaceRoot: ws })).body as { has_pending: boolean; pending: Record<string, string | null> | null };
    expect(obs.has_pending).toBe(false);
    // ...no staged tree for this vessel is left where the tick and the hygiene observers look...
    let staged: string[] = [];
    try { staged = (await readdir(join(ws, "vessels"))).filter((d) => d.startsWith(`${VESSEL}-`)); } catch { staged = []; }
    expect(staged).toEqual([]);
    // ...and the cutover it dispatches with the (empty) pending fields answers its named no-pending result.
    const p = obs.pending ?? {};
    const next = await resolveVesselMitosisCutover({
      ...s.pointer,
      vessel_name: p["vessel_name"] ?? "",
      base_version_id: p["base_version_id"] ?? "",
      mitosis_version_id: p["mitosis_version_id"] ?? "",
      mitosis_root: p["mitosis_root"] ?? "",
    } as never);
    expect({ shape: next.shape, skipped: bodyOf(next)["skipped"], skip_reason: bodyOf(next)["skip_reason"] })
      .toEqual({ shape: "vesselMitosisCutoverResult", skipped: true, skip_reason: "no_pending_mitosis" });
    expect(noInstrumentWrites().length).toBe(bumps);
    expect(headSubject(s)).toBe("baseline");
    expect(await archiveSnapshot(s, archived!)).toEqual(archiveBefore);
  });

  it("CONTROL 1: the gap's own check ran and PASSED → lands, even though the pre-cutover suite did not run", async () => {
    const s = await setup();
    suite("no_tests");
    const own = ownCheckPasses(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(String(bodyOf(r)["refusal_reason"] ?? "")).toBe("");
    expect(r.shape).toBe("cutoverApplied");
    expect(own.ownRuns()).toBe(1);
    expect(bodyOf(r)["own_check_verified"]).toBe(true);
    expect(headSubject(s)).not.toBe("baseline");
    expect(git(s.hostRepoRoot, "show", `HEAD:${TARGET}`) + "\n").toBe(STAGED);
  });

  it("CONTROL 2: no gap check, but the pre-cutover suite RAN (ran=true, no new failures) → lands; the suite is a measurement", async () => {
    const s = await setup();
    suite("passing");
    noCheck(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(String(bodyOf(r)["refusal_reason"] ?? "")).toBe("");
    expect(r.shape).toBe("cutoverApplied");
    expect(precheckCalls).toBeGreaterThan(0);
    expect(headSubject(s)).not.toBe("baseline");
    expect(git(s.hostRepoRoot, "show", `HEAD:${TARGET}`) + "\n").toBe(STAGED);
  });

  it("CONTROL 3: the gap's own check ran and FAILED → refused as own_check_failed, distinguishable from no_measurement_available", async () => {
    const s = await setup();
    suite("no_tests");
    __setOwnCheckDepsForTests({
      readGap: readRow(checkedRow),
      writeGap: recordWrite,
      runSuite: async () => ownCheckBody(s.hostRepoRoot, { pass: 0, fail: 1, requested_not_passing: 1, failingTests: [`(fail) ${OWN_TEST}`] }),
    });
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    const body = bodyOf(r);
    expect(r.shape).toBe("vesselMitosisCutoverResult");
    expect(body["refuse_class"]).toBe("own_check_failed");
    expect(String(body["refusal_reason"] ?? "")).toContain("own_check_failed");
    expect(String(body["refusal_reason"] ?? "")).not.toContain("no_measurement_available");
    expect(headSubject(s)).toBe("baseline");
    expect(git(s.originRoot, "rev-parse", "dev")).toBe(s.originSha);
  });
});

describe("cutover: the pre-cutover suite has no env kill switch; only a shaped hold pauses it", () => {
  async function holdSuite(): Promise<void> {
    const acq = await resolveMaintenanceLeaseWrite({ type: "maintenanceLease_write", op: "acquire", name: "precutover_suite", holder: "operator:test", ttl_ms: 60_000 } as never);
    expect((acq.body as { acquired?: boolean }).acquired).toBe(true);
  }

  it("MUST-FAIL K1: with CUTOVER_PRECHECK_SUITE=0 set, the pre-cutover suite still runs (the env var has no effect)", async () => {
    const s = await setup();
    suite("passing");
    noCheck(s);
    process.env["CUTOVER_PRECHECK_SUITE"] = "0";
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(precheckCalls).toBeGreaterThan(0);
    expect(r.shape).toBe("cutoverApplied");
  });

  it("MUST-FAIL K2: a held maintenanceLease \"precutover_suite\" (a shaped hold read at dispatch) pauses the suite; the landing rests on the gap's own check", async () => {
    const s = await setup();
    suite("passing");
    const own = ownCheckPasses(s);
    await holdSuite();
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(precheckCalls).toBe(0);
    expect(own.ownRuns()).toBe(1);
    expect(r.shape).toBe("cutoverApplied");
  });

  it("MUST-FAIL K3: a held (paused) suite is not a measurement — no gap check plus the hold refuses with no_measurement_available", async () => {
    const s = await setup();
    suite("passing");
    noCheck(s);
    await holdSuite();
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(precheckCalls).toBe(0);
    expect(bodyOf(r)["refuse_class"]).toBe("no_measurement_available");
    expect(headSubject(s)).toBe("baseline");
  });

  it("CONTROL K: with no hold and the env var unset, the pre-cutover suite runs", async () => {
    const s = await setup();
    suite("passing");
    noCheck(s);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(precheckCalls).toBeGreaterThan(0);
    expect(r.shape).toBe("cutoverApplied");
  });
});

describe("cutover fs guard", () => {
  it("CONTROL: a deliberate write outside the test tmpdir (/workspace/…) is blocked AND recorded, so a swallowing caller still fails the test", async () => {
    // A directory that does not exist: even if the guard were broken, nothing could be created here.
    const target = "/workspace/.cutover-fs-guard-control-never-created/x";
    let swallowed = 0;
    try { await writeFile(target, "x"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EACCES") swallowed++; }
    const nodeFs = await import("node:fs");
    try { nodeFs.writeFileSync(`${target}-sync`, "x"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EACCES") swallowed++; }
    try { await Bun.write(`${target}-bun`, "x"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EACCES") swallowed++; }
    // A write inside the tmpdir is allowed (positive control on the allow side).
    await writeFile(join(ws, "inside.txt"), "ok");
    expect(await readFile(join(ws, "inside.txt"), "utf8")).toBe("ok");
    expect(swallowed).toBe(3);
    expect(fsGuard.violations).toEqual([
      `fs/promises.writeFile ${target}`,
      `fs.writeFileSync ${target}-sync`,
      `Bun.write ${target}-bun`,
    ]);
    fsGuard.violations.length = 0; // this test's violations are the point; afterEach checks every other test
  });
});

describe("cutover fetch guard", () => {
  it("CONTROL: a deliberate unstubbed fetch is caught — rejected AND recorded, so a swallowing caller still fails the test", async () => {
    let swallowed = false;
    try { await fetch("http://127.0.0.1:1/deliberately-unstubbed", { method: "POST", body: "{}" }); } catch { swallowed = true; }
    expect(swallowed).toBe(true);
    expect(guard.violations).toEqual(["POST http://127.0.0.1:1/deliberately-unstubbed"]);
    guard.violations.length = 0; // this test's violation is the point; afterEach checks every other test
  });
});
