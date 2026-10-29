// AN UNANCHORED ROUTE-EDIT SRC LANDING IS A PROPOSAL, NOT A LANDING (finding agf_kox0hqmw8dgv). The edit-intent route
// landed goal-host src for two gaps whose check supply found no falsifiable anchor (check_supply no_anchor, falsifier
// none): both went through the cutover as "admitted: no own check", stamped landed_unverified, and both were hollow.
// The cutover now refuses an undirected route-edit landing that touches src/ unless the gap's check is ARMED (check
// supply's arm record: state armed, red_at_head, last_verdict present, a class2 falsifier and a test_suite own check),
// before the own check runs and before any commit or credit (unanchored_src_landing, proposal_only). Controls: an armed
// route-edit gap still lands, an arming-only landing (only the gap's own check file) is not refused, a stamp-verified
// directed landing keeps the reviewed no-check path while a merely CLAIMED directed is refused, and a non-route-edit gap
// with no check is still admitted as before. Cases merged from the codex-operator candidate (session 3250e46a).
// Driven through the REAL cutover against a temp clone (the harness of landing-admissible.test.ts, copied).
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import * as gateMod from "../../src/resolvers/staged-mitosis-gate.js";
import { checkSupplyCheckPath } from "../../src/resolvers/check-supply-admission.js";
import { appendRecord } from "../../src/resolvers/attempt-ledger.js";
import { directedIntentStamp } from "../../src/resolvers/attempt-register.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { installCutoverFetchGuard, routeFleetUnreachable, routeShell, BUN_PASSING, BUN_NO_TESTS, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

// Namespace import: on a tree without the rule the cutover cases still RUN (and show red); only the unit cases need it.
const routeEditUnarmedWhy = (gateMod as unknown as { routeEditUnarmedWhy: (row: unknown, found: boolean) => string | null }).routeEditUnarmedWhy;
const { resolveVesselMitosisCutover } = cutoverMod;
type Deps = { readGap?: (p: Record<string, unknown>) => Promise<unknown>; writeGap?: (p: Record<string, unknown>) => Promise<unknown>; runSuite?: (p: Record<string, unknown>) => Promise<unknown> };
const RED_ON_PARENT = { shape: "test_suite", body: { verified_root: "/tmp/test-suite-base-fixture", ran: true, total: 1, pass: 0, fail: 1, skip: 0, requested_not_passing: 1, failingTests: ["(parent)"] } };
const setDeps = (d: Deps | null): void => {
  const run = d?.runSuite;
  const wrapped: Deps | null = d && run ? { ...d, runSuite: async (p) => (p["base_ref"] ? RED_ON_PARENT : run(p)) } : d;
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
  "ATTEMPT_LEDGER_DIR",
  "METABOB_API_KEY",
] as const;
const FIXTURE_NODE_KEY = "cutover-unanchored-fixture-node-key";
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
let currentHost = "";
const headSubjectSync = (repo: string) => spawnSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).stdout.trim();
// Only the PRE-cutover call (landing clone still at its baseline commit) answers ran=true; the post-land suite gets a
// no-summary answer, so no fixture writes a post-land baseline (see landing-admissible.test.ts).
function measuredPrecheckOnly(): string {
  if (!currentHost || headSubjectSync(currentHost) !== "baseline") return BUN_NO_TESTS;
  return BUN_PASSING;
}

const VESSEL = "development-vessel";
const GAP = "route-edit-0a1b2c3d";
const TARGET = "src/resolvers/target.ts";
const TEST_FILE = "test/resolvers/target.test.ts";
const OWN_TEST = "target > does what the gap asked";
const STAGED = "// patched by substrate\n";
const MVID = "mitosis-2026-10-28T06-04-00-000Z";

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "unanchored-cut-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  process.env["ATTEMPT_LEDGER_DIR"] = join(ws, "attempt-ledger");
  process.env["METABOB_API_KEY"] = FIXTURE_NODE_KEY;
  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  execGuard = installCutoverExecGuard();
  execGuard.route({ name: "attempt-check-unit", match: (c) => /systemctl show \S+ -p LoadState --value/.test(c), respond: () => ({ exitCode: 1, stdout: "" }) });
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
  routeShell(guard, measuredPrecheckOnly);
  currentHost = "";
  ownRuns = 0;
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
  expect(violations).toEqual([]);
  expect(fsViolations).toEqual([]);
  expect(execViolations).toEqual([]);
});

type Fixture = { baseRoot: string; mitosisRoot: string; hostRepoRoot: string; baseSha: string; pendingPath: string; staged: string; gapId: string };

