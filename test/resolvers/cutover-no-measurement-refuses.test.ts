// A LANDING THAT NOTHING MEASURED IS REFUSED, NOT CUT OVER (check-first).
//
// General rule: "nothing measured it" must REFUSE, not land. Instance: a commit landed whose gap
// carried no class-2 check (the own-check step stamped it landed_unverified) AND whose
// pre-cutover suite did not run (ran=false). Every instrument abstained, and it still landed:
// step 5d-own lets a check-less gap through as landed_unverified, and the pre-cutover suite gate
// (5d) treats any run without a summary as "could not measure → fail open". On the landing node
// pull-sync's test gate never runs on the cutover's own commit, so this suite is the only
// measurement there.
//
// Expected: a cutover needs at least ONE measurement that actually ran — the gap's own class-2
// check, the pre-cutover suite with ran=true, or a by-effect check. With none it refuses with
// no_measurement_available, keeps the patch parked (pending lock and staged tree kept, nothing
// committed), and files or bumps a gap saying this repo / gap has no instrument. A suite that
// timed out, was killed, or never started is ran=false: no measurement, never a pass.
//
// These drive the REAL resolveVesselMitosisCutover through its git-aware path against a temp
// clone with a bare origin (skip_push, skip_restart). The gap-store read/write and the own-check
// run go through the cutover's own test seam (__setOwnCheckDepsForTests). The pre-cutover suite
// calls the REAL test_suite resolver directly (not through that seam), so only the network is
// stood in: discovery names a shell producer and the shell answers with bun's actual output for
// each case, captured from bun 1.3.14 — a repo with no tests ("No tests found!"), a suite killed
// by `timeout` before its summary, and a passing suite. The real resolver's `ran` regex reads
// those bytes. CUTOVER_PRECHECK_SUITE is UNSET here, so the suite step really runs: nothing in
// this file depends on that env kill switch being honoured (see the open gap
// the-precutover-suite-gate-fails-open-and-has-an-env-kill-switch).
//
// skip_push means no push is ever attempted in these fixtures, so "does not push" is pinned as
// "no commit was made and the bare origin's dev ref is unchanged".
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const VESSEL = "development-vessel";
const GAP = "gap-no-measurement-target";
const TEST_FILE = "test/resolvers/target.test.ts";
const OWN_TEST = "target > does what the gap asked";
const STAGED = "// patched by substrate\n";
const MVID = "mitosis-2026-10-02T23-45-00-000Z";
const TARGET = "src/resolvers/target.ts";

// bun 1.3.14's real output, captured from: an empty repo (no test files), a suite whose only test
// hangs and is killed by `timeout 2` before any summary, and a one-test passing suite.
const BUN_NO_TESTS =
  "bun test v1.3.14 (0d9b296a)\nNo tests found!\n\nTests need \".test\", \"_test_\", \".spec\" or \"_spec_\" in the filename (ex: \"MyApp.test.ts\")\n\nLearn more about bun test: https://bun.com/docs/cli/test\n";
const BUN_KILLED_BY_TIMEOUT = "bun test v1.3.14 (0d9b296a)\n\ntest/resolvers/slow.test.ts:\n";
const BUN_PASSING =
  "bun test v1.3.14 (0d9b296a)\n\ntest/resolvers/ok.test.ts:\n(pass) ok [0.06ms]\n\n 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file. [11.00ms]\n";

