// THE AUTONOMY SCOPE IS ENFORCED AT THE LANDING CHOKEPOINT, FOR EVERY ROUTE (F1).
//
// Defect: the autonomy floor lived only in feature_compose (its AUTONOMY SCOPE FLOOR) and in
// gap-to-feature admission. apply_proposal_as_patch -> patch_with_tools -> vessel_mitosis_cutover
// staged and landed with no scope check, and write-containment admits scope-excluded lane writes on
// the promise that "an AUTONOMOUS compose touching an excluded path is already withheld at landing".
// Nothing at the landing kept that promise.
//
// CONTRACT pinned here (vessel-mitosis-cutover.ts AUTONOMY-SCOPE CHOKEPOINT):
//   - A landing that is not DIRECTED is refused (refuse_class autonomy_scope_excluded, non_attempt) when
//     any staged file falls under an autonomyScope excluded path: no commit, nothing pushed, the clone
//     clean, one REFUSE line naming the excluded entry and the file. Whatever route staged it:
//     apply_proposal_as_patch (pending -> mitosis-tick), patch_with_tools, feature_compose.
//   - DIRECTED means a stamped feature_compose attemptIntent (attempt-register.ts directedIntentStamp)
//     covering the staged files and the gap. A `directed` flag on the pointer or in mitosis-pending.json,
//     and an unstamped or forged ledger line, are autonomous.
//   - An unreadable scope refuses an autonomous landing (autonomy_scope_unreadable, fail closed); a
//     directed landing never consults it.
//   - Disagreement adjudication (gap-to-feature admitActionableGaps, DISAGREEMENT ADJUDICATION) mints
//     edit_site repos/goal-host-vessel/src/index.ts AFTER admission's scope check; the landing of that
//     gap is refused here.
//   - CONTROLS: an autonomous landing of open files lands; a directed landing of the excluded file lands.
//
// SEAMS: the real resolveVesselMitosisCutover through its git-aware path against a temp clone with a
// bare origin (skip_push, skip_restart), as cutover-no-measurement-refuses.test.ts drives it. The scope
// is the REAL reader (gap-to-feature autonomyScope) over the shared cutover fetch guard: discovery names
// one local poolImpulse producer that answers the fixture autonomyScope record. The shared setup's
// default fixture scope (cutover-gate-default.ts) is cleared here, so this file reads the real one. The
// ledger is the real attempt-ledger under ATTEMPT_LEDGER_DIR; directed intents are registered by the
// real registerAttempt. Own check and gap reads go through __setOwnCheckDepsForTests.
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { registerAttempt } from "../../src/resolvers/attempt-register.js";
import { appendRecord, readRecords } from "../../src/resolvers/attempt-ledger.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, routeFleetUnreachable, routeShell, BUN_NO_TESTS, BUN_PASSING, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const { resolveVesselMitosisCutover, __setOwnCheckDepsForTests } = cutoverMod;
const { __resetPolicyReadsForTests, autonomyScopeExcludes } = await import("../../src/judge/gap-policy.js");
// AUTHENTICATED DIRECTED (lib/operator-direct.ts): a directed intent is stamped only under a grant identity gave the
// operator's own key ("operator:direct", or "admin" interim). Imported softly so the must-fails below are red at a
// parent without the module for the behaviour (it stamps every directed:true), not for a missing import.
type OperatorDirect = typeof import("../../src/lib/operator-direct.js");
const od = (await import("../../src/lib/operator-direct.js").catch(() => null)) as OperatorDirect | null;
/** Present only on a tree with the chokepoint; on the parent this is a no-op (the parent has no scope read to stub). */
const clearScopeDefault = (): void => (cutoverMod as unknown as { __setAutonomyScopeDefaultForTests?: (r: null) => void }).__setAutonomyScopeDefaultForTests?.(null);

const ENV_KEYS = [
  "WORKSPACE_ROOT", "MITOSIS_CUTOVER_SKIP_SYSTEMCTL", "MITOSIS_DIRECT_PUSH", "MITOSIS_RUNTIME_DIR", "MITOSIS_PUSH_CLONE_DIR",
  "MITOSIS_HOST_SYNC_MODE", "MITOSIS_HOST_REPO_ROOT", "PUSH_POLICY_PATH", "SUBSTRATE_REPO_OWNER", "CUTOVER_PRECHECK_SUITE",
  "MAINTENANCE_LEASE_PATH", "GAP_STORE_ENDPOINT", "ATTEMPT_LEDGER_DIR", "METABOB_API_KEY", "IDENTITY_VESSEL_URL",
] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let guard: FetchGuard;
let fsGuard: FsGuard;
let execGuard: ExecGuard;
let errLines: string[] = [];
let errSpy: ReturnType<typeof spyOn> | null = null;
afterAll(() => {
  restoreCutoverFsModules();
  restoreCutoverExecModules();
  restoreCutoverFetch();
});

const AT = "2026-10-10T10:00:00.000Z";
// identity-vessel stand-in (fixture keys only). Every key is the same user/org/role; only the scopes differ.
const IDENTITY = "http://127.0.0.1:59199";
const RW_KEY = "rw-key-fixture";            // the cockpit key / goal-host's fleet key today: read, write
const OP_DIRECT_KEY = "opdirect-key-fixture"; // the operator key deployment will issue: operator:direct
const ADMIN_KEY = "admin-key-fixture";      // the interim fallback
const VERDICT_KEY = "verdict-key-fixture";  // verdict:human only: labels, never directs
const IDENTITY_KEYS: Record<string, { keyId: string; scopes: string[] }> = {
  [RW_KEY]: { keyId: "k-rw", scopes: ["read", "write"] },
  [OP_DIRECT_KEY]: { keyId: "k-opdirect", scopes: ["read", "write", "verdict:human", "operator:direct"] },
  [ADMIN_KEY]: { keyId: "k-admin", scopes: ["read", "write", "admin"] },
  [VERDICT_KEY]: { keyId: "k-verdict", scopes: ["read", "write", "verdict:human"] },
};
function routeIdentity(g: FetchGuard): void {
  g.route({
    name: "identity (auth resolve)",
    match: (u) => u === `${IDENTITY}/v1/auth/resolve`,
    respond: (_u, b) => {
      const k = IDENTITY_KEYS[String(b?.impulse?.pointer?.apiKey ?? "")];
      return k ? Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", role: "user", keyId: k.keyId, scopes: k.scopes } }) : Response.json({ success: false }, { status: 401 });
    },
  });
}
const FIXTURE_KEY = "f1-fixture-node-key";
const EXCLUDED_DV = "src/resolvers/feature-compose.ts";
const SCOPE_BODY = {
  excluded_paths: ["repos/development-vessel/src/resolvers/feature-compose.ts", "repos/goal-host-vessel/src/index.ts", "scripts/substrate/",
    "repos/development-vessel/src/config.ts", "repos/development-vessel/src/routes/impulses.ts", "repos/development-vessel/src/judge/"],
  reason: "fixture: contained",
};
type ScopeMode = "contained" | "unreadable";
let scopeMode: ScopeMode = "contained";
let scopeReads = 0;
const LOCAL_EP = "http://node-local:8090";
function routeScope(g: FetchGuard): void {
  const localRow = { vesselId: "development-vessel-local", endpoint: LOCAL_EP, resolve_endpoint: "/v2/impulses/resolve", origin: "local" };
  g.route({
    name: "discovery (poolImpulse)",
    match: (_u, b) => b?.pointer?.type === "vesselCapability" && b?.pointer?.shape === "poolImpulse",
    respond: (_u, b) => {
      if (scopeMode === "unreadable") throw new Error("discovery unreachable (declared by the test)");
      return Response.json({ content: { shape: b.pointer.shape, vessels: [localRow], found: true } });
    },
  });
  g.route({
    name: "pool (autonomyScope)",
    match: (u, b) => u.startsWith(LOCAL_EP) && b?.impulse?.type === "poolImpulse",
    respond: (_u, b) => {
      if (b.impulse.shape === "autonomyScope") scopeReads++;
      return Response.json({ body: { impulses: b.impulse.shape === "autonomyScope" ? [{ shape: "autonomyScope", updated_at: AT, body: SCOPE_BODY }] : [] } });
    },
  });
}