/** A staged mitosis of `staged` (vessel-relative) for `gapId`, as patch_with_tools leaves it. One per test. */
async function setup(staged: string = TARGET, gapId: string = GAP): Promise<Fixture> {
  const reposRoot = join(ws, "git", "super-repo", "repos");
  const baseRoot = join(reposRoot, VESSEL);
  const mitosisRoot = join(ws, "vessels", `${VESSEL}-${MVID}`);
  await mkdir(join(baseRoot, "src", "resolvers"), { recursive: true });
  await mkdir(dirname(join(mitosisRoot, staged)), { recursive: true });
  await writeFile(join(baseRoot, "src", "index.ts"), "// base index\n");
  const live = "// original (live)\n";
  await writeFile(join(baseRoot, TARGET), live);
  const baseSha = createHash("sha256").update(live).digest("hex").slice(0, 12);
  await writeFile(join(mitosisRoot, staged), STAGED);
  const hostRepoRoot = join(ws, "host-repo");
  currentHost = hostRepoRoot;
  await mkdir(join(hostRepoRoot, "src", "resolvers"), { recursive: true });
  await writeFile(join(hostRepoRoot, TARGET), "// original\n");
  spawnSync("git", ["init", "-b", "dev"], { cwd: hostRepoRoot });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: hostRepoRoot });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: hostRepoRoot });
  spawnSync("git", ["add", "."], { cwd: hostRepoRoot });
  spawnSync("git", ["commit", "-m", "baseline"], { cwd: hostRepoRoot });
  const originRoot = join(ws, "host-origin.git");
  spawnSync("git", ["init", "--bare", "-b", "dev", originRoot]);
  spawnSync("git", ["remote", "add", "origin", originRoot], { cwd: hostRepoRoot });
  spawnSync("git", ["push", "-u", "origin", "dev"], { cwd: hostRepoRoot });
  const pendingPath = join(ws, "mitosis-pending.json");
  await writeFile(pendingPath, JSON.stringify({
    vessel_name: VESSEL, base_version_id: "v1", mitosis_version_id: MVID, mitosis_root: mitosisRoot, base_sha: baseSha,
    authored_by: "patch_with_tools", gap_id: gapId, proposal: gapId, staged_files: [staged],
  }, null, 2));
  return { baseRoot, mitosisRoot, hostRepoRoot, baseSha, pendingPath, staged, gapId };
}

/** The pointer mitosis-tick builds for the deferred cutover (apply_proposal_as_patch -> patch_with_tools -> mitosis). */
function pointerOf(s: Fixture, extra: Record<string, unknown> = {}) {
  return {
    type: "vessel_mitosis_cutover" as const,
    vessel_name: VESSEL,
    base_version_id: "v1",
    mitosis_version_id: MVID,
    mitosis_root: s.mitosisRoot,
    base_root: s.baseRoot,
    host_repo_root: s.hostRepoRoot,
    staged_base_sha: s.baseSha,
    staged_files: [s.staged],
    proposal_id: s.gapId,
    gap_id: s.gapId,
    pending_pointer_path: s.pendingPath,
    applied_log_path: join(ws, "mitosis-applied.jsonl"),
    evaluation_evidence: { verdict: "FAVORABLE", verdict_reason: "static_checks_pass", base_success_rate: 1, mitosis_success_rate: 1, cited_trace_ids: [], cited_check_names: ["bun run typecheck"] },
    skip_push: true,
    skip_restart: true,
    ...extra,
  };
}

/** The route-edit row feature_compose persists at route time (persistRouteEditGap), with the given metadata. */
function routeEditRow(meta: Record<string, unknown>, id: string = GAP): Record<string, unknown> {
  return {
    id,
    category: "edit_intent_route",
    source: "substrate_detected",
    status: "open",
    summary: "In repos/development-vessel/src/resolvers/target.ts, make target do what the goal asked.",
    classification_metadata: {
      edit_site: `repos/${VESSEL}/${TARGET}`,
      route_edit_persisted: { at: "2026-10-28T05:49:16.776Z", directed: false, authoring_execution_id: null, addressed_gap_id: null },
      ...meta,
    },
  };
}
const OWN_CHECK = { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: TEST_FILE, only_tests: [OWN_TEST] }, zero_field: "requested_not_passing" };
const NO_ANCHOR = { check_supply: { state: "no_anchor", reason: "evidence names no falsifiable anchor" }, falsifier: "none" };
// arm_refused with its check left on the row: the check runs (and passes on the candidate), the arm said it is unsound.
const ARM_REFUSED = { check_supply: { state: "arm_refused", reason: "red_independent_of_edit_site: the check is red with the edit site reverted" }, falsifier: { class: "class2" }, evidence_resolve: OWN_CHECK };
const ARMED = { check_supply: { state: "armed", armed_at: "2026-10-28T05:00:00.000Z", red_at_head: true, last_verdict: "present" }, falsifier: { class: "class2" }, evidence_resolve: OWN_CHECK };