type SuiteMode = "no_tests" | "killed" | "dispatch_failed" | "passing";
const shellCalls: string[] = [];
const originalFetch = globalThis.fetch;
/** The pre-cutover (and post-land) suite's network: discovery → a fixture shell that answers per mode. */
function standInShell(hostRepoRoot: string, mode: SuiteMode): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    let body: Record<string, any> = {};
    try { body = init?.body ? JSON.parse(String(init.body)) : {}; } catch { body = {}; }
    if (body?.pointer?.type === "vesselCapability") {
      return Response.json({ content: { vessels: [{ endpoint: "http://shell.fixture", resolve_endpoint: "/resolve", health_score: 1 }] } });
    }
    if (url.startsWith("http://shell.fixture")) {
      shellCalls.push(String(body?.impulse?.pointer?.command ?? ""));
      if (mode === "dispatch_failed") throw new Error("shell producer connection reset");
      const head = `VERIFIED_ROOT=${hostRepoRoot}\nVERIFIED_HEAD=abc1234\n`;
      const out = mode === "no_tests" ? BUN_NO_TESTS : mode === "killed" ? BUN_KILLED_BY_TIMEOUT : BUN_PASSING;
      return Response.json({ stdout: head + out });
    }
    // Anything else (trace emission, attempt ledger): an empty answer, never a live endpoint.
    return Response.json({});
  }) as unknown as typeof fetch;
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
  shellCalls.length = 0;
  // Default: no network reaches anything live, even before a test installs its mode.
  standInShell(join(ws, "host-repo"), "dispatch_failed");
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  __setOwnCheckDepsForTests(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(ws, { recursive: true, force: true });
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
  const originRoot = join(ws, "host-origin.git");
  git(ws, "init", "-q", "--bare", "-b", "dev", originRoot);
  git(hostRepoRoot, "remote", "add", "origin", originRoot);
  git(hostRepoRoot, "push", "-q", "-u", "origin", "dev");
  const originSha = git(originRoot, "rev-parse", "dev");
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
  return { mitosisRoot, hostRepoRoot, originRoot, originSha, pendingPath, pointer };
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

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}
const bodyOf = (r: { body?: unknown }) => (r.body ?? {}) as Record<string, unknown>;

/** Refused for no measurement, nothing committed or pushed, the patch still parked. */
async function expectRefusedAndParked(s: Fixture, r: { shape: string; body?: unknown }): Promise<void> {
  const body = bodyOf(r);
  const landed = {
    shape: r.shape,
    refuse_class: body["refuse_class"] ?? null,
    head_subject: git(s.hostRepoRoot, "log", "-1", "--format=%s"),
    origin_dev: git(s.originRoot, "rev-parse", "dev"),
  };
  expect(landed).toEqual({
    shape: "vesselMitosisCutoverResult",
    refuse_class: "no_measurement_available",
    head_subject: "baseline",
    origin_dev: s.originSha,
  });
  expect(String(body["refusal_reason"] ?? "")).toContain("no_measurement_available");
  // Parked: the queue lock survives the exit clear, and the staged tree is intact.
  expect(await exists(s.pendingPath)).toBe(true);
  expect(await readFile(join(s.mitosisRoot, TARGET), "utf8")).toBe(STAGED);
  // The working tree's index is not left dirty with the staged paths.
  expect(git(s.hostRepoRoot, "diff", "--cached", "--name-only")).toBe("");
}