let currentHost = "";
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-autonomy-scope-"));
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["WORKSPACE_ROOT"] = ws;
  isolateLearnedStateInProcess(ws); // learned state (posteriors, calibration, credit) under the temp root too, never /workspace
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  process.env["ATTEMPT_LEDGER_DIR"] = join(ws, "attempt-ledger");
  process.env["METABOB_API_KEY"] = FIXTURE_KEY;
  scopeMode = "contained";
  scopeReads = 0;
  currentHost = "";
  guard = installCutoverFetchGuard();
  clearScopeDefault();
  __resetPolicyReadsForTests();
  fsGuard = installCutoverFsGuard();
  // attempt-checks.ts's systemd_units check spawns `systemctl show <vessel>.service -p LoadState --value`
  // (not gated by MITOSIS_CUTOVER_SKIP_SYSTEMCTL above, a different call site): answered as a host with no
  // systemd, as test/drafter-split/harness.ts and auto-revert.test.ts already do for the same check.
  execGuard = installCutoverExecGuard();
  execGuard.route({ name: "attempt-check-unit", match: (c) => /systemctl show \S+ -p LoadState --value/.test(c), respond: () => ({ exitCode: 1, stdout: "" }) });
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
  // PRE-cutover (clone still at "baseline"): a real pass (ran=true). This file is about the
  // autonomy-scope chokepoint, not the precutover suite: a "did not run" answer here (2026-10-25)
  // now parks every undirected landing at the 5d gate regardless of scope, which would make the
  // "lands" CONTROLs below fail for a reason orthogonal to what they pin. POST-land (the commit now
  // exists) still answers "no tests", unchanged.
  routeShell(guard, () => {
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return BUN_NO_TESTS;
    return `VERIFIED_ROOT=${currentHost}\nVERIFIED_HEAD=abc1234\n${BUN_PASSING}`;
  });
  routeScope(guard); // after routeShell: later routes win, so the poolImpulse lookup is answered here
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  routeIdentity(guard);
  errLines = [];
  errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => { errLines.push(a.map(String).join(" ")); });
});

afterEach(async () => {
  errSpy?.mockRestore();
  errSpy = null;
  const violations = guard.restore();
  const fsViolations = fsGuard.restore();
  const execViolations = execGuard.restore();
  __setOwnCheckDepsForTests(null);
  (cutoverMod as unknown as { __setAdditiveAdvertisedForTests?: (f: null) => void }).__setAdditiveAdvertisedForTests?.(null);
  __resetPolicyReadsForTests();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await rm(ws, { recursive: true, force: true });
  expect(violations).toEqual([]);
  expect(fsViolations).toEqual([]);
  expect(execViolations).toEqual([]);
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}
const sha12 = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 12);

type Route = "apply_proposal_as_patch" | "patch_with_tools" | "feature_compose";
type Opts = { vessel?: string; files: string[]; gap: string; route: Route; attemptId?: string; pendingExtra?: Record<string, unknown>; pointerExtra?: Record<string, unknown> };
const ORIGINAL = (f: string) => `// original ${f}\n`;
const STAGED = (f: string) => `// patched by substrate: ${f}\n`;

