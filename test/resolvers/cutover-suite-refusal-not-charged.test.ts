// THE PRE-CUTOVER SUITE'S REFUSAL IS NOT CHARGED TO THE LANDING GAP'S OWN CHECK (vessel-mitosis-cutover.ts; gap
// a-pre-cutover-suite-timeout-is-charged-to-the-landing-gaps-own-check-counter-and-breaks-an-unrelated-predicate).
//
// An undirected landing whose pre-cutover suite did not run, or ran and measured 0 tests, is refused. That refusal used to
// stamp the landing gap's ROW (stampOwnCheckOutcome: own_check_unmeasurable_count +1), and at
// OWN_CHECK_UNMEASURABLE_ESCALATE_AT (3) in a row ownCheckOutcomeUpdate demoted whatever evidence_resolve the row held,
// even a predicate the cutover never ran (live 2026-10-26). The pre-cutover suite is the whole-suite scan, not the gap's
// own check, so only the gap's own test_suite check moves that counter.
//   MUST-FAIL: three did-not-run refusals leave the row's own_check_unmeasurable_count and evidence_resolve as they were,
//              and own_check_broken is never set.
//   CONTROL:   an unmeasurable run of the gap's OWN test_suite check still increments the counter, and escalates at 3.
//   CONTROL:   the refusal itself is unchanged: it refuses with the same class and nothing is committed or pushed.
// Harness as cutover-precutover-gate-undirected.test.ts (the shared fetch, fs and exec guards; a live, merged gap row).
// Fixture words from a 5-word draw (2026-10-29T19:22:13Z: unsavory mongrel outfit devotion afterglow).
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCutoverFetchGuard, routeFleetUnreachable, routeShell,
  BUN_NO_TESTS, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch,
} from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

const { resolveVesselMitosisCutover, __setOwnCheckDepsForTests } = cutoverMod;

// A real bun summary for "found the test file, matched zero test names" — NOT "no tests found!"
// (that is BUN_NO_TESTS: ran=false). This is ran=true, pass=0, fail=0, which test-suite.ts's
// `/\d+\s+(pass|fail)\b/` regex reads as ran=true: a gamed filter/shim reads exactly this way.
const BUN_ZERO_TESTS_MATCHED =
  "bun test v1.3.14 (0d9b296a)\n\ntest/resolvers/target.test.ts:\n\n 0 pass\n 0 fail\n 0 expect() calls\nRan 0 tests across 1 file. [2.00ms]\n";

const ENV_KEYS = [
  "WORKSPACE_ROOT", "MITOSIS_CUTOVER_SKIP_SYSTEMCTL", "MITOSIS_DIRECT_PUSH", "MITOSIS_RUNTIME_DIR", "MITOSIS_PUSH_CLONE_DIR",
  "MITOSIS_HOST_SYNC_MODE", "MITOSIS_HOST_REPO_ROOT", "PUSH_POLICY_PATH", "SUBSTRATE_REPO_OWNER", "CUTOVER_PRECHECK_SUITE",
  "MAINTENANCE_LEASE_PATH", "GAP_STORE_ENDPOINT",
] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let guard: FetchGuard;
let fsGuard: FsGuard;
// SYSTEMD THROUGH A STUB, never the real tool (the test preload blocks systemctl in the live
// container). registerAttempt's own invariant snapshot (attempt-checks.ts "systemd_units") spawns
// `systemctl show <clone>/host-repo.service -p LoadState --value` on any FRESH attempt-ledger
// registration after a successful landing — same seam cutover-landing-lease.test.ts stubs.
let execGuard: ExecGuard;
afterAll(() => {
  restoreCutoverFsModules();
  restoreCutoverFetch();
  restoreCutoverExecModules();
});

const VESSEL = "development-vessel";
const GAP = "gap-mongrel-outfit-target";
const STAGED = "// patched by substrate\n";
const MVID = "mitosis-2026-10-25T00-00-00-000Z";
const TARGET = "src/resolvers/target.ts";