describe("cutover: a landing no instrument measured is refused (no_measurement_available), not cut over", () => {
  it("MUST-FAIL A: no gap check and a pre-cutover suite that did not run (repo with no tests, ran=false) refuses with no_measurement_available, does not push, keeps the patch parked", async () => {
    const s = await setup();
    standInShell(s.hostRepoRoot, "no_tests");
    let ownRuns = 0;
    __setOwnCheckDepsForTests({ readGap: readRow(noCheckRow), writeGap: recordWrite, runSuite: async () => { ownRuns++; return ownCheckBody(s.hostRepoRoot, {}); } });
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    // Positive control on the seam: the suite step was really attempted (the gap is not about the env switch).
    expect(shellCalls.length).toBeGreaterThan(0);
    expect(ownRuns).toBe(0);
    await expectRefusedAndParked(s, r);
  });

  it("MUST-FAIL B: no gap check and a pre-cutover suite KILLED by its timeout before the summary refuses — a timeout is ran=false, never a pass", async () => {
    const s = await setup();
    standInShell(s.hostRepoRoot, "killed");
    __setOwnCheckDepsForTests({ readGap: readRow(noCheckRow), writeGap: recordWrite, runSuite: async () => ownCheckBody(s.hostRepoRoot, {}) });
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(shellCalls.length).toBeGreaterThan(0);
    await expectRefusedAndParked(s, r);
  });

  it("MUST-FAIL B': no gap check and a pre-cutover suite that never started (shell dispatch failed) refuses", async () => {
    const s = await setup();
    standInShell(s.hostRepoRoot, "dispatch_failed");
    __setOwnCheckDepsForTests({ readGap: readRow(noCheckRow), writeGap: recordWrite, runSuite: async () => ownCheckBody(s.hostRepoRoot, {}) });
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(shellCalls.length).toBeGreaterThan(0);
    await expectRefusedAndParked(s, r);
  });

  it("MUST-FAIL C: the no-measurement refusal files or bumps a gap saying this repo / gap has no instrument", async () => {
    const s = await setup();
    standInShell(s.hostRepoRoot, "no_tests");
    __setOwnCheckDepsForTests({ readGap: readRow(noCheckRow), writeGap: recordWrite, runSuite: async () => ownCheckBody(s.hostRepoRoot, {}) });
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(bodyOf(r)["refuse_class"]).toBe("no_measurement_available");
    // Either a new gap naming the vessel, or a bump on the landing gap's row — through the gap write seam.
    const noInstrument = writes.filter((w) => {
      const j = JSON.stringify(w);
      return /no[_ -]?(measurement|instrument)/i.test(j) && (j.includes(VESSEL) || j.includes(GAP));
    });
    expect(noInstrument.length).toBeGreaterThan(0);
  });

  it("CONTROL 1: the gap's own check ran and PASSED → lands, even though the pre-cutover suite did not run", async () => {
    const s = await setup();
    standInShell(s.hostRepoRoot, "no_tests");
    let ownRuns = 0;
    __setOwnCheckDepsForTests({ readGap: readRow(checkedRow), writeGap: recordWrite, runSuite: async () => { ownRuns++; return ownCheckBody(s.hostRepoRoot, {}); } });
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(String(bodyOf(r)["refusal_reason"] ?? "")).toBe("");
    expect(r.shape).toBe("cutoverApplied");
    expect(ownRuns).toBe(1);
    expect(bodyOf(r)["own_check_verified"]).toBe(true);
    expect(git(s.hostRepoRoot, "log", "-1", "--format=%s")).not.toBe("baseline");
    expect(git(s.hostRepoRoot, "show", `HEAD:${TARGET}`) + "\n").toBe(STAGED);
  });

  it("CONTROL 2: no gap check, but the pre-cutover suite RAN (ran=true, no new failures) → lands; the suite is a measurement", async () => {
    const s = await setup();
    standInShell(s.hostRepoRoot, "passing");
    __setOwnCheckDepsForTests({ readGap: readRow(noCheckRow), writeGap: recordWrite, runSuite: async () => ownCheckBody(s.hostRepoRoot, {}) });
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(String(bodyOf(r)["refusal_reason"] ?? "")).toBe("");
    expect(r.shape).toBe("cutoverApplied");
    expect(shellCalls.length).toBeGreaterThan(0);
    expect(git(s.hostRepoRoot, "log", "-1", "--format=%s")).not.toBe("baseline");
    expect(git(s.hostRepoRoot, "show", `HEAD:${TARGET}`) + "\n").toBe(STAGED);
  });

  it("CONTROL 3: the gap's own check ran and FAILED → refused as own_check_failed, distinguishable from no_measurement_available", async () => {
    const s = await setup();
    standInShell(s.hostRepoRoot, "no_tests");
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
    expect(git(s.hostRepoRoot, "log", "-1", "--format=%s")).toBe("baseline");
    expect(git(s.originRoot, "rev-parse", "dev")).toBe(s.originSha);
  });
});