async function setup(o: Opts) {
  const vessel = o.vessel ?? "development-vessel";
  const mvid = `mitosis-2026-10-10T10-00-00-000Z-${o.route}`;
  const baseRoot = join(ws, "git", "super-repo", "repos", vessel);
  const mitosisRoot = join(ws, "vessels", `${vessel}-${mvid}`);
  const hostRepoRoot = join(ws, "host-repo");
  for (const f of o.files) {
    for (const root of [baseRoot, mitosisRoot, hostRepoRoot]) await mkdir(join(root, f, ".."), { recursive: true });
    await writeFile(join(baseRoot, f), ORIGINAL(f));
    await writeFile(join(hostRepoRoot, f), ORIGINAL(f));
    await writeFile(join(mitosisRoot, f), STAGED(f));
  }
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
  const baseSha = sha12(ORIGINAL(o.files[0]!));
  const pendingPath = join(ws, "mitosis-pending.json");
  // What apply_proposal_as_patch / patch_with_tools leave behind: the queue lock naming this mitosis.
  await writeFile(pendingPath, JSON.stringify({
    vessel_name: vessel, base_version_id: "v1", mitosis_version_id: mvid, mitosis_root: mitosisRoot, base_sha: baseSha,
    authored_by: o.route === "feature_compose" ? "feature_compose" : "patch_with_tools", gap_id: o.gap, proposal: o.gap, staged_files: o.files,
    ...(o.pendingExtra ?? {}),
  }, null, 2));
  const common = {
    type: "vessel_mitosis_cutover" as const, vessel_name: vessel, base_version_id: o.route === "apply_proposal_as_patch" ? "v1" : `${vessel}-live`,
    mitosis_version_id: mvid, mitosis_root: mitosisRoot, base_root: baseRoot, host_repo_root: hostRepoRoot, staged_base_sha: baseSha,
    staged_files: o.files, gap_id: o.gap, pending_pointer_path: pendingPath, applied_log_path: join(ws, "mitosis-applied.jsonl"),
    skip_push: true, skip_restart: true,
  };
  // The three routes' pointers, as each builds it (mitosis-tick for apply_proposal_as_patch's pending
  // record; patch-with-tools.ts cutoverStaged; feature-compose.ts's landing call).
  const pointer =
    o.route === "apply_proposal_as_patch" ? { ...common, proposal_id: o.gap, evaluation_evidence: { verdict: "FAVORABLE", verdict_reason: "static_checks_pass", base_success_rate: 1, mitosis_success_rate: 1, cited_trace_ids: [], cited_check_names: ["bun run typecheck"] } }
    : o.route === "patch_with_tools" ? { ...common, proposal_id: o.gap, evaluation_evidence: { verdict: "FAVORABLE", base_success_rate: 1, mitosis_success_rate: 1, cited_trace_ids: [], cited_check_names: ["static_evaluate"], gap_id: o.gap, proposal_id: o.gap, refused_surql_cutover: true } }
    : { ...common, proposal_id: `${o.gap}-compose-report`, attempt_id: o.attemptId, evaluation_evidence: { verdict: "FAVORABLE", base_success_rate: 1, mitosis_success_rate: 1, cited_trace_ids: [], cited_check_names: ["typecheck", "shape-dispatch", "bun test"] } };
  return { vessel, hostRepoRoot, originRoot, originSha, pendingPath, pointer: { ...pointer, ...(o.pointerExtra ?? {}) } };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

/** The landing gap: armed class 2 with a check the own-check step runs and that passes. */
function gapRow(id: string, vessel: string, editSite: string, extraMeta: Record<string, unknown> = {}) {
  return {
    id, status: "open", category: "systematic_failure", summary: `fixture ${id}`, source: "substrate_detected",
    classification_metadata: {
      falsifier: "class2", edit_site: editSite,
      evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${vessel}`, test_file: "test/resolvers/target.test.ts", only_tests: ["target > does what the gap asked"] }, zero_field: "requested_not_passing" },
      ...extraMeta,
    },
  };
}
function ownCheckPasses(s: Fixture, row: Record<string, unknown>): void {
  __setOwnCheckDepsForTests({
    readGap: async (p) => ({ shape: "substrateGap", body: { gaps: p["id"] === row["id"] ? [row] : [] } }),
    writeGap: async () => ({ shape: "substrateGapWriteResult", body: { ok: true } }),
    runSuite: async () => ({ shape: "test_suite", body: { vessel: `repos/${s.vessel}`, verified_root: s.hostRepoRoot, ran: true, total: 1, pass: 1, fail: 0, skip: 0, requested_not_passing: 0, failingTests: [] } }),
  });
}
/**
 * feature_compose's registration, as feature-compose.ts calls it before the cutover. `operatorKey` is the key the
 * operator's /run-goal request carried (goal-host forwards it as X-Operator-Authorization); the resolve route asks
 * identity for a grant for this gap and runs the compose under it, as done here.
 */
async function registerCompose(gap: string, files: string[], directed: boolean, operatorKey?: string, grantGap: string = gap): Promise<string> {
  const register = () => registerAttempt({ route: "feature_compose", repo: "/workspace/git/vessels/development-vessel", touched_files: files, gap_id: gap, authoring_execution_id: null, dispatch_id: null, directed, decision_id: null });
  let reg: Awaited<ReturnType<typeof registerAttempt>>;
  if (od && operatorKey) {
    const { grant } = await od.operatorDirectGrant(`ApiKey ${operatorKey}`, { gap_id: grantGap });
    reg = grant ? await od.runWithOperatorDirectGrant(grant, register) : await register();
  } else {
    reg = await register();
  }
  expect(reg.attempt_id).toBeTruthy();
  return reg.attempt_id!;
}
const intentOf = (attemptId: string) => readRecords("attemptIntent", { key: attemptId })[0]?.record as Record<string, unknown> | undefined;

describe("attempt intent drafter provenance", () => {
  it("durably records the closed drafter identity, keeps the first value on retry, and leaves legacy attempts neutral", async () => {
    const attempt_id = "att-drafter-attribution-fixture";
    const drafter = { variant: "drafter-v2-contract", version: "contract-2", fell_back: null };
    const base = { route: "feature_compose", repo: "/workspace/git/vessels/development-vessel", touched_files: ["src/resolvers/target.ts"], gap_id: "gap-drafter-attribution", attempt_id };
    const first = await registerAttempt({ ...base, drafter });
    expect(first).toMatchObject({ attempt_id, registered: true });
    expect(intentOf(attempt_id)?.["drafter"]).toEqual(drafter);

    const retry = await registerAttempt({ ...base, drafter: { variant: "floor", version: null, fell_back: "timeout" } });
    expect(retry).toMatchObject({ attempt_id, registered: false });
    expect(intentOf(attempt_id)?.["drafter"]).toEqual(drafter);

    const legacy = await registerAttempt({ ...base, attempt_id: `${attempt_id}-legacy` });
    expect(intentOf(legacy.attempt_id!)?.["drafter"]).toBeUndefined();
  });
});

const bodyOf = (r: { body?: unknown }) => (r.body ?? {}) as Record<string, unknown>;
const headSubject = (s: Fixture) => git(s.hostRepoRoot, "log", "-1", "--format=%s");

async function expectLanded(s: Fixture, r: { shape: string; body?: unknown }, files: string[]): Promise<void> {
  expect({ shape: r.shape, refusal_reason: String(bodyOf(r)["refusal_reason"] ?? "") }).toEqual({ shape: "cutoverApplied", refusal_reason: "" });
  expect(headSubject(s)).not.toBe("baseline");
  for (const f of files) expect(git(s.hostRepoRoot, "show", `HEAD:${f}`) + "\n").toBe(STAGED(f));
}
/** Refused at the chokepoint: nothing committed or pushed, the clone clean, one REFUSE line naming entry and file. */
async function expectScopeRefused(s: Fixture, r: { shape: string; body?: unknown }, refuseClass: string, named: Array<{ entry: string; file: string }>): Promise<void> {
  const body = bodyOf(r);
  expect({
    shape: r.shape, refuse_class: body["refuse_class"] ?? null, non_attempt: body["non_attempt"] ?? null,
    head_subject: headSubject(s), origin_dev: git(s.originRoot, "rev-parse", "dev"), clone_status: git(s.hostRepoRoot, "status", "--porcelain"),
  }).toEqual({
    shape: "vesselMitosisCutoverResult", refuse_class: refuseClass, non_attempt: true,
    head_subject: "baseline", origin_dev: s.originSha, clone_status: "",
  });
  const refuseLines = errLines.filter((l) => l.includes("[mitosis-cutover] REFUSE:") && l.includes(refuseClass));
  expect(refuseLines.length).toBe(1);
  for (const n of named) {
    expect(refuseLines[0]).toContain(n.entry);
    expect(refuseLines[0]).toContain(n.file);
  }
}

describe("cutover: an autonomous landing touching an autonomy-scope excluded path is refused, whatever route staged it", () => {
  it("MUST-FAIL (a) apply_proposal_as_patch: the pending staging mitosis-tick cuts over, touching an excluded file, is refused at cutover — no commit, one refusal line, clone clean", async () => {
    const gap = "gap-f1-apply-proposal";
    const s = await setup({ route: "apply_proposal_as_patch", files: [EXCLUDED_DV], gap });
    ownCheckPasses(s, gapRow(gap, s.vessel, `repos/development-vessel/${EXCLUDED_DV}`));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectScopeRefused(s, r, "autonomy_scope_excluded", [{ entry: SCOPE_BODY.excluded_paths[0]!, file: `repos/development-vessel/${EXCLUDED_DV}` }]);
    expect(scopeReads).toBeGreaterThan(0);
  });

  it("MUST-FAIL (a2) one excluded file among several open ones is refused; none of the files lands", async () => {
    const gap = "gap-f1-mixed";
    const files = ["src/resolvers/target.ts", EXCLUDED_DV, "src/lib/other.ts"];
    const s = await setup({ route: "apply_proposal_as_patch", files, gap });
    ownCheckPasses(s, gapRow(gap, s.vessel, "repos/development-vessel/src/resolvers/target.ts"));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectScopeRefused(s, r, "autonomy_scope_excluded", [{ entry: SCOPE_BODY.excluded_paths[0]!, file: `repos/development-vessel/${EXCLUDED_DV}` }]);
    for (const f of files) expect(git(s.hostRepoRoot, "show", `HEAD:${f}`) + "\n").toBe(ORIGINAL(f));
  });

  it("MUST-FAIL (a3) patch_with_tools: its own cutover pointer (no attempt id), touching an excluded file, is refused", async () => {
    const gap = "gap-f1-pwt";
    const s = await setup({ route: "patch_with_tools", files: [EXCLUDED_DV], gap });
    ownCheckPasses(s, gapRow(gap, s.vessel, `repos/development-vessel/${EXCLUDED_DV}`));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectScopeRefused(s, r, "autonomy_scope_excluded", [{ entry: SCOPE_BODY.excluded_paths[0]!, file: `repos/development-vessel/${EXCLUDED_DV}` }]);
  });

  it("MUST-FAIL (a4) feature_compose, undirected: registered directed:false, touching an excluded file, is refused at cutover too", async () => {
    const gap = "gap-f1-fc-undirected";
    const attemptId = await registerCompose(gap, [EXCLUDED_DV], false);
    const s = await setup({ route: "feature_compose", files: [EXCLUDED_DV], gap, attemptId });
    ownCheckPasses(s, gapRow(gap, s.vessel, `repos/development-vessel/${EXCLUDED_DV}`));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectScopeRefused(s, r, "autonomy_scope_excluded", [{ entry: SCOPE_BODY.excluded_paths[0]!, file: `repos/development-vessel/${EXCLUDED_DV}` }]);
  });
});

describe("cutover: directedness is not self-declared", () => {
  it("MUST-FAIL (f) a pending file and pointer saying directed:true with no operator origin are autonomous, and refused on an excluded path", async () => {
    const gap = "gap-f1-self-declared";
    const s = await setup({ route: "apply_proposal_as_patch", files: [EXCLUDED_DV], gap, pendingExtra: { directed: true, operator: "avi" }, pointerExtra: { directed: true } });
    ownCheckPasses(s, gapRow(gap, s.vessel, `repos/development-vessel/${EXCLUDED_DV}`, { directed: true }));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectScopeRefused(s, r, "autonomy_scope_excluded", [{ entry: SCOPE_BODY.excluded_paths[0]!, file: `repos/development-vessel/${EXCLUDED_DV}` }]);
  });

  it("MUST-FAIL (g) a ledger line claiming a directed feature_compose intent without a valid stamp (a tool write to the ledger) is autonomous, and refused", async () => {
    const gap = "gap-f1-forged-intent";
    const attemptId = "att-forged-f1";
    appendRecord("attemptIntent", attemptId, { attempt_id: attemptId, route: "feature_compose", repo: "/workspace/git/vessels/development-vessel", touched_files: [EXCLUDED_DV], gap_id: gap, directed: true, directed_stamp: "00".repeat(32), registered_at: AT });
    const s = await setup({ route: "feature_compose", files: [EXCLUDED_DV], gap, attemptId });
    ownCheckPasses(s, gapRow(gap, s.vessel, `repos/development-vessel/${EXCLUDED_DV}`));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectScopeRefused(s, r, "autonomy_scope_excluded", [{ entry: SCOPE_BODY.excluded_paths[0]!, file: `repos/development-vessel/${EXCLUDED_DV}` }]);
  });

  it("MUST-FAIL (h) a stamped directed intent covers only the files it registered: staging an extra excluded file under it is autonomous, and refused", async () => {
    const gap = "gap-f1-directed-overreach";
    const attemptId = await registerCompose(gap, ["src/resolvers/target.ts"], true, OP_DIRECT_KEY);
    const s = await setup({ route: "feature_compose", files: ["src/resolvers/target.ts", EXCLUDED_DV], gap, attemptId });
    ownCheckPasses(s, gapRow(gap, s.vessel, "repos/development-vessel/src/resolvers/target.ts"));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectScopeRefused(s, r, "autonomy_scope_excluded", [{ entry: SCOPE_BODY.excluded_paths[0]!, file: `repos/development-vessel/${EXCLUDED_DV}` }]);
  });

  it("MUST-FAIL (i) a stamped directed intent binds its vessel: replaying a development-vessel src/index.ts intent onto goal-host-vessel src/index.ts is autonomous, and refused", async () => {
    const gap = "gap-f1-directed-replay";
    const attemptId = await registerCompose(gap, ["src/index.ts"], true, OP_DIRECT_KEY);
    const s = await setup({ route: "feature_compose", vessel: "goal-host-vessel", files: ["src/index.ts"], gap, attemptId });
    ownCheckPasses(s, gapRow(gap, s.vessel, "repos/goal-host-vessel/src/index.ts"));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectScopeRefused(s, r, "autonomy_scope_excluded", [{ entry: "repos/goal-host-vessel/src/index.ts", file: "repos/goal-host-vessel/src/index.ts" }]);
  });

  it("CONTROL (b) an operator-directed landing of the same excluded file (feature_compose registered it directed) lands", async () => {
    const gap = "gap-f1-directed";
    const attemptId = await registerCompose(gap, [EXCLUDED_DV], true, OP_DIRECT_KEY);
    const s = await setup({ route: "feature_compose", files: [EXCLUDED_DV], gap, attemptId });
    ownCheckPasses(s, gapRow(gap, s.vessel, `repos/development-vessel/${EXCLUDED_DV}`));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectLanded(s, r, [EXCLUDED_DV]);
  });
});

describe("cutover: directed is the operator key's scope, not the request's say-so", () => {
  it("MUST-FAIL (f1) a feature_compose sent with an operator field and directed:true, carrying a read/write key, is NOT directed: no stamp, and refused on an excluded path", async () => {
    const gap = "gap-f1-rw-key";
    const attemptId = await registerCompose(gap, [EXCLUDED_DV], true, RW_KEY);
    expect(intentOf(attemptId)?.["directed"]).toBe(false);
    expect(intentOf(attemptId)?.["directed_stamp"]).toBeUndefined();
    const s = await setup({ route: "feature_compose", files: [EXCLUDED_DV], gap, attemptId, pointerExtra: { directed: true, operator: "avi" } });
    ownCheckPasses(s, gapRow(gap, s.vessel, `repos/development-vessel/${EXCLUDED_DV}`, { directed: true }));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectScopeRefused(s, r, "autonomy_scope_excluded", [{ entry: SCOPE_BODY.excluded_paths[0]!, file: `repos/development-vessel/${EXCLUDED_DV}` }]);
  });

  it("MUST-FAIL (f1') a verdict:human key (labels only) does not direct a compose: the two scopes are separate", async () => {
    const gap = "gap-f1-verdict-key";
    const attemptId = await registerCompose(gap, [EXCLUDED_DV], true, VERDICT_KEY);
    expect(intentOf(attemptId)?.["directed"]).toBe(false);
    const s = await setup({ route: "feature_compose", files: [EXCLUDED_DV], gap, attemptId });
    ownCheckPasses(s, gapRow(gap, s.vessel, `repos/development-vessel/${EXCLUDED_DV}`));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectScopeRefused(s, r, "autonomy_scope_excluded", [{ entry: SCOPE_BODY.excluded_paths[0]!, file: `repos/development-vessel/${EXCLUDED_DV}` }]);
  });

  it("MUST-FAIL (f1'') an operator grant for another gap does not direct this one", async () => {
    const gap = "gap-f1-other-gap";
    const attemptId = await registerCompose(gap, [EXCLUDED_DV], true, OP_DIRECT_KEY, "gap-somewhere-else");
    expect(intentOf(attemptId)?.["directed"]).toBe(false);
    const s = await setup({ route: "feature_compose", files: [EXCLUDED_DV], gap, attemptId });
    ownCheckPasses(s, gapRow(gap, s.vessel, `repos/development-vessel/${EXCLUDED_DV}`));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectScopeRefused(s, r, "autonomy_scope_excluded", [{ entry: SCOPE_BODY.excluded_paths[0]!, file: `repos/development-vessel/${EXCLUDED_DV}` }]);
  });

  for (const [label, key, keyId] of [["(f2) an operator:direct-scoped key", OP_DIRECT_KEY, "k-opdirect"], ["(f3) an admin-scoped key (interim)", ADMIN_KEY, "k-admin"]] as const) {
    it(`MUST-FAIL ${label} directs: the intent is stamped, names the key, and the excluded file lands`, async () => {
      const gap = `gap-f1-${keyId}`;
      const attemptId = await registerCompose(gap, [EXCLUDED_DV], true, key);
      expect(intentOf(attemptId)?.["directed"]).toBe(true);
      expect(typeof intentOf(attemptId)?.["directed_stamp"]).toBe("string");
      expect(intentOf(attemptId)?.["directed_by_key_id"]).toBe(keyId);
      const s = await setup({ route: "feature_compose", files: [EXCLUDED_DV], gap, attemptId });
      ownCheckPasses(s, gapRow(gap, s.vessel, `repos/development-vessel/${EXCLUDED_DV}`));
      const r = await resolveVesselMitosisCutover(s.pointer as never);
      await expectLanded(s, r, [EXCLUDED_DV]);
    });
  }
});

describe("cutover: open files land; the scope fails closed", () => {
  it("CONTROL (c) an autonomous landing (apply_proposal_as_patch) touching only open files lands", async () => {
    const gap = "gap-f1-open";
    const files = ["src/resolvers/target.ts", "src/lib/other.ts"];
    const s = await setup({ route: "apply_proposal_as_patch", files, gap });
    ownCheckPasses(s, gapRow(gap, s.vessel, "repos/development-vessel/src/resolvers/target.ts"));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectLanded(s, r, files);
  });

  it("MUST-FAIL (d) the scope is unreadable: an autonomous landing of an open file is refused (autonomy_scope_unreadable), failing closed", async () => {
    scopeMode = "unreadable";
    const gap = "gap-f1-unreadable";
    const s = await setup({ route: "apply_proposal_as_patch", files: ["src/resolvers/target.ts"], gap });
    ownCheckPasses(s, gapRow(gap, s.vessel, "repos/development-vessel/src/resolvers/target.ts"));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectScopeRefused(s, r, "autonomy_scope_unreadable", []);
    expect(String(bodyOf(r)["refusal_reason"])).toContain("unreadable");
  });

  it("CONTROL (d') the scope is unreadable: a directed landing never consults it and lands", async () => {
    scopeMode = "unreadable";
    const gap = "gap-f1-unreadable-directed";
    const attemptId = await registerCompose(gap, [EXCLUDED_DV], true, OP_DIRECT_KEY);
    const s = await setup({ route: "feature_compose", files: [EXCLUDED_DV], gap, attemptId });
    ownCheckPasses(s, gapRow(gap, s.vessel, `repos/development-vessel/${EXCLUDED_DV}`));
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectLanded(s, r, [EXCLUDED_DV]);
  });
});

describe("cutover: disagreement adjudication mints an excluded edit_site after admission's scope check", () => {
  it("MUST-FAIL (e) a gap whose edit_site gap-to-feature minted to repos/goal-host-vessel/src/index.ts, landing autonomously, is refused at cutover", async () => {
    const gap = "gap-probe-count-execution-and-verification-disagree";
    // The row exactly as DISAGREEMENT ADJUDICATION writes it back: edit_site minted, adjudication block, open.
    const minted = gapRow(gap, "goal-host-vessel", "repos/goal-host-vessel/src/index.ts", {
      adjudication: { family: "lettercount", operand: "abc", recomputed_truth: "3", verifier_expected: "4", wrong_mechanism: "verifier", method: "in-process executable recomputation", adjudicated_at: AT },
    });
    // The minted site IS excluded by the scope admission read; admission admits it anyway (the mint runs after its scope check).
    __resetPolicyReadsForTests();
    const { autonomyScope } = await import("../../src/judge/gap-policy.js");
    expect(autonomyScopeExcludes(await autonomyScope(), "repos/goal-host-vessel/src/index.ts")).toBe("repos/goal-host-vessel/src/index.ts");
    __resetPolicyReadsForTests();
    const s = await setup({ route: "apply_proposal_as_patch", vessel: "goal-host-vessel", files: ["src/index.ts"], gap });
    ownCheckPasses(s, minted);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectScopeRefused(s, r, "autonomy_scope_excluded", [{ entry: "repos/goal-host-vessel/src/index.ts", file: "repos/goal-host-vessel/src/index.ts" }]);
  });
});

// THE ADDITIVE REGISTRATION RULE (user ruling 10-13, "full package, additive-only"; src/judge/gap-policy.ts additiveRegistration).
// The registry (src/config.ts) and dispatch table (src/routes/impulses.ts) stay excluded, except for ONE kind of landing:
// a pure, single, NEW-shape registration of a resolver module created in the SAME landing. Every must-fail below is a
// landing the rule must refuse; the control lands. Every other excluded path is unchanged (the a-i suites above).
const ar = (await import("../../src/judge/gap-policy.js").catch(() => ({}))) as Record<string, any>;
const setAdvertised = (f: ((s: string) => Promise<boolean | null>) | null) => (cutoverMod as unknown as { __setAdditiveAdvertisedForTests?: (f: unknown) => void }).__setAdditiveAdvertisedForTests?.(f);
const BASE_CONFIG = `export const config = {\n  discovery: {\n    shapes: [\n      "alpha_report",\n      "beta_summary",\n    ],\n  },\n  labels: [\n    "x",\n  ],\n};\n`;
const BASE_ROUTES = `import { resolveAlpha } from "../resolvers/alpha.js";\nexport async function dispatch(pointer: any): Promise<unknown> {\n  switch (pointer.type) {\n    case "alpha_report": return resolveAlpha(pointer as any);\n    default:\n      throw new Error("Unknown pointer type");\n  }\n}\n`;
const NEW_MODULE = `export async function resolveGammaDigest(pointer: any): Promise<unknown> {\n  return { shape: "gamma_digest", body: { rows: [] as unknown[], pointer } };\n}\n`;
const withEntry = (shape: string, after = '      "beta_summary",\n') => BASE_CONFIG.replace(after, `${after}      "${shape}",\n`);
const withCase = (shape: string, fn: string, mod: string, routes = BASE_ROUTES) => routes
  .replace(`import { resolveAlpha } from "../resolvers/alpha.js";\n`, `import { resolveAlpha } from "../resolvers/alpha.js";\nimport { ${fn} } from "../resolvers/${mod}.js";\n`)
  .replace("    default:\n", `    case "${shape}": return ${fn}(pointer as any);\n    default:\n`);
const withDynCase = (shape: string, fn: string, mod: string) => BASE_ROUTES.replace("    default:\n", `    case "${shape}": {\n      const { ${fn} } = await import("../resolvers/${mod}.js");\n      return ${fn}(pointer as any);\n    }\n    default:\n`);
type Change = { path: string; before: string | null; after: string | null };
const registration = (over: Partial<Record<string, Change>> = {}): Change[] => Object.values({
  "src/config.ts": { path: "src/config.ts", before: BASE_CONFIG, after: withEntry("gamma_digest") },
  "src/routes/impulses.ts": { path: "src/routes/impulses.ts", before: BASE_ROUTES, after: withCase("gamma_digest", "resolveGammaDigest", "gamma-digest") },
  "src/resolvers/gamma-digest.ts": { path: "src/resolvers/gamma-digest.ts", before: null, after: NEW_MODULE },
  ...over,
}).filter((c): c is Change => !!c);
const notAdvertised = async () => false as boolean | null;

describe("additive registration rule (the classifier): exactly one new shape, added lines only, a new module", () => {
  it("CONTROL: a static-import registration and a dynamic-import case block are each admitted", async () => {
    expect(await ar.additiveRegistration(registration(), notAdvertised)).toEqual({ ok: true, shape: "gamma_digest", module: "src/resolvers/gamma-digest.ts", fn: "resolveGammaDigest" });
    const dyn = registration({ "src/routes/impulses.ts": { path: "src/routes/impulses.ts", before: BASE_ROUTES, after: withDynCase("gamma_digest", "resolveGammaDigest", "gamma-digest") } });
    expect((await ar.additiveRegistration(dyn, notAdvertised)).ok).toBe(true);
  });
  const mf: Array<[string, Partial<Record<string, Change>>, RegExp]> = [
    ["a removed line", { "src/routes/impulses.ts": { path: "src/routes/impulses.ts", before: BASE_ROUTES, after: withCase("gamma_digest", "resolveGammaDigest", "gamma-digest").replace('      throw new Error("Unknown pointer type");\n', "") } }, /removed or modified/],
    ["a modified existing case", { "src/routes/impulses.ts": { path: "src/routes/impulses.ts", before: BASE_ROUTES, after: withCase("gamma_digest", "resolveGammaDigest", "gamma-digest").replace("return resolveAlpha(pointer as any)", "return resolveAlpha({ ...pointer } as any)") } }, /removed or modified/],
    ["a new case for an EXISTING shape", { "src/config.ts": { path: "src/config.ts", before: BASE_CONFIG, after: withEntry("alpha_report") }, "src/routes/impulses.ts": { path: "src/routes/impulses.ts", before: BASE_ROUTES, after: withCase("alpha_report", "resolveGammaDigest", "gamma-digest") } }, /already/],
    ["extra non-pattern code alongside", { "src/routes/impulses.ts": { path: "src/routes/impulses.ts", before: BASE_ROUTES, after: withCase("gamma_digest", "resolveGammaDigest", "gamma-digest").replace("    default:\n", "    default:\n      void 0;\n") } }, /not exactly one registration case|not an import|not one contiguous case arm/],
    ["a case calling an EXISTING module", { "src/routes/impulses.ts": { path: "src/routes/impulses.ts", before: BASE_ROUTES, after: withCase("gamma_digest", "resolveGammaDigest", "alpha") }, "src/resolvers/gamma-digest.ts": undefined, "src/resolvers/alpha.ts": { path: "src/resolvers/alpha.ts", before: "export async function resolveAlpha(p: any) { return p; }\n", after: "export async function resolveAlpha(p: any) { return p; }\nexport async function resolveGammaDigest(p: any) { return p; }\n" } }, /EXISTING module/],
    ["a case calling a module this landing does not create", { "src/resolvers/gamma-digest.ts": undefined }, /does not create/],
    ["two shapes in one landing", { "src/config.ts": { path: "src/config.ts", before: BASE_CONFIG, after: BASE_CONFIG.replace('      "beta_summary",\n', '      "beta_summary",\n      "gamma_digest",\n      "delta_view",\n') } }, /exactly one added line/],
    ["a registry entry outside the shapes array", { "src/config.ts": { path: "src/config.ts", before: BASE_CONFIG, after: BASE_CONFIG.replace('    "x",\n', '    "x",\n    "gamma_digest",\n') } }, /not inside the discovery shapes array/],
    ["entry and case naming different shapes", { "src/config.ts": { path: "src/config.ts", before: BASE_CONFIG, after: withEntry("epsilon_rows") } }, /different shapes/],
    ["a module that does not export the called function", { "src/resolvers/gamma-digest.ts": { path: "src/resolvers/gamma-digest.ts", before: null, after: "export async function somethingElse() { return 1; }\n" } }, /does not export/],
    ["only one of the two registration files", { "src/config.ts": undefined }, /touches both/],
  ];
  for (const [label, over, why] of mf) it(`MUST-FAIL: ${label} is refused`, async () => {
    const v = await ar.additiveRegistration(registration(over), notAdvertised);
    expect(v.ok).toBe(false);
    expect(String(v.why)).toMatch(why);
  });
  it("MUST-FAIL: a shape the live dispatch table already has a case for (even unregistered) is refused", async () => {
    const routes = BASE_ROUTES.replace("    default:\n", '    case "orphan_rows": return resolveAlpha(pointer as any);\n    default:\n');
    const v = await ar.additiveRegistration(registration({
      "src/config.ts": { path: "src/config.ts", before: BASE_CONFIG, after: withEntry("orphan_rows") },
      "src/routes/impulses.ts": { path: "src/routes/impulses.ts", before: routes, after: withCase("orphan_rows", "resolveGammaDigest", "gamma-digest", routes) },
    }), notAdvertised);
    expect(v).toMatchObject({ ok: false, why: expect.stringMatching(/already has a case/) });
  });
  it("MUST-FAIL: a shape discovery already advertises is refused (reuse); an unreadable discovery fails closed", async () => {
    expect(await ar.additiveRegistration(registration(), async () => true)).toMatchObject({ ok: false, why: expect.stringMatching(/already advertised/) });
    expect(await ar.additiveRegistration(registration(), async () => null)).toMatchObject({ ok: false, why: expect.stringMatching(/failing closed/) });
  });
  it("insertedBlocks: a pure insertion yields its blocks under either alignment; any removed or changed line yields null", () => {
    expect(ar.insertedBlocks("a\nb\nc", "a\nX\nb\nc")).toEqual([{ at: 1, lines: ["X"] }]);
    expect(ar.insertedBlocks("a\n}\nb", "a\n}\n}\nb")).toEqual([{ at: 2, lines: ["}"] }]);
    expect(ar.insertedBlocks("a\n}\nb", "a\n}\n}\nb", true)).toEqual([{ at: 1, lines: ["}"] }]);
    expect(ar.insertedBlocks("a\nb\nc", "a\nc")).toBeNull();
    expect(ar.insertedBlocks("a\nb\nc", "a\nB\nc")).toBeNull();
  });
});

// THE OPERATOR-ACTS STAMP INSERT (user ruling 10-14, "Scope earn-in, additive only"; src/judge/gap-policy.ts additiveStampInsert).
// The dispatch table stays excluded except for inserted lines inside its substrateGap_write arm that import a PURE stamp
// helper created in the same landing (a one-shot admission). Children inherit stamps at read time, so no judge file is admitted.
const SG_READ_ARM = `    case "substrateGap":\n      return resolveSubstrateGap(p as any);\n`;
const STAMP_ROUTES = `import { resolveSubstrateGap, resolveSubstrateGapWrite, resolveSubstrateGapLease } from "../resolvers/substrate-gap.js";\nexport async function dispatchInner(p: any): Promise<unknown> {\n  switch (p.type) {\n${SG_READ_ARM}    case "substrateGap_write":\n      return resolveSubstrateGapWrite(p as any);\n    case "substrateGapLease_write":\n      return resolveSubstrateGapLease(p as any);\n    default:\n      throw new Error("Unknown pointer type");\n  }\n}\n`;
const STAMP_IMPORT = `      const { operatorActsFor } = await import("../judge/operator-acts.js");\n      // the stamp: who wrote, what changed, when\n      p.gap.classification_metadata ??= {};\n      const acts = operatorActsFor(structuredClone(p));\n      p.gap.classification_metadata.operator_acts = acts;\n`;
const WRITE_LABEL = `    case "substrateGap_write":\n`;
const stamped = (insert = STAMP_IMPORT) => STAMP_ROUTES.replace(WRITE_LABEL, WRITE_LABEL + insert);
const PURE_HELPER = `export function operatorActsFor(p: any): unknown[] {\n  const c = p?._route_caller;\n  const had = p?.gap?.classification_metadata?.operator_acts;\n  const prior = Array.isArray(had) ? had : [];\n  if (!c || c.node_self) return prior;\n  let principal = String(c.key_id ?? c.auth ?? "?");\n  principal = principal.slice(0, 64);\n  return [...prior, { principal, at: new Date().toISOString() }];\n}\n`;
const stampLanding = (over: Partial<Record<string, Change>> = {}): Change[] => Object.values({
  "src/routes/impulses.ts": { path: "src/routes/impulses.ts", before: STAMP_ROUTES, after: stamped() },
  "src/judge/operator-acts.ts": { path: "src/judge/operator-acts.ts", before: null, after: PURE_HELPER },
  ...over,
}).filter((c): c is Change => !!c);
const routeOver = (after: string): Partial<Record<string, Change>> => ({ "src/routes/impulses.ts": { path: "src/routes/impulses.ts", before: STAMP_ROUTES, after } });
const helperOver = (after: string, before: string | null = null): Partial<Record<string, Change>> => ({ "src/judge/operator-acts.ts": { path: "src/judge/operator-acts.ts", before, after } });

describe("operator-acts stamp insert (the classifier): inserted lines inside the substrateGap_write arm, a new pure helper", () => {
  it("MUST-FAIL (4) control: inserts inside the arm plus a new pure helper are admitted (a pure transform of its argument)", () => {
    expect(ar.additiveStampInsert(stampLanding())).toEqual({ ok: true, inserted: 5, helper: "src/judge/operator-acts.ts" });
    // inserts after the arm's return, still before the next live arm, are inside the arm too
    expect(ar.additiveStampInsert(stampLanding(routeOver(STAMP_ROUTES.replace(`      return resolveSubstrateGapWrite(p as any);\n`, `      return resolveSubstrateGapWrite(p as any);\n${STAMP_IMPORT}`)))).ok).toBe(true);
  });
  const mf: Array<[string, Partial<Record<string, Change>>, RegExp]> = [
    ["(1) a change to an existing line of the dispatch table", routeOver(stamped().replace("return resolveSubstrateGapWrite(p as any)", "return resolveSubstrateGapWrite({ ...p } as any)")), /removed or modified/],
    ["(2) a removed line", routeOver(stamped().replace(`      throw new Error("Unknown pointer type");\n`, "")), /removed or modified/],
    ["(3) an insertion in another arm", routeOver(STAMP_ROUTES.replace(SG_READ_ARM, SG_READ_ARM.replace("    case \"substrateGap\":\n", "    case \"substrateGap\":\n" + STAMP_IMPORT))), /outside the case "substrateGap_write": arm/],
    ["(3) an insertion after the next arm's label", routeOver(STAMP_ROUTES.replace(`    case "substrateGapLease_write":\n`, `    case "substrateGapLease_write":\n${STAMP_IMPORT}`)), /outside the case "substrateGap_write": arm/],
    ["(3) an insertion at the top of the file", routeOver(`import { stampOperatorActs } from "../judge/operator-acts.js";\n` + STAMP_ROUTES), /outside the case "substrateGap_write": arm/],
    ["(3) an inserted arm label inside the arm", routeOver(stamped(`    case "substrateGapAlias_write":\n` + STAMP_IMPORT)), /arm label/],
    ["inserts that do not import the helper", routeOver(stamped(`      const unused = 1;\n`)), /do not import/],
    ["a helper that already exists (the admission is one-shot)", helperOver(PURE_HELPER, "export function stampOperatorActs(p: any): any { return p; }\n"), /already exists/],
    ["a landing that does not create the helper", { "src/judge/operator-acts.ts": undefined }, /does not create/],
    ["an arm whose end cannot be bounded", { "src/routes/impulses.ts": { path: "src/routes/impulses.ts", before: `switch (p.type) {\n    case "substrateGap_write":\n      return w(p);\n}\n`, after: `switch (p.type) {\n    case "substrateGap_write":\n${STAMP_IMPORT}      return w(p);\n}\n` } }, /cannot be bounded/],
    ["a helper with an import statement", helperOver(`import { x } from "node:fs";\n` + PURE_HELPER), /not a pure transform: it contains an import statement/],
    ["a helper with a dynamic import", helperOver(PURE_HELPER.replace("const c = p?._route_caller;", "const c = p?._route_caller; void import(\"node:fs\");")), /dynamic import/],
    ["a helper with a re-export", helperOver(`export * from "../resolvers/substrate-gap.js";\n` + PURE_HELPER), /re-export/],
  ];
  for (const name of ["process", "fetch", "Bun", "globalThis", "require", "eval", "Function", "constructor"]) mf.push([`a helper naming ${name}`, helperOver(PURE_HELPER.replace("const c = p?._route_caller;", `const c = p?._route_caller; void ${name};`)), /not a pure transform/]);
  // (A) the ARM's inserted lines only compute and attach the stamp (qa review): each escape is refused
  const armMf: Array<[string, string, RegExp]> = [
    ["an early return", `      return { shape: "substrateGap", body: { gaps: [] } };\n`, /control flow/],
    ["a throw", `      throw new Error("no");\n`, /control flow/],
    ["an if", `      if (p.gap) p.gap.status = "closed";\n`, /control flow/],
    ["a ternary", `      const s = p.gap ? 1 : 2;\n`, /ternary/],
    ["a loop", `      for (const k of []) void k;\n`, /control flow/],
    ["a delete", `      delete p.gap.status;\n`, /control flow/],
    ["a status assignment", `      p.gap.status = "closed";\n`, /assigns to p\.gap\.status/],
    ["a reassignment of the pointer", `      p = { ...p };\n`, /assigns to p;/],
    ["a let", `      let n = 1;\n`, /mutable declaration/],
    ["an increment", `      const n = [0]; n[0]++;\n`, /increment/],
    ["a foreign import", `      const { additiveRegistration } = await import("../judge/gap-policy.js");\n`, /imports something other than/],
    ["a fetch", `      const r = await fetch("http://127.0.0.1:1/");\n`, /fetch/],
    ["a second write (a call to an in-scope function)", `      const w = await resolveSubstrateGapWrite(p as any);\n`, /calls resolveSubstrateGapWrite/],
    ["a method call", `      const k = Object.keys(p);\n`, /calls keys/],
    ["process.env", `      const e = process.env;\n`, /process/],
    ["the Function constructor", `      const f = Function("ret" + "urn 1");\n`, /Function/],
    ["constructor access", `      const f = p.constructor;\n`, /constructor/],
    ["a template literal", "      const t = `x`;\n", /template literal/],
    ["an ensure that is not empty", `      p.gap.classification_metadata ??= { status: "closed" };\n`, /assigns to p\.gap\.classification_metadata/],
    ["an overwrite of classification_metadata", `      p.gap.classification_metadata = {};\n`, /assigns to p\.gap\.classification_metadata/],
    ["a ??= on another field", `      p.gap.status ??= "closed";\n`, /assigns to p\.gap\.status/],
    ["a helper call on the live pointer", `      const live = operatorActsFor(p);\n`, /structuredClone/],
  ];
  it("MUST-FAIL (A) control: the arm's ensure `<path>.classification_metadata ??= {}` is admitted, and `??` / `?.` are not ternaries", () => {
    expect(ar.additiveStampInsert(stampLanding(routeOver(stamped(STAMP_IMPORT + `      const k = p?.gap ?? null;\n`)))).ok).toBe(true);
  });
  it("CONTROL (regression guard): the stamp wrapped best-effort in try { } catch { /* … */ } is admitted (try/catch are not forbidden; the catch body is bounded like any line)", () => {
    const wrapped = `      try {\n${STAMP_IMPORT}      } catch { /* stamp is best-effort */ }\n`;
    expect(ar.additiveStampInsert(stampLanding(routeOver(stamped(wrapped)))).ok).toBe(true);
    const badCatch = `      try {\n${STAMP_IMPORT}      } catch {\n        p.gap.status = "closed";\n      }\n`;
    expect(ar.additiveStampInsert(stampLanding(routeOver(stamped(badCatch))))).toMatchObject({ ok: false, why: expect.stringMatching(/assigns to p\.gap\.status/) });
  });
  const helperMf: Array<[string, string, RegExp]> = [
    ["assigns a member of its argument", `export function operatorActsFor(p: any): unknown[] {\n  p.gap.status = "closed";\n  return [];\n}\n`, /assigns to a member \(p\.gap\.status\)/],
    ["??= on a member", `export function operatorActsFor(arg: any): unknown[] {\n  arg.x ??= 1;\n  return [];\n}\n`, /assigns to a member \(arg\.x/],
    ["a computed member assignment", `export function operatorActsFor(arg: any): unknown[] {\n  const k = "status";\n  arg.gap[k] = "closed";\n  return [];\n}\n`, /assigns to a member/],
    ["a delete", `export function operatorActsFor(arg: any): unknown[] {\n  delete arg.y;\n  return [];\n}\n`, /delete/],
    ["a member increment", `export function operatorActsFor(arg: any): unknown[] {\n  arg.n++;\n  return [];\n}\n`, /increments or decrements a member/],
  ];
  for (const [label, body, why] of helperMf) it(`MUST-FAIL (helper never writes): a helper that ${label} is refused`, () => {
    const v = ar.additiveStampInsert(stampLanding(helperOver(body)));
    expect(v.ok).toBe(false);
    expect(String(v.why)).toMatch(why);
  });
  for (const [label, line, why] of armMf) it(`MUST-FAIL (A): an arm insert with ${label} is refused`, () => {
    const v = ar.additiveStampInsert(stampLanding(routeOver(stamped(STAMP_IMPORT + line))));
    expect(v.ok).toBe(false);
    expect(String(v.why)).toMatch(why);
  });
  for (const [label, over, why] of mf) it(`MUST-FAIL: ${label} is refused`, () => {
    const v = ar.additiveStampInsert(stampLanding(over));
    expect(v.ok).toBe(false);
    expect(String(v.why)).toMatch(why);
  });
});

describe("additive registration rule at the landing chokepoint (the real cutover)", () => {
  async function setupReg(changes: Change[], gap: string) {
    const vessel = "development-vessel";
    const mvid = `mitosis-2026-10-10T10-00-00-000Z-additive`;
    const baseRoot = join(ws, "git", "super-repo", "repos", vessel);
    const mitosisRoot = join(ws, "vessels", `${vessel}-${mvid}`);
    const hostRepoRoot = join(ws, "host-repo");
    for (const c of changes) {
      for (const root of [baseRoot, mitosisRoot, hostRepoRoot]) await mkdir(join(root, c.path, ".."), { recursive: true });
      if (c.before !== null) { await writeFile(join(baseRoot, c.path), c.before); await writeFile(join(hostRepoRoot, c.path), c.before); }
      if (c.after !== null) await writeFile(join(mitosisRoot, c.path), c.after);
    }
    await writeFile(join(hostRepoRoot, "README.md"), "fixture\n");
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
    const files = changes.map((c) => c.path);
    const baseSha = sha12(changes[0]!.before ?? "");
    const pendingPath = join(ws, "mitosis-pending.json");
    await writeFile(pendingPath, JSON.stringify({ vessel_name: vessel, base_version_id: "v1", mitosis_version_id: mvid, mitosis_root: mitosisRoot, base_sha: baseSha, authored_by: "patch_with_tools", gap_id: gap, proposal: gap, staged_files: files }, null, 2));
    const pointer = {
      type: "vessel_mitosis_cutover" as const, vessel_name: vessel, base_version_id: "v1", mitosis_version_id: mvid, mitosis_root: mitosisRoot, base_root: baseRoot, host_repo_root: hostRepoRoot,
      staged_base_sha: baseSha, staged_files: files, gap_id: gap, pending_pointer_path: pendingPath, applied_log_path: join(ws, "mitosis-applied.jsonl"), skip_push: true, skip_restart: true,
      proposal_id: gap, evaluation_evidence: { verdict: "FAVORABLE", verdict_reason: "static_checks_pass", base_success_rate: 1, mitosis_success_rate: 1, cited_trace_ids: [], cited_check_names: ["static"] },
    };
    return { vessel, hostRepoRoot, originRoot, originSha, pendingPath, pointer };
  }
  const logs: string[] = [];
  const run = async (changes: Change[], gap: string, advertised: (s: string) => Promise<boolean | null> = notAdvertised) => {
    const s = await setupReg(changes, gap);
    ownCheckPasses(s as never, gapRow(gap, s.vessel, "repos/development-vessel/src/resolvers/gamma-digest.ts"));
    setAdvertised(advertised);
    logs.length = 0;
    const l = spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    try { return { s, r: await resolveVesselMitosisCutover(s.pointer as never) }; } finally { l.mockRestore(); }
  };
  it("CONTROL: an autonomous landing that is a pure new-shape registration of a module it creates LANDS, and says so", async () => {
    const changes = registration();
    const { s, r } = await run(changes, "gap-additive-ok");
    expect({ shape: r.shape, refusal_reason: String(bodyOf(r)["refusal_reason"] ?? "") }).toEqual({ shape: "cutoverApplied", refusal_reason: "" });
    for (const c of changes) expect(git(s.hostRepoRoot, "show", `HEAD:${c.path}`) + "\n").toBe(c.after!.endsWith("\n") ? c.after! : c.after! + "\n");
    expect(logs.some((x) => x.includes("ADDITIVE REGISTRATION admitted") && x.includes("gamma_digest"))).toBe(true);
  });
  it("MUST-FAIL: a removed line in the dispatch table is refused at the chokepoint (autonomy_scope_excluded, naming why)", async () => {
    const changes = registration({ "src/routes/impulses.ts": { path: "src/routes/impulses.ts", before: BASE_ROUTES, after: withCase("gamma_digest", "resolveGammaDigest", "gamma-digest").replace('      throw new Error("Unknown pointer type");\n', "") } });
    const { s, r } = await run(changes, "gap-additive-removed");
    await expectScopeRefused(s as never, r, "autonomy_scope_excluded", [{ entry: "repos/development-vessel/src/routes/impulses.ts", file: "repos/development-vessel/src/routes/impulses.ts" }]);
    expect(String(bodyOf(r)["additive_registration"] ?? "")).toMatch(/removed or modified/);
  });
  it("MUST-FAIL: a valid registration PLUS an added line in another protected file is refused (the rule never widens other paths)", async () => {
    const changes = [...registration(), { path: EXCLUDED_DV, before: "// original\n", after: "// original\n// added\n" }];
    const { s, r } = await run(changes, "gap-additive-other-protected");
    await expectScopeRefused(s as never, r, "autonomy_scope_excluded", [{ entry: SCOPE_BODY.excluded_paths[0]!, file: `repos/development-vessel/${EXCLUDED_DV}` }]);
    expect(logs.some((x) => x.includes("ADDITIVE REGISTRATION admitted"))).toBe(false);
  });
  it("MUST-FAIL: a valid registration PLUS an additive change to a judge file is refused", async () => {
    const changes = [...registration(), { path: "src/judge/gap-policy-extra.ts", before: "export const a = 1;\n", after: "export const a = 1;\nexport const b = 2;\n" }];
    const { s, r } = await run(changes, "gap-additive-judge");
    await expectScopeRefused(s as never, r, "autonomy_scope_excluded", [{ entry: "repos/development-vessel/src/judge/", file: "repos/development-vessel/src/judge/gap-policy-extra.ts" }]);
  });
  it("MUST-FAIL: a registration of a shape discovery already advertises is refused", async () => {
    const { s, r } = await run(registration(), "gap-additive-advertised", async () => true);
    await expectScopeRefused(s as never, r, "autonomy_scope_excluded", [{ entry: "repos/development-vessel/src/config.ts", file: "repos/development-vessel/src/config.ts" }]);
    expect(String(bodyOf(r)["additive_registration"] ?? "")).toMatch(/already advertised/);
  });

  // THE OPERATOR-ACTS STAMP INSERT at the chokepoint (gap-policy.ts additiveStampInsert; user ruling 10-14).
  it("CONTROL: inserted lines inside the substrateGap_write arm plus a new pure stamp helper LAND, and say so", async () => {
    const { s, r } = await run(stampLanding(), "gap-stamp-ok");
    expect({ shape: r.shape, refusal_reason: String(bodyOf(r)["refusal_reason"] ?? "") }).toEqual({ shape: "cutoverApplied", refusal_reason: "" });
    expect(logs.some((x) => x.includes("ADDITIVE STAMP INSERT admitted"))).toBe(true);
  });
  it("MUST-FAIL (3): an insertion outside the substrateGap_write arm is refused at the chokepoint, naming why", async () => {
    const { s, r } = await run(stampLanding({ "src/routes/impulses.ts": { path: "src/routes/impulses.ts", before: STAMP_ROUTES, after: STAMP_ROUTES.replace(SG_READ_ARM, SG_READ_ARM + STAMP_IMPORT) } }), "gap-stamp-outside");
    await expectScopeRefused(s as never, r, "autonomy_scope_excluded", [{ entry: "repos/development-vessel/src/routes/impulses.ts", file: "repos/development-vessel/src/routes/impulses.ts" }, { entry: "repos/development-vessel/src/judge/", file: "repos/development-vessel/src/judge/operator-acts.ts" }]);
    expect(String(bodyOf(r)["additive_registration"] ?? "")).toMatch(/outside the case "substrateGap_write": arm/);
  });
  it("MUST-FAIL (5): a valid stamp insert PLUS an added line in another protected file is refused (every other path stays excluded)", async () => {
    const { s, r } = await run([...stampLanding(), { path: EXCLUDED_DV, before: "// original\n", after: "// original\n// added\n" }], "gap-stamp-other-protected");
    await expectScopeRefused(s as never, r, "autonomy_scope_excluded", [{ entry: SCOPE_BODY.excluded_paths[0]!, file: `repos/development-vessel/${EXCLUDED_DV}` }]);
    expect(logs.some((x) => x.includes("ADDITIVE STAMP INSERT admitted"))).toBe(false);
  });
  it("MUST-FAIL (5): a valid stamp insert PLUS an added line in a judge file (a grader) is refused", async () => {
    const { s, r } = await run([...stampLanding(), { path: "src/judge/gap-admission.ts", before: "export const a = 1;\n", after: "export const a = 1;\nexport const b = 2;\n" }], "gap-stamp-judge");
    await expectScopeRefused(s as never, r, "autonomy_scope_excluded", [{ entry: "repos/development-vessel/src/judge/", file: "repos/development-vessel/src/judge/gap-admission.ts" }]);
    expect(logs.some((x) => x.includes("ADDITIVE STAMP INSERT admitted"))).toBe(false);
  });
});
