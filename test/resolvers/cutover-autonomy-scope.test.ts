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
import { installCutoverFetchGuard, routeFleetUnreachable, routeShell, BUN_NO_TESTS, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";

const { resolveVesselMitosisCutover, __setOwnCheckDepsForTests } = cutoverMod;
const { __resetPolicyReadsForTests, autonomyScopeExcludes } = await import("../../src/resolvers/gap-to-feature.js");
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
let errLines: string[] = [];
let errSpy: ReturnType<typeof spyOn> | null = null;
afterAll(() => {
  restoreCutoverFsModules();
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
  excluded_paths: ["repos/development-vessel/src/resolvers/feature-compose.ts", "repos/goal-host-vessel/src/index.ts", "scripts/substrate/"],
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
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
  // The pre-cutover suite: a run with no tests (ran=false); the gap's own check is the measurement.
  routeShell(guard, () => {
    if (!currentHost || git(currentHost, "log", "-1", "--format=%s") !== "baseline") return BUN_NO_TESTS;
    return `VERIFIED_ROOT=${currentHost}\nVERIFIED_HEAD=abc1234\n${BUN_NO_TESTS}`;
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
  __setOwnCheckDepsForTests(null);
  __resetPolicyReadsForTests();
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
    const { autonomyScope } = await import("../../src/resolvers/gap-to-feature.js");
    expect(autonomyScopeExcludes(await autonomyScope(), "repos/goal-host-vessel/src/index.ts")).toBe("repos/goal-host-vessel/src/index.ts");
    __resetPolicyReadsForTests();
    const s = await setup({ route: "apply_proposal_as_patch", vessel: "goal-host-vessel", files: ["src/index.ts"], gap });
    ownCheckPasses(s, minted);
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    await expectScopeRefused(s, r, "autonomy_scope_excluded", [{ entry: "repos/goal-host-vessel/src/index.ts", file: "repos/goal-host-vessel/src/index.ts" }]);
  });
});