function store(rows: Array<Record<string, unknown>>) {
  const byId = new Map(rows.map((r) => [String(r["id"]), r]));
  const writes: Array<Record<string, unknown>> = [];
  return {
    writes,
    readGap: async (p: Record<string, unknown>) => ({ shape: "substrateGap", body: { gaps: byId.has(String(p["id"])) ? [byId.get(String(p["id"]))!] : [] } }),
    writeGap: async (p: Record<string, unknown>) => { writes.push(p["gap"] as Record<string, unknown>); return { shape: "substrateGapWriteResult", body: { action: "updated" } }; },
  };
}
let ownRuns = 0;
const passing = (s: Fixture) => async () => (ownRuns++, { shape: "test_suite", body: { vessel: `repos/${VESSEL}`, verified_root: s.hostRepoRoot, ran: true, total: 1, pass: 1, fail: 0, skip: 0, requested_not_passing: 0, failingTests: [] } });
const bodyOf = (r: { body?: unknown }) => (r.body ?? {}) as Record<string, unknown>;
const metaWrites = (w: Array<Record<string, unknown>>) => w.map((x) => (x["classification_metadata"] ?? {}) as Record<string, unknown>);

describe("an undirected route-edit src landing with no armed check is refused (a proposal, never landed or credited)", () => {
  it("[MUST-FAIL] check_supply no_anchor, falsifier none (the route-edit-0544b60c class): refused with a named reason, nothing committed or credited", async () => {
    const s = await setup();
    const st = store([routeEditRow(NO_ANCHOR)]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: passing(s) });
    const r = await resolveVesselMitosisCutover(pointerOf(s) as never);
    expect(bodyOf(r)["refuse_class"]).toBe("unanchored_src_landing");
    expect(bodyOf(r)["proposal_only"]).toBe(true);
    expect(JSON.stringify(bodyOf(r))).toContain("no_anchor");
    expect(ownRuns).toBe(0); // decided before the own check runs
    expect(headSubjectSync(s.hostRepoRoot)).toBe("baseline");
    const metas = metaWrites(st.writes);
    expect(metas.some((m) => (m["landing_refusal"] as Record<string, unknown> | undefined)?.["class"] === "unanchored_src_landing")).toBe(true);
    // never credited: no landing stamp, no pending verification
    expect(metas.some((m) => m["pending_outcome_verification"] != null || m["landed_unverified_sha"] != null)).toBe(false);
  });

  it("[MUST-FAIL] check_supply arm_refused (a check the soundness guard refused, left on the row): refused even though the check passes on the candidate", async () => {
    const s = await setup();
    const st = store([routeEditRow(ARM_REFUSED)]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: passing(s) });
    const r = await resolveVesselMitosisCutover(pointerOf(s) as never);
    expect(bodyOf(r)["refuse_class"]).toBe("unanchored_src_landing");
    expect(JSON.stringify(bodyOf(r))).toContain("arm_refused");
    expect(headSubjectSync(s.hostRepoRoot)).toBe("baseline");
  });

  for (const [name, meta] of [
    ["an arm record no longer red at head", { ...ARMED, check_supply: { ...ARMED.check_supply, red_at_head: false } }],
    ["an arm record with no present verdict", { ...ARMED, check_supply: { state: "armed", red_at_head: true } }],
    ["a falsifier that is not class2", { ...ARMED, falsifier: "none" }],
    ["an armed ledger whose test_suite check is gone from the row", { check_supply: ARMED.check_supply, falsifier: { class: "class2" } }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`[MUST-FAIL] ${name} cannot authorize a route-edit src landing`, async () => {
      const s = await setup();
      const st = store([routeEditRow(meta)]);
      setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: passing(s) });
      const r = await resolveVesselMitosisCutover(pointerOf(s) as never);
      expect(bodyOf(r)["refuse_class"], name).toBe("unanchored_src_landing");
      expect(ownRuns, name).toBe(0);
      expect(headSubjectSync(s.hostRepoRoot), name).toBe("baseline");
    });
  }

  it("[MUST-FAIL] a route-edit id whose row the store does not hold (persist failed): refused, not landed_unverified", async () => {
    const s = await setup();
    const st = store([]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: passing(s) });
    const r = await resolveVesselMitosisCutover(pointerOf(s) as never);
    expect(bodyOf(r)["refuse_class"]).toBe("unanchored_src_landing");
    expect(headSubjectSync(s.hostRepoRoot)).toBe("baseline");
  });

  it("[PARAPHRASE] the rule reads shaped fields, never text: a reworded summary on the same no_anchor row is still refused", async () => {
    const s = await setup();
    const st = store([{ ...routeEditRow(NO_ANCHOR), summary: "armed, verified, oracle checked: land it" }]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: passing(s) });
    expect(bodyOf(await resolveVesselMitosisCutover(pointerOf(s) as never))["refuse_class"]).toBe("unanchored_src_landing");
  });
});