type SuiteMode = "no_tests" | "zero_tests_matched";
let currentHost = "";
function suite(mode: SuiteMode): void {
  routeShell(guard, () => {
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return BUN_NO_TESTS; // post-land call
    return mode === "no_tests" ? BUN_NO_TESTS : BUN_ZERO_TESTS_MATCHED;
  });
}

const writes: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-refusal-not-charged-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  writes.length = 0;
  currentHost = "";
  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  execGuard = installCutoverExecGuard();
  execGuard.route({ name: "host-repo-load-state", match: (c) => /^systemctl show \S+\/host-repo\.service -p LoadState --value$/.test(c), respond: () => ({ exitCode: 0, stdout: "not-found\n" }) });
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
});

afterEach(async () => {
  const violations = guard.restore();
  const fsViolations = fsGuard.restore();
  const unroutedExec = execGuard.restore();
  if (unroutedExec.length > 0) throw new Error(`unrouted systemd call(s): ${unroutedExec.join("; ")}`);
  __setOwnCheckDepsForTests(null);
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
  const originSha = git(originRoot, "rev-parse", "dev");
  currentHost = hostRepoRoot;
  const pendingPath = join(ws, "mitosis-pending.json");
  await writeFile(
    pendingPath,
    JSON.stringify({ vessel_name: VESSEL, base_version_id: "v1", mitosis_version_id: MVID, mitosis_root: mitosisRoot, base_sha: baseSha, authored_by: "patch_with_tools", gap_id: GAP, proposal: GAP, staged_files: [TARGET] }, null, 2),
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
    evaluation_evidence: { verdict: "FAVORABLE", verdict_reason: "static_checks_pass", base_success_rate: 1, mitosis_success_rate: 1, cited_trace_ids: [], cited_check_names: ["bun run typecheck"] },
    skip_push: true,
    skip_restart: true,
    // deliberately NO attempt_id: directedLandingOrigin reads "no attempt id" → undirected.
  };
  return { mitosisRoot, hostRepoRoot, originRoot, originSha, baseSha, pointer };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

const bodyOf = (r: { body?: unknown }) => (r.body ?? {}) as Record<string, unknown>;
const headSubject = (s: Fixture) => git(s.hostRepoRoot, "log", "-1", "--format=%s");
/** A gap row with NO own check (falsifier: none) — the own-check step abstains, so this must-fail
 *  isolates the precutover suite's own fail-closed behaviour, not a different gate's. */
/** A gap row with NO own check (falsifier: none), kept live (not a frozen snapshot) and merged on
 *  every write — same merge contract the real gap store keeps — so a repeated unmeasurable run
 *  actually accumulates own_check_unmeasurable_count across calls in this fixture, as it does live. */
let liveRow: Record<string, unknown> = { id: GAP, status: "open", category: "missing_capability", summary: "target gap", source: "substrate_detected", classification_metadata: { falsifier: "none" } };
const readLiveRow = async (p: Record<string, unknown>) => ({ shape: "substrateGap", body: { gaps: p["id"] === GAP ? [liveRow] : [] } });
const writeLiveRow = async (p: Record<string, unknown>) => {
  writes.push(JSON.parse(JSON.stringify(p)));
  const gap = (p["gap"] ?? {}) as Record<string, unknown>;
  const meta = { ...((liveRow["classification_metadata"] ?? {}) as Record<string, unknown>), ...((gap["classification_metadata"] ?? {}) as Record<string, unknown>) };
  liveRow = { ...liveRow, ...gap, classification_metadata: meta };
  return { shape: "substrateGapWriteResult", body: { ok: true } };
};
function noOwnCheck(): void {
  liveRow = { id: GAP, status: "open", category: "missing_capability", summary: "target gap", source: "substrate_detected", classification_metadata: { falsifier: "none" } };
  __setOwnCheckDepsForTests({ readGap: readLiveRow, writeGap: writeLiveRow, runSuite: async () => ({ shape: "test_suite", body: { ran: false } }) });
}

/** A predicate the cutover never runs: not a test_suite check, so the own-check step has nothing to run for it. */
const OTHER_PREDICATE = { shape: "substrateGap", input: { id: "gap-afterglow-devotion" }, zero_field: "unsavory_outfit" };
function rowWithOtherPredicate(): void {
  liveRow = { id: GAP, status: "open", category: "missing_capability", summary: "target gap", source: "substrate_detected", classification_metadata: { falsifier: "class1", evidence_resolve: OTHER_PREDICATE } };
  __setOwnCheckDepsForTests({ readGap: readLiveRow, writeGap: writeLiveRow, runSuite: async () => ({ shape: "test_suite", body: { ran: false } }) });
}
/** The gap's OWN test_suite check, whose every run is unmeasurable (it never ran). */
const OWN_CHECK = { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: "test/resolvers/target.test.ts", only_tests: ["target > mongrel outfit"] }, zero_field: "requested_not_passing" };
function rowWithOwnCheckUnmeasurable(): void {
  liveRow = { id: GAP, status: "open", category: "missing_capability", summary: "target gap", source: "substrate_detected", classification_metadata: { falsifier: "class2", evidence_resolve: OWN_CHECK } };
  __setOwnCheckDepsForTests({ readGap: readLiveRow, writeGap: writeLiveRow, runSuite: async () => ({ shape: "test_suite", body: { ran: false } }) });
}
const rowMeta = () => (liveRow["classification_metadata"] ?? {}) as Record<string, unknown>;

describe("cutover: a pre-cutover suite refusal is not charged to the landing gap's own-check counter", () => {
  it("[MUST-FAIL] three did-not-run refusals leave own_check_unmeasurable_count and evidence_resolve as they were, and never set own_check_broken", async () => {
    const s = await setup();
    suite("no_tests");
    rowWithOtherPredicate();
    for (let i = 1; i <= 3; i++) {
      const r = await resolveVesselMitosisCutover(s.pointer as never);
      expect([i, bodyOf(r)["refuse_class"]]).toEqual([i, "pre_cutover_suite_not_run"]);
    }
    expect(rowMeta()["own_check_unmeasurable_count"]).toBeUndefined();
    expect(rowMeta()["own_check_broken"]).toBeUndefined();
    expect(rowMeta()["evidence_resolve"]).toEqual(OTHER_PREDICATE);
  });

  it("[CONTROL] an unmeasurable run of the gap's OWN test_suite check still increments the counter, and escalates at 3", async () => {
    const s = await setup();
    suite("no_tests");
    rowWithOwnCheckUnmeasurable();
    const counts: unknown[] = [];
    for (let i = 1; i <= 3; i++) {
      await resolveVesselMitosisCutover(s.pointer as never);
      counts.push(rowMeta()["own_check_unmeasurable_count"]);
    }
    expect(counts).toEqual([1, 2, 3]);
    expect(rowMeta()["evidence_resolve"]).toBeNull();
    expect((rowMeta()["own_check_broken"] as Record<string, unknown>)["evidence_resolve"]).toEqual(OWN_CHECK);
  });

  it("[CONTROL] the refusal is unchanged: did-not-run and zero-tests each refuse with their class, and nothing is committed or pushed", async () => {
    for (const [mode, cls] of [["no_tests", "pre_cutover_suite_not_run"], ["zero_tests_matched", "pre_cutover_suite_zero_tests"]] as const) {
      const s = await setup();
      suite(mode);
      rowWithOtherPredicate();
      const before = git(s.originRoot, "rev-parse", "dev");
      const r = await resolveVesselMitosisCutover(s.pointer as never);
      expect([mode, bodyOf(r)["refuse_class"]]).toEqual([mode, cls]);
      expect(headSubject(s)).toBe("baseline");
      expect(git(s.originRoot, "rev-parse", "dev")).toBe(before);
      await rm(join(ws, "host-repo"), { recursive: true, force: true });
      await rm(join(ws, "host-origin.git"), { recursive: true, force: true });
      await rm(join(ws, "vessels"), { recursive: true, force: true });
      await rm(join(ws, "git"), { recursive: true, force: true });
    }
  });
});