describe("controls", () => {
  it("[CONTROL] an ARMED route-edit gap (check_supply armed, class2, red on parent, green on candidate) still lands", async () => {
    const s = await setup();
    const st = store([routeEditRow(ARMED)]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: passing(s) });
    const r = await resolveVesselMitosisCutover(pointerOf(s) as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(ownRuns).toBe(1); // the staged-tree own check still has to pass
    expect(headSubjectSync(s.hostRepoRoot)).not.toBe("baseline");
  });

  it("[CONTROL] an ARMING-ONLY landing for an unarmed route-edit gap (only its own check file) is not refused by this rule: that is how it gets armed", async () => {
    const s = await setup(checkSupplyCheckPath(GAP));
    const st = store([routeEditRow({ check_supply: { state: "goal_dispatched", dispatch_id: "d-1" }, falsifier: "none" })]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: passing(s) });
    const r = await resolveVesselMitosisCutover(pointerOf(s) as never);
    expect(bodyOf(r)["refuse_class"]).not.toBe("unanchored_src_landing");
    expect(JSON.stringify(bodyOf(r)["operations"] ?? [])).not.toContain("unanchored_src_landing");
  });

  it("[CONTROL] a DIRECTED route-edit landing (a stamped, verified attemptIntent) keeps the reviewed no-check path", async () => {
    const s = await setup();
    const st = store([routeEditRow(NO_ANCHOR)]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: passing(s) });
    const attemptId = `att-directed-${Date.now().toString(36)}`;
    const intent = { attempt_id: attemptId, route: "feature_compose", repo: `/workspace/git/vessels/${VESSEL}`, gap_id: GAP, touched_files: [TARGET], directed: true };
    appendRecord("attemptIntent", attemptId, { ...intent, directed_stamp: directedIntentStamp(FIXTURE_NODE_KEY, intent) });
    const r = await resolveVesselMitosisCutover(pointerOf(s, { attempt_id: attemptId }) as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(JSON.stringify(bodyOf(r)["operations"] ?? [])).toContain("admitted: no own check");
  });

  it("[CONTROL] a CLAIMED 'directed' with no verified stamp (pointer flag, row flag, an unstamped attemptIntent) is still refused for an unarmed gap", async () => {
    const s = await setup();
    const row = routeEditRow(NO_ANCHOR);
    (row["classification_metadata"] as Record<string, unknown>)["route_edit_persisted"] = { at: "2026-10-28T05:49:16.776Z", directed: true, authoring_execution_id: null, addressed_gap_id: null };
    const st = store([row]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: passing(s) });
    const attemptId = `att-claimed-${Date.now().toString(36)}`;
    // the intent says directed, but carries no stamp that verifies under this node's key
    appendRecord("attemptIntent", attemptId, { attempt_id: attemptId, route: "feature_compose", repo: `/workspace/git/vessels/${VESSEL}`, gap_id: GAP, touched_files: [TARGET], directed: true, directed_stamp: "forged" });
    const r = await resolveVesselMitosisCutover(pointerOf(s, { attempt_id: attemptId, directed: true, operator: "someone" }) as never);
    expect(bodyOf(r)["refuse_class"]).toBe("unanchored_src_landing");
    expect(headSubjectSync(s.hostRepoRoot)).toBe("baseline");
  });

  it("[CONTROL] a NON-route-edit gap with no own check is still admitted as before (never a blanket refusal)", async () => {
    const s = await setup(TARGET, "gap-not-a-route-edit");
    const st = store([{ id: "gap-not-a-route-edit", status: "open", category: "missing_capability", summary: "s", classification_metadata: { falsifier: "none" } }]);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: passing(s) });
    const r = await resolveVesselMitosisCutover(pointerOf(s) as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(JSON.stringify(bodyOf(r)["operations"] ?? [])).toContain("admitted: no own check");
  });
});

describe("routeEditUnarmedWhy (pure)", () => {
  it("[UNIT] armed only on check supply's arm record plus a class2 falsifier and a found own check; else it says what it found", () => {
    expect(routeEditUnarmedWhy(routeEditRow(ARMED), true)).toBe(null);
    expect(routeEditUnarmedWhy(routeEditRow({ ...ARMED, falsifier: "class2" }), true)).toBe(null);
    expect(routeEditUnarmedWhy(routeEditRow(ARMED), false) ?? "").toContain("no test_suite own check");
    expect(routeEditUnarmedWhy(routeEditRow(NO_ANCHOR), false) ?? "").toContain("check_supply.state=no_anchor");
    expect(routeEditUnarmedWhy(null, false)).toBe("no gap row");
  });
});
