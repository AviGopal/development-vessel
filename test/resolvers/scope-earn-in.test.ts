// SCOPE EARN-IN BY THE ADOPTED CRITERION (REALIGNMENT §7 step 9; §2.0 consolidate, do not mint).
//
// The excluded paths of autonomyScope changed only by an operator editing the record, so autonomy could never earn
// its way into the core. The user adopted a criterion on 10-03 (goal-learn-flow/WIRING.md "USER RULING (10-03):
// scope widening on evidence is ADOPTED", and "covered is defined by MUTATION"): a file leaves excluded_paths when
// every regression it has historically had maps to an ARMED must-fail, and each of those must-fails goes red when
// the shipped guard is removed. These tests pin the organs that apply it without an operator:
//   (a) a rhythm-paced tick (scope_earn_in_tick) evaluates each excluded FILE and PROPOSES a scope change as a shape
//       (autonomyScopeProposal) with its evidence; it never writes autonomyScope;
//   (b) a file with an unmapped regression, a must-fail that survives the mutation, no regression history, or a
//       path the runtime executes straight from the clone (glue under SUBSTRATE_ROOT) gets no proposal, with the
//       reason named;
//   (c) the proposal is applied only by the ACCEPTED evaluator (scope_earn_in_apply, run beside the landing sweep),
//       which RE-EVALUATES the evidence itself on the accepted tree and never reads the proposal's evidence; it
//       writes autonomyScope through the pool's one writer with an evaluator attestation (no operator key), plus an
//       append-only autonomyScopeChange record carrying a one-step undo, and reports to the surface humans read;
//   (d) a tightening (adding a path) needs less evidence (an open, unreverted regression) and carries a TTL; it is
//       lifted by expiry;
//   (e) the mutation runner is test_suite's base-tree run with mutate_revert: the guard commit's change to the file
//       is reverse-applied in the detached worktree, never in the clone;
//   (f) the exit metric: criterion-made changes applied with no operator record edit in between.
//
// Hermetic: the gap store, scope, rhythm, check runner and human report are injected fakes; the pool is the real
// store pointed at this file's own temp file (never the workspace's); fetch is a guard that records any
// call as a violation; host-lifecycle exec is blocked. The one real subprocess is git on a temp repository.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

const ROOT = join(tmpdir(), `scope-earn-in-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const pool = await import("../../src/resolvers/pool-impulse.js");
const conductor = await import("../../src/resolvers/rhythm-conductor-tick.js");
const testSuite = await import("../../src/resolvers/test-suite.js");
// The organ under test. Absent at the base, so every test below fails on its own assertion, not on a load error.
const earn = (await import("../../src/resolvers/scope-earn-in.js").catch(() => null)) as null | Record<string, any>;
const seed = (await import("../../src/seed/scope-earn-in-tick.js").catch(() => null)) as null | Record<string, any>;

type Row = Record<string, unknown>;
// The pool is this file's own temp store (pool.__setPoolFileForTests), whatever root config.ts captured first.
const POOL_FILE = join(ROOT, "pool", "standing.json");
// Without the seam (the base) the pool would be the workspace's: nothing below touches it then.
const POOL_SEAM = typeof (pool as Record<string, any>)["__setPoolFileForTests"] === "function";
const SCOPE_ID = "autonomy-scope";
const V = "development-vessel";
const FILE_A = `repos/${V}/src/resolvers/fixture-earn-a.ts`;
const FILE_B = `repos/${V}/src/resolvers/fixture-earn-b.ts`;
const FILE_C = `repos/${V}/src/resolvers/fixture-earn-c.ts`;
const IN_SCOPE = `repos/${V}/src/resolvers/fixture-in-scope.ts`;
const GLUE = "scripts/substrate/fixture-glue.ts";
const UNIT_GLUE = `repos/${V}/src/fixture-unit-glue.ts`;
const GUARD = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
// The sha pull-sync last mirrored healthy for the vessel (the RUNTIME), behind the clone's HEAD.
const RUNTIME = "0123456789abcdef0123456789abcdef01234567";
const EVAL_FILE = `repos/${V}/src/resolvers/scope-earn-in.ts`;
const BASE_EXCLUDED = [FILE_A, FILE_B, FILE_C, GLUE, UNIT_GLUE, "repos/identity-vessel/"];
const FIXTURE_OPERATIONAL = new Set([FILE_A, FILE_B, FILE_C, IN_SCOPE, GLUE, UNIT_GLUE, "repos/identity-vessel/"]);

const originalFetch = globalThis.fetch;
let violations: string[] = [];
let execGuard: ExecGuard | null = null;
let gaps: Row[] = [];
let rhythm: { id: string; body: Row; updated_at?: string } | null = null;
let settled: Array<{ leg: string }> = [];
let paceSeq = 0;
let checks: Row[] = [];
let reports: Row[] = [];
let writes: Array<{ pointer: Row; auth: unknown; nargs: number }> = [];
let unitsText = "";
let nowMs = Date.parse("2026-10-05T12:00:00.000Z");
// The check runner's behaviour per named test: green unmutated, and red under mutation unless it "survives".
let survives = new Set<string>();
let redAtHead = new Set<string>();
let mutationFails = new Set<string>();
// Green at the clone HEAD but red at the runtime sha: the fix is pushed, not mirrored.
let redAtRuntimeOnly = new Set<string>();
let runtimePin: string | null = RUNTIME;
// QUALIFY RULE (a), user ruling 10-05 21:55Z, as reworked for qa: a file with no regression history qualifies when its
// EXISTING tests kill deterministic mutants of the file ITSELF. The fake tree below holds the target sources and test
// sources at the runtime sha; the fake runner decides, per test file, which mutants it kills.
const NEW_VERSION = "wiring-2026-10-05-qualify-a";
const COVER_TEST = "test/resolvers/fixture-cover.test.ts";
const OTHER_TEST = "test/resolvers/fixture-other.test.ts";
// A small, mutable target: two functions, an if, a comparison and a boolean, so every operator has a site.
const TARGET_SRC = `export function a(x: number): number {\n  if (x > 0) return x;\n  return -x;\n}\nexport function flag(): boolean {\n  return true;\n}\nexport const ok = (n: number) => n === 1;\n`;
let treeFiles = new Map<string, string | null>();
let listFails = false;
let sourceReads: Array<{ vessel: string; sha: string; path: string }> = [];
// test file -> "all" (kills every mutant), "none" (asserts nothing about the file), or a set of operator names it kills.
let kills = new Map<string, "all" | "none" | Set<string>>();
let redTests = new Set<string>();
let editFails = false;
let editGateRefused = false;

const dueRhythm = (extra: Row = {}): { id: string; body: Row; updated_at: string } => ({
  id: "rhythm-scope-earn-in", updated_at: new Date(nowMs).toISOString(),
  body: { axis: "load", family: "scope-earn-in", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 10, tighten_ttl_hours: 48, ...extra },
});

function armedCheck(title: string, vessel = V): Row {
  return { shape: "test_suite", input: { vessel: `repos/${vessel}`, test_file: "test/resolvers/fixture-earn.test.ts", only_tests: [title] }, zero_field: "requested_not_passing" };
}
function regression(id: string, site: string, meta: Row = {}, status = "closed"): Row {
  return {
    id, category: "systematic_failure", source: "operator", status, summary: `regression ${id}`, detected_at: "2026-09-20T00:00:00.000Z",
    reopen_count: 1,
    classification_metadata: { edit_site: site, falsifier: { class: "class2" }, evidence_resolve: armedCheck(`guards ${id}`), landed_sha: GUARD, ...meta },
  };
}

function fakeCheck(input: Row): Row {
  checks.push(input);
  const only = (input["only_tests"] as string[]) ?? [];
  const title = only[0] ?? "";
  const mutated = !!input["mutate_revert"];
  if (mutated && mutationFails.has(title)) return { ran: false, total: 0, mutation: { applied: false }, failingTests: [], requested_not_passing: null };
  const atRuntime = input["base_ref"] === RUNTIME;
  // A whole-test-file run (no only_tests): the coverage path.
  if (only.length === 0) {
    const tf = String(input["test_file"] ?? "");
    const edit = input["mutate_edit"] as Row | undefined;
    if (edit && editGateRefused) return { ran: false, total: 0, pass: 0, fail: 0, failingTests: [], mutation: { kind: "edit", applied: false }, gate_refused: "write refused by containment", base_ref: input["base_ref"] ?? null };
    if (edit && editFails) return { ran: false, total: 0, pass: 0, fail: 0, failingTests: [], mutation: { kind: "edit", applied: false }, base_ref: input["base_ref"] ?? null };
    const k = kills.get(tf) ?? "none";
    const killed = !!edit && (k === "all" || (k instanceof Set && k.has(String(edit["operator"]))));
    const red = killed || redTests.has(tf);
    return {
      ran: true, total: 3, pass: red ? 2 : 3, fail: red ? 1 : 0, failingTests: red ? [`(fail) ${tf} > a test`] : [], requested_not_passing: null,
      verified_head: "feedc0de", base_ref: input["base_ref"] ?? null, ...(edit ? { mutation: { kind: "edit", file: edit["file"], applied: true } } : {}),
    };
  }
  const red = mutated ? !survives.has(title) : redAtHead.has(title) || (atRuntime && redAtRuntimeOnly.has(title));
  return {
    ran: true, total: only.length, pass: red ? 0 : only.length, fail: red ? only.length : 0,
    failingTests: red ? only.map((t) => `(fail) ${t}`) : [], requested_not_passing: red ? only.length : 0,
    verified_head: "feedc0de", base_ref: input["base_ref"] ?? null, ...(mutated ? { mutation: { applied: true } } : {}),
  };
}

function poolRows(shape: string, status = "open"): Row[] {
  return (pool.resolvePoolImpulse({ type: "poolImpulse", shape, status }).body.impulses ?? []) as unknown as Row[];
}
function scopeRow(): Row {
  return poolRows("autonomyScope")[0]!;
}
function seedScope(excluded: string[]): void {
  const w = pool.resolvePoolImpulseWrite({ type: "poolImpulse_write", id: SCOPE_ID, shape: "autonomyScope", source: "operator", body: { excluded_paths: excluded, require_falsifier_classes: ["class2"] } }, { operator: true, key_id: "test-operator" });
  if (!w.body.ok) throw new Error("scope seed refused: " + JSON.stringify(w.body));
}
function clearPool(): void {
  mkdirSync(join(ROOT, "pool"), { recursive: true });
  writeFileSync(POOL_FILE, "[]");
}

beforeAll(() => {
  (pool as Record<string, any>)["__setPoolFileForTests"]?.(POOL_FILE);
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    violations.push(`${init?.method ?? "GET"} ${String(input)}`);
    return Response.json({});
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  earn?.__setScopeEarnInDepsForTests?.(null);
  (pool as Record<string, any>)["__setPoolFileForTests"]?.(null);
  restoreCutoverExecModules();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => {
  violations = []; gaps = []; settled = []; checks = []; reports = []; writes = [];
  survives = new Set(); redAtHead = new Set(); mutationFails = new Set(); redAtRuntimeOnly = new Set(); runtimePin = RUNTIME;
  sourceReads = []; listFails = false; editFails = false; editGateRefused = false; redTests = new Set();
  kills = new Map([[COVER_TEST, "all"]]);
  treeFiles = new Map<string, string | null>([
    ["src/resolvers/fixture-earn-a.ts", TARGET_SRC], ["src/resolvers/fixture-earn-b.ts", TARGET_SRC], ["src/resolvers/fixture-earn-c.ts", TARGET_SRC],
    // By default no test imports a fixture file: the regression-history tests above see no coverage.
    [COVER_TEST, `import { describe, it } from "bun:test";\n`],
  ]);
  unitsText = `ExecStart=/usr/bin/bun \${SUBSTRATE_ROOT}/${UNIT_GLUE}\n`;
  nowMs = Date.parse("2026-10-05T12:00:00.000Z");
  rhythm = dueRhythm();
  execGuard = installCutoverExecGuard();
  if (!POOL_SEAM) return;
  clearPool();
  seedScope(BASE_EXCLUDED);
  earn?.__setScopeEarnInDepsForTests?.({
    readGaps: async () => gaps,
    readScope: async () => {
      const r = scopeRow();
      return { excluded: ((r["body"] as Row)["excluded_paths"] as string[]) ?? [], readable: true, reason: "test" };
    },
    readRhythm: async () => rhythm,
    // The family's rhythm row as the pool would hold it: a write merges its overlay and moves updated_at; a write with
    // ifUpdatedAt is a compare-and-set that fails when the row moved since it was read.
    pace: async (_r: unknown, overlay: Row, ifUpdatedAt?: string) => {
      if (!rhythm) return false;
      if (ifUpdatedAt !== undefined && ifUpdatedAt !== rhythm.updated_at) return false;
      paceSeq += 1;
      rhythm = { ...rhythm, updated_at: new Date(nowMs + paceSeq).toISOString(), body: { ...rhythm.body, ...overlay } };
      settled.push({ leg: "alpha" in overlay ? "alpha" : "beta" in overlay ? "beta" : "ran" });
      return true;
    },
    runCheck: async (input: Row) => fakeCheck(input),
    poolRead: (shape: string) => poolRows(shape),
    poolWrite: (pointer: Row, ...rest: unknown[]) => {
      writes.push({ pointer, auth: rest[0], nargs: 1 + rest.length });
      return pool.resolvePoolImpulseWrite(pointer as never, rest[0] as never);
    },
    report: async (panel: Row) => { reports.push(panel); },
    unitsText: () => unitsText,
    runtimeSha: () => runtimePin,
    readFileAt: (vessel: string, sha: string, path: string) => { sourceReads.push({ vessel, sha, path }); return treeFiles.has(path) ? treeFiles.get(path)! : null; },
    // The fixtures are OPERATIONAL here (fixture-only); every real path is classified by the shipped table.
    classify: (path: string) => (FIXTURE_OPERATIONAL.has(path) ? { class: "operational", reason: "test fixture" } : ((earn?.["SCOPE_CLASSIFICATION"] as Record<string, Row> | undefined)?.[path] as never) ?? null),
    testFilesMentioning: (_vessel: string, _sha: string, needle: string) => (listFails ? null : [...treeFiles.entries()].filter(([p, c]) => /\.test\.ts$/.test(p) && c !== null && c.includes(needle)).map(([p]) => p)),
    now: () => nowMs,
  });
});
afterEach(() => {
  const blocked = execGuard?.restore() ?? [];
  expect(blocked).toEqual([]);
  expect(violations).toEqual([]);
});

async function tick(pointer: Row = {}): Promise<Row> {
  expect(POOL_SEAM).toBe(true);
  expect(earn?.["resolveScopeEarnInTick"]).toBeInstanceOf(Function);
  const r = await earn!.resolveScopeEarnInTick({ type: "scope_earn_in_tick", ...pointer });
  return r.body as Row;
}
async function apply(): Promise<Row> {
  expect(POOL_SEAM).toBe(true);
  expect(earn?.["applyScopeProposals"]).toBeInstanceOf(Function);
  return (await earn!.applyScopeProposals()) as Row;
}
const proposals = (): Row[] => poolRows("autonomyScopeProposal");
const changes = (): Row[] => poolRows("autonomyScopeChange");
const excludedNow = (): string[] => ((scopeRow()["body"] as Row)["excluded_paths"] as string[]);
function propose(path: string, change: "widen" | "tighten", body: Row = {}): string {
  expect(POOL_SEAM).toBe(true);
  const id = `scope-proposal-test-${Math.random().toString(36).slice(2, 8)}`;
  const w = pool.resolvePoolImpulseWrite({ type: "poolImpulse_write", id, shape: "autonomyScopeProposal", source: "test", body: { path, change, criterion_version: "wiring-2026-10-03", ...body } });
  if (!w.body.ok) throw new Error("proposal seed refused");
  return id;
}

describe("scope earn-in: the proposing activity (must-fail at base)", () => {
  it("proposes exactly one widening, with its evidence, for a file whose every regression maps to an armed, mutation-covered must-fail", async () => {
    gaps = [regression("reg-a1", FILE_A), regression("reg-a2", FILE_A, { regressed_by: { sha: "0badc0de", revert_sha: GUARD, by: "operator" }, landed_sha: undefined })];
    const body = await tick();
    const ps = proposals();
    expect(ps.length).toBe(1);
    const p = ps[0]!["body"] as Row;
    expect(p["path"]).toBe(FILE_A);
    expect(p["change"]).toBe("widen");
    expect(p["criterion_version"]).toBe(NEW_VERSION);
    const ev = p["evidence"] as Row[];
    expect(ev.map((e) => e["gap_id"]).sort()).toEqual(["reg-a1", "reg-a2"]);
    for (const e of ev) {
      expect(e["guard_commit"]).toBe(GUARD);
      expect((e["must_fail"] as Row)["only_tests"]).toEqual([`guards ${String(e["gap_id"])}`]);
      expect((e["mutated"] as Row)["red"]).toBe(true);
      expect((e["unmutated"] as Row)["green"]).toBe(true);
    }
    // Every run is on the RUNTIME's sha (never the clone's HEAD), and the mutation reverts the guard commit's change
    // to THAT file there.
    expect(checks.length).toBe(4);
    for (const c of checks) expect(c["base_ref"]).toBe(RUNTIME);
    const mutated = checks.filter((c) => c["mutate_revert"]);
    expect(mutated.length).toBe(2);
    for (const c of mutated) {
      expect(c["mutate_revert"]).toEqual({ sha: GUARD, file: "src/resolvers/fixture-earn-a.ts" });
    }
    expect((body["proposed"] as Row[]).map((x) => x["path"])).toEqual([FILE_A]);
    expect(settled).toEqual([{ leg: "ran" }, { leg: "alpha" }]);
  });

  it("a file with an unmapped regression gets no proposal and the reason names the missing check", async () => {
    gaps = [regression("reg-b1", FILE_B), regression("reg-b2", FILE_B, { evidence_resolve: undefined, falsifier: { class: "unset" } })];
    const body = await tick();
    expect(proposals()).toEqual([]);
    const out = (body["evaluated"] as Row[]).find((e) => e["path"] === FILE_B)!;
    expect(out["verdict"]).toBe("not_covered");
    expect(String(out["reason"])).toContain("reg-b2");
    expect(String(out["reason"])).toContain("armed must-fail");
    // Mapping fails before anything runs: no test run is spent on a file that cannot qualify.
    expect(checks.filter((c) => String((c["only_tests"] as string[])[0]).includes("reg-b"))).toEqual([]);
  });

  it("a file whose must-fail survives the mutation gets no proposal", async () => {
    gaps = [regression("reg-c1", FILE_C)];
    survives.add("guards reg-c1");
    const body = await tick();
    expect(proposals()).toEqual([]);
    const out = (body["evaluated"] as Row[]).find((e) => e["path"] === FILE_C)!;
    expect(out["verdict"]).toBe("not_covered");
    expect(String(out["reason"])).toContain("survives");
  });

  it("a must-fail red at HEAD without mutation, or a mutation that cannot apply, proposes nothing", async () => {
    gaps = [regression("reg-c2", FILE_C), regression("reg-b3", FILE_B)];
    redAtHead.add("guards reg-c2");
    mutationFails.add("guards reg-b3");
    const body = await tick();
    expect(proposals()).toEqual([]);
    const ev = body["evaluated"] as Row[];
    expect(ev.find((e) => e["path"] === FILE_C)!["verdict"]).toBe("not_covered");
    expect(ev.find((e) => e["path"] === FILE_B)!["verdict"]).toBe("unjudgeable");
  });

  it("no regression history on record proposes nothing (vacuous coverage is not coverage)", async () => {
    gaps = [];
    const body = await tick();
    expect(proposals()).toEqual([]);
    const out = (body["evaluated"] as Row[]).find((e) => e["path"] === FILE_A)!;
    expect(String(out["reason"])).toContain("no_regression_history");
  });

  it("runtime glue executed from the clone is never proposed, whatever its evidence; a directory entry is reported, not skipped", async () => {
    gaps = [regression("reg-g1", GLUE), regression("reg-u1", UNIT_GLUE)];
    const body = await tick();
    expect(proposals()).toEqual([]);
    const ev = body["evaluated"] as Row[];
    for (const p of [GLUE, UNIT_GLUE]) expect(String(ev.find((e) => e["path"] === p)!["reason"])).toContain("runtime glue is executed from the clone (ungated)");
    expect(String(ev.find((e) => e["path"] === "repos/identity-vessel/")!["reason"])).toContain("not_evaluated(directory)");
    expect(checks).toEqual([]);
  });

  it("the proposing activity never writes autonomyScope and never carries a credential", async () => {
    gaps = [regression("reg-a1", FILE_A)];
    const before = scopeRow();
    await tick();
    expect(proposals().length).toBe(1);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.pointer["shape"]).not.toBe("autonomyScope");
      expect(w.pointer["id"]).not.toBe(SCOPE_ID);
      expect(w.auth).toBeUndefined();
    }
    expect(scopeRow()["updated_at"]).toBe(before["updated_at"]);
    expect(excludedNow()).toEqual(BASE_EXCLUDED);
  });

  it("the cadence is a rhythm read at use time: no rhythm or not due does nothing, and max_per_tick bounds the work", async () => {
    gaps = [regression("reg-a1", FILE_A), regression("reg-b1", FILE_B), regression("reg-c1", FILE_C)];
    rhythm = null;
    expect((await tick())["reason"]).toBe("no_rhythm");
    rhythm = dueRhythm({ staleness: 0, alpha: 1, beta: 9 });
    rhythm.updated_at = new Date().toISOString();
    expect((await tick())["reason"]).toBe("not_due");
    expect(checks).toEqual([]);
    rhythm = dueRhythm({ max_per_tick: 1 });
    await tick();
    expect(proposals().length).toBe(1);
    // The conductor fires the family directly and leaves it pending: the tick settles it from its report.
    expect(conductor.FAMILY_RESOLVERS["scope-earn-in"]).toEqual({ type: "scope_earn_in_tick", settled_by: "report" });
    const t = seed?.["SCOPE_EARN_IN_TICK_TEMPLATE"] as Row | undefined;
    expect(((t?.["tasks"] as Row[]) ?? [])[0]?.["resolver"]).toBe("scope_earn_in_tick");
    expect(t?.["outputShapes"]).toContain("autonomyScopeProposal");
  });

  it("proposes a tightening with a TTL for an open, unreverted regression on an in-scope file, with no test runs", async () => {
    gaps = [regression("reg-t1", IN_SCOPE, { regressed_by: { sha: "0badc0de", revert_sha: null, by: "gap-sweep:falsified_after_restart" }, landed_sha: undefined }, "open")];
    await tick();
    const ps = proposals();
    expect(ps.length).toBe(1);
    const p = ps[0]!["body"] as Row;
    expect(p["path"]).toBe(IN_SCOPE);
    expect(p["change"]).toBe("tighten");
    expect(p["ttl_hours"]).toBe(48);
    expect(checks).toEqual([]);
  });
});

describe("scope earn-in: control (must stay green)", () => {
  it("an already-in-scope file with covered regressions gets no widening proposal", async () => {
    gaps = [regression("reg-i1", IN_SCOPE)];
    await tick();
    expect(proposals().filter((p) => (p["body"] as Row)["change"] === "widen")).toEqual([]);
    expect(proposals().filter((p) => (p["body"] as Row)["path"] === IN_SCOPE)).toEqual([]);
  });
});

describe("scope earn-in: the accepted evaluator applies proposals (must-fail at base)", () => {
  it("applies a widening only after re-running the evidence itself; writes the record with a one-step undo and reports it", async () => {
    gaps = [regression("reg-a1", FILE_A)];
    const pid = propose(FILE_A, "widen", { evidence: [{ gap_id: "fabricated" }] });
    const r = await apply();
    expect((r["applied"] as Row[]).map((a) => a["path"])).toEqual([FILE_A]);
    expect(excludedNow()).not.toContain(FILE_A);
    const row = scopeRow();
    expect((row["attested"] as Row)["by"]).toBe("evaluator");
    // The evaluator ran the must-fail and the mutation itself; it did not read the proposal's evidence.
    expect(checks.filter((c) => c["mutate_revert"]).length).toBe(1);
    const ch = changes();
    expect(ch.length).toBe(1);
    const c = ch[0]!["body"] as Row;
    expect(c["path"]).toBe(FILE_A);
    expect(c["change"]).toBe("widen");
    expect(c["applied_by"]).toBe("scope_earn_in_apply");
    expect(c["proposal_id"]).toBe(pid);
    expect((c["undo"] as Row)["excluded_paths"]).toEqual(BASE_EXCLUDED);
    expect(c["excluded_paths_after"]).toEqual(BASE_EXCLUDED.filter((p) => p !== FILE_A));
    expect((c["evidence"] as Row[]).map((e) => e["gap_id"])).toEqual(["reg-a1"]);
    expect(c["prior_attested_by"]).toBe("operator");
    expect(c["consecutive_criterion_changes"]).toBe(1);
    expect(reports.length).toBe(1);
    expect(reports[0]!["type"]).toBe("uiPanel_write");
    expect(String(reports[0]!["title"])).toContain(FILE_A);
    expect(proposals()).toEqual([]);
  });

  it("a proposal whose evidence does not reproduce under the evaluator is not applied", async () => {
    gaps = [regression("reg-a1", FILE_A)];
    survives.add("guards reg-a1");
    propose(FILE_A, "widen", { evidence: [{ gap_id: "reg-a1", mutated: { red: true }, unmutated: { green: true } }] });
    const r = await apply();
    expect(r["applied"]).toEqual([]);
    expect(String(((r["refused"] as Row[])[0] ?? {})["reason"])).toContain("survives");
    expect(excludedNow()).toEqual(BASE_EXCLUDED);
    expect(changes()).toEqual([]);
    expect(proposals()).toEqual([]);
    const consumed = poolRows("autonomyScopeProposal", "consumed");
    expect(((consumed[0]!["body"] as Row)["outcome"] as Row)["applied"]).toBe(false);
  });

  it("refuses a widening onto runtime glue executed from the clone, without running anything", async () => {
    gaps = [regression("reg-g1", GLUE)];
    propose(GLUE, "widen");
    const r = await apply();
    expect(r["applied"]).toEqual([]);
    expect(String(((r["refused"] as Row[])[0] ?? {})["reason"])).toContain("runtime glue is executed from the clone (ungated)");
    expect(excludedNow()).toContain(GLUE);
    expect(checks).toEqual([]);
  });

  it("a write of autonomyScope by anyone but the operator or the accepted evaluator is refused", () => {
    expect(POOL_SEAM).toBe(true);
    const body = { excluded_paths: [FILE_A] };
    const noAuth = pool.resolvePoolImpulseWrite({ type: "poolImpulse_write", id: SCOPE_ID, shape: "autonomyScope", body });
    expect(noAuth.body.ok).toBe(false);
    const proposer = pool.resolvePoolImpulseWrite({ type: "poolImpulse_write", id: SCOPE_ID, shape: "autonomyScope", body }, { operator: false, evaluator: "scope_earn_in_tick" } as never);
    expect(proposer.body.ok).toBe(false);
    const inPointer = pool.resolvePoolImpulseWrite({ type: "poolImpulse_write", id: SCOPE_ID, shape: "autonomyScope", body, evaluator: "scope_earn_in_apply" } as never);
    expect(inPointer.body.ok).toBe(false);
    // The evaluator's grant is for autonomyScope alone.
    const spend = pool.resolvePoolImpulseWrite({ type: "poolImpulse_write", id: "spend-envelope", shape: "spendEnvelope", body: { usd_cap_per_hour: 99 } }, { operator: false, evaluator: "scope_earn_in_apply" } as never);
    expect(spend.body.ok).toBe(false);
    expect(excludedNow()).toEqual(BASE_EXCLUDED);
    // The accepted evaluator's write goes through and is attested as the evaluator's.
    const ok = pool.resolvePoolImpulseWrite({ type: "poolImpulse_write", id: SCOPE_ID, shape: "autonomyScope", body: { excluded_paths: BASE_EXCLUDED } }, { operator: false, evaluator: "scope_earn_in_apply" } as never);
    expect(ok.body.ok).toBe(true);
    expect((scopeRow()["attested"] as Row)["by"]).toBe("evaluator");
  });

  it("applies a tightening on the store's own evidence with a TTL hold, and lifts it by expiry", async () => {
    gaps = [regression("reg-t1", IN_SCOPE, { regressed_by: { sha: "0badc0de", revert_sha: null, by: "gap-sweep" }, landed_sha: undefined }, "open")];
    propose(IN_SCOPE, "tighten", { ttl_hours: 48 });
    const r = await apply();
    expect((r["applied"] as Row[]).map((a) => a["change"])).toEqual(["tighten"]);
    expect(excludedNow()).toContain(IN_SCOPE);
    const holds = (scopeRow()["body"] as Row)["tightening_holds"] as Row[];
    expect(holds.map((h) => h["path"])).toEqual([IN_SCOPE]);
    expect(holds[0]!["expires_at"]).toBe(new Date(nowMs + 48 * 3600_000).toISOString());
    expect(checks).toEqual([]);
    nowMs += 49 * 3600_000;
    const r2 = await apply();
    expect((r2["applied"] as Row[]).map((a) => a["change"])).toEqual(["expire"]);
    expect(excludedNow()).not.toContain(IN_SCOPE);
    expect(excludedNow()).toEqual(BASE_EXCLUDED);
  });

  it("a tightening whose regression has since been reverted is not applied", async () => {
    gaps = [regression("reg-t2", IN_SCOPE, { regressed_by: { sha: "0badc0de", revert_sha: GUARD, by: "operator" } }, "open")];
    propose(IN_SCOPE, "tighten", { ttl_hours: 48 });
    const r = await apply();
    expect(r["applied"]).toEqual([]);
    expect(excludedNow()).not.toContain(IN_SCOPE);
  });

  it("exit metric: counts consecutive criterion-made changes, and an operator record edit in between resets it", async () => {
    gaps = [regression("reg-a1", FILE_A), regression("reg-b1", FILE_B), regression("reg-c1", FILE_C)];
    propose(FILE_A, "widen");
    await apply();
    propose(FILE_B, "widen");
    await apply();
    let m = earn!.scopeEarnInExitMetric(changes());
    expect(m).toEqual({ criterion_version: NEW_VERSION, criterion_changes_applied: 2, widenings_this_version: 2, consecutive_without_operator_edit: 2, exit_met: true });
    // An operator edits the record: the next criterion change starts the count again.
    seedScope(excludedNow());
    propose(FILE_C, "widen");
    await apply();
    m = earn!.scopeEarnInExitMetric(changes());
    expect(m).toEqual({ criterion_version: NEW_VERSION, criterion_changes_applied: 3, widenings_this_version: 3, consecutive_without_operator_edit: 1, exit_met: false });
    expect((await tick())["exit_metric"]).toEqual(m);
  });
});

describe("scope earn-in: the evaluator's own files and the runtime tree (must-fail at base)", () => {
  it("never proposes, and the evaluator refuses, a widening onto one of its own files, even when it is absent from excluded_paths", async () => {
    // Excluded and fully covered: still never proposed.
    seedScope([...BASE_EXCLUDED, EVAL_FILE]);
    gaps = [regression("reg-e1", EVAL_FILE)];
    const body = await tick();
    expect(proposals()).toEqual([]);
    expect(String((body["evaluated"] as Row[]).find((e) => e["path"] === EVAL_FILE)!["reason"])).toContain("EVALUATOR_FILES");
    // Absent from excluded_paths: the evaluator refuses it rather than reading it as a no-op, and changes nothing.
    seedScope(BASE_EXCLUDED);
    const before = scopeRow()["updated_at"];
    propose(EVAL_FILE, "widen");
    const r = await apply();
    expect(r["applied"]).toEqual([]);
    expect(String(((r["refused"] as Row[])[0] ?? {})["reason"])).toContain("EVALUATOR_FILES");
    expect(scopeRow()["updated_at"]).toBe(before);
    expect(checks).toEqual([]);
    // The judge of scope changes (self-fact autonomy_scope_pinned) is the evaluator's too: never widened onto.
    const JUDGE = `repos/${V}/src/resolvers/self-fact-reconcile.ts`;
    propose(JUDGE, "widen");
    const rj = await apply();
    expect(rj["applied"]).toEqual([]);
    expect(String(((rj["refused"] as Row[])[0] ?? {})["reason"])).toContain("EVALUATOR_FILES");
    const all = earn!["EVALUATOR_FILES"] as string[];
    for (const f of ["src/resolvers/scope-earn-in.ts", "src/resolvers/pool-impulse.ts", "src/resolvers/test-suite.ts", "src/resolvers/gap-to-feature.ts", "src/resolvers/feature-compose.ts", "test/resolvers/scope-earn-in.test.ts", "test/resolvers/evaluator-grant-scan.test.ts", "src/resolvers/self-fact-reconcile.ts", "test/resolvers/scope-change-pin.test.ts", "src/resolvers/rhythm-conductor-tick.ts"]) {
      expect(all).toContain(`repos/${V}/${f}`);
    }
  });

  it("a must-fail that passes only at the unmirrored clone HEAD (red at the runtime sha) does not qualify a widening", async () => {
    gaps = [regression("reg-a1", FILE_A)];
    redAtRuntimeOnly.add("guards reg-a1");
    const body = await tick();
    expect(proposals()).toEqual([]);
    expect(String((body["evaluated"] as Row[]).find((e) => e["path"] === FILE_A)!["reason"])).toContain("runtime sha");
    propose(FILE_A, "widen");
    const r = await apply();
    expect(r["applied"]).toEqual([]);
    expect(excludedNow()).toContain(FILE_A);
  });

  it("no runtime sha recorded for the vessel: unjudgeable, nothing runs on the clone instead", async () => {
    gaps = [regression("reg-a1", FILE_A)];
    runtimePin = null;
    const body = await tick();
    expect(proposals()).toEqual([]);
    expect((body["evaluated"] as Row[]).find((e) => e["path"] === FILE_A)!["verdict"]).toBe("unjudgeable");
    expect(checks).toEqual([]);
  });
});

describe("scope earn-in: the mutation runner is test_suite's base-tree run (must-fail at base)", () => {
  async function captureCommand(pointer: Row): Promise<{ cmd: string; body: Row }> {
    let cmd = "";
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("vesselCapability")) return Response.json({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } });
      if (String(input).startsWith("http://shell.test")) {
        cmd = String(JSON.parse(body).impulse.pointer.command ?? "");
        return Response.json({ stdout: "VERIFIED_ROOT=/tmp/x\nVERIFIED_HEAD=feedc0d\nMUTATION_APPLIED=1\n(fail) guards a\n 0 pass\n 1 fail\n" });
      }
      violations.push(String(input));
      return Response.json({});
    }) as unknown as typeof fetch;
    try {
      const r = await testSuite.resolveTestSuite({ type: "test_suite", vessel: V, only_tests: ["guards a"], test_file: "test/x.test.ts", ...pointer });
      return { cmd, body: r.body as Row };
    } finally {
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => { violations.push(`${init?.method ?? "GET"} ${String(input)}`); return Response.json({}); }) as unknown as typeof fetch;
    }
  }

  it("reverse-applies the guard commit's change to the file inside the detached worktree, and runs only if it applied", async () => {
    const { cmd, body } = await captureCommand({ base_ref: "HEAD", mutate_revert: { sha: GUARD, file: "src/resolvers/fixture-earn-a.ts" } });
    expect(cmd).toContain("worktree add -q --detach \"$BW\" HEAD");
    expect(cmd).toContain("apply -R");
    expect(cmd).toContain(`${GUARD}^`);
    expect(cmd).toContain("MUTATION_APPLIED=1");
    expect(cmd).not.toContain('cd "$ROOT" &&');
    expect((body["mutation"] as Row)["applied"]).toBe(true);
  });

  it("refuses a mutation without a pinned tree or with an unsafe sha or file", async () => {
    for (const bad of [
      { mutate_revert: { sha: GUARD, file: "src/a.ts" } },
      { base_ref: "HEAD", mutate_revert: { sha: "HEAD; rm -rf /", file: "src/a.ts" } },
      { base_ref: "HEAD", mutate_revert: { sha: GUARD, file: "../etc/passwd" } },
      { base_ref: "HEAD", mutate_revert: { sha: GUARD, file: "src/$(id).ts" } },
    ]) {
      const { cmd, body } = await captureCommand(bad);
      expect(cmd).toBe("");
      expect(body["failure_mode"]).toBe("validation_rejected");
    }
  });

  it("mutate_edit: the operator mutant is applied inside the detached worktree only, from base64 data, and only on a pinned tree", async () => {
    const edit = { file: "src/resolvers/fixture-earn-a.ts", start: 3, end: 7, original: "port", replacement: "PORT; $(id) `x` 'q'", operator: "flip_boolean" };
    const { cmd, body } = await captureCommand({ base_ref: "HEAD", mutate_edit: edit });
    expect(cmd).toContain("worktree add -q --detach \"$BW\" HEAD");
    expect(cmd).toContain("MUTATION_APPLIED=1");
    // The mutant's text never reaches the shell as text.
    expect(cmd).not.toContain("$(id)");
    expect(cmd).not.toContain('cd "$ROOT" &&');
    expect((body["mutation"] as Row)["kind"]).toBe("edit");
    expect((body["mutation"] as Row)["applied"]).toBe(true);
    for (const bad of [
      { mutate_edit: edit },
      { base_ref: "HEAD", mutate_edit: { ...edit, file: "../etc/passwd" } },
      { base_ref: "HEAD", mutate_edit: { ...edit, start: 9, end: 2 } },
      { base_ref: "HEAD", mutate_edit: { ...edit, original: "" } },
      { base_ref: "HEAD", mutate_edit: edit, mutate_revert: { sha: GUARD, file: "src/a.ts" } },
    ]) {
      const r = await captureCommand(bad);
      expect(r.cmd).toBe("");
      expect(r.body["failure_mode"]).toBe("validation_rejected");
    }
  });

  it("the edit script really changes the file in a worktree of a real repository when the original text matches, and refuses when it does not", () => {
    const repo = join(ROOT, "editrepo");
    const wt = join(ROOT, "editwt");
    mkdirSync(join(repo, "src"), { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(repo, "src", "f.ts"), "export const f = () => true;\n");
    git("add", "."); git("commit", "-q", "-m", "base");
    git("worktree", "add", "-q", "--detach", wt, "HEAD");
    const script = (testSuite as Record<string, any>)["mutationEditScript"] as undefined | ((e: Row) => string);
    expect(script).toBeInstanceOf(Function);
    const at = "export const f = () => ".length;
    const out = execFileSync("bash", ["-c", `BW=${JSON.stringify(wt)}; ${script!({ file: "src/f.ts", start: at, end: at + 4, original: "true", replacement: "false" })}`], { encoding: "utf8" });
    expect(out).toContain("MUTATION_APPLIED=1");
    expect(readFileSync(join(wt, "src", "f.ts"), "utf8")).toBe("export const f = () => false;\n");
    expect(readFileSync(join(repo, "src", "f.ts"), "utf8")).toBe("export const f = () => true;\n");
    const out2 = execFileSync("bash", ["-c", `BW=${JSON.stringify(wt)}; ${script!({ file: "src/f.ts", start: at, end: at + 4, original: "true", replacement: "false" })}`], { encoding: "utf8" });
    expect(out2).toContain("MUTATION_FAILED=1");
  });

  it("the revert script really removes the guard in a worktree of a real repository, and says when it cannot", () => {
    const repo = join(ROOT, "mutrepo");
    const wt = join(ROOT, "mutwt");
    mkdirSync(join(repo, "src"), { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(repo, "src", "f.ts"), "export function f(x: number) {\n  return x;\n}\n");
    writeFileSync(join(repo, "src", "g.ts"), "export const g = 1;\n");
    git("add", "."); git("commit", "-q", "-m", "base");
    writeFileSync(join(repo, "src", "f.ts"), "export function f(x: number) {\n  if (x < 0) throw new Error(\"guard\");\n  return x;\n}\n");
    git("commit", "-q", "-am", "guard");
    const guardSha = git("rev-parse", "HEAD");
    git("worktree", "add", "-q", "--detach", wt, "HEAD");
    const revert = (testSuite as Record<string, any>)["mutationRevertScript"] as undefined | ((sha: string, file: string) => string);
    const script = revert ? revert(guardSha, "src/f.ts") : "echo none";
    const out = execFileSync("bash", ["-c", `BW=${JSON.stringify(wt)}; ${script}`], { encoding: "utf8" });
    expect(out).toContain("MUTATION_APPLIED=1");
    expect(readFileSync(join(wt, "src", "f.ts"), "utf8")).not.toContain("guard");
    expect(readFileSync(join(repo, "src", "f.ts"), "utf8")).toContain("guard");
    const out2 = execFileSync("bash", ["-c", `BW=${JSON.stringify(wt)}; ${revert ? revert(guardSha, "src/g.ts") : "echo none"}`], { encoding: "utf8" });
    expect(out2).toContain("MUTATION_FAILED=1");
  });
});

describe("scope earn-in: every tick says why each excluded file cannot qualify (must-fail at base)", () => {
  it("the report carries an outcome and a reason key for EVERY excluded entry, and one journal line counts them", async () => {
    gaps = [regression("reg-a1", FILE_A), regression("reg-b2", FILE_B, { evidence_resolve: undefined, falsifier: { class: "unset" } }), regression("reg-c1", FILE_C)];
    survives.add("guards reg-c1");
    const spy = spyOn(console, "log").mockImplementation(() => {});
    let body: Row;
    let lines: string[] = [];
    try { body = await tick(); } finally { lines = spy.mock.calls.map((c) => String(c[0])); spy.mockRestore(); }
    const ev = body!["evaluated"] as Row[];
    // Every excluded entry is accounted for, each with a non-empty reason and a reason key.
    expect(ev.map((e) => e["path"]).sort()).toEqual([...BASE_EXCLUDED].sort());
    for (const e of ev) {
      expect(String(e["reason"] ?? "").length).toBeGreaterThan(0);
      expect(String(e["reason_key"] ?? "").length).toBeGreaterThan(0);
    }
    const key = (p: string) => ev.find((e) => e["path"] === p)!["reason_key"];
    expect(key(FILE_A)).toBe("qualified");
    expect(key(FILE_B)).toBe("unmapped_regression");
    expect(key(FILE_C)).toBe("survives_mutation");
    expect(key(GLUE)).toBe("runtime_glue");
    expect(key("repos/identity-vessel/")).toBe("directory");
    const counts = body!["by_reason"] as Record<string, number>;
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(BASE_EXCLUDED.length);
    expect(counts["qualified"]).toBe(1);
    // One compact journal line: verdict counts, reason counts, and file:reason pairs.
    const line = lines.filter((l) => l.startsWith("[scope-earn-in] tick:"));
    expect(line.length).toBe(1);
    expect(line[0]).toContain(`${BASE_EXCLUDED.length} excluded entr(ies)`);
    expect(line[0]).toContain("qualified=1");
    expect(line[0]).toContain('"unmapped_regression":1');
    expect(line[0]).toContain("development-vessel/src/resolvers/fixture-earn-b.ts:unmapped_regression");
  });

  it("a missing runtime pin is named as its own reason, not folded into not_covered", async () => {
    gaps = [regression("reg-a1", FILE_A)];
    runtimePin = null;
    const spy = spyOn(console, "log").mockImplementation(() => {});
    let body: Row;
    try { body = await tick(); } finally { spy.mockRestore(); }
    expect((body!["evaluated"] as Row[]).find((e) => e["path"] === FILE_A)!["reason_key"]).toBe("no_runtime_pin");
    // FILE_B and FILE_C have no regression history: qualify rule (a) reads their tests at the runtime sha too, so
    // without a pin they are unjudgeable for the same reason (never a pass).
    expect((body!["by_reason"] as Record<string, number>)["no_runtime_pin"]).toBe(3);
  });
});

describe("scope earn-in: a tightening hold carries its regression's lineage (must-fail at base)", () => {
  it("a hold placed by the evaluator names the evidence gap and that gap's own check", async () => {
    gaps = [regression("reg-t1", IN_SCOPE, { regressed_by: { sha: "0badc0de", revert_sha: null, by: "gap-sweep" }, landed_sha: undefined }, "open")];
    propose(IN_SCOPE, "tighten", { ttl_hours: 48 });
    await apply();
    const hold = ((scopeRow()["body"] as Row)["tightening_holds"] as Row[])[0]!;
    expect(hold["lineage_roots"]).toEqual(["reg-t1"]);
    expect(hold["lineage_checks"]).toEqual(["test/resolvers/fixture-earn.test.ts|guards reg-t1"]);
  });

  it("a hold placed before it carried its lineage is backfilled from its tighten change record, without a new change", async () => {
    gaps = [regression("reg-t1", IN_SCOPE, { regressed_by: { sha: "0badc0de", revert_sha: null, by: "gap-sweep" }, landed_sha: undefined }, "open")];
    // The live shape of the first tick's holds: path, expiry, no lineage; the change record names the evidence gap.
    const w = pool.resolvePoolImpulseWrite({ type: "poolImpulse_write", id: SCOPE_ID, shape: "autonomyScope", body: { excluded_paths: [...BASE_EXCLUDED, IN_SCOPE], require_falsifier_classes: ["class2"], tightening_holds: [{ path: IN_SCOPE, expires_at: new Date(nowMs + 72 * 3600_000).toISOString(), placed_at: new Date(nowMs).toISOString(), by: "scope_earn_in_apply" }] } }, { operator: false, evaluator: "scope_earn_in_apply" } as never);
    expect(w.body.ok).toBe(true);
    pool.resolvePoolImpulseWrite({ type: "poolImpulse_write", id: "scope-change-old", shape: "autonomyScopeChange", body: { path: IN_SCOPE, change: "tighten", applied_by: "scope_earn_in_apply", seq: 1, evidence: [{ gap_id: "reg-t1" }], prior_excluded_paths: BASE_EXCLUDED, excluded_paths_after: [...BASE_EXCLUDED, IN_SCOPE] } });
    const r = await apply();
    expect(r["applied"]).toEqual([]);
    const hold = ((scopeRow()["body"] as Row)["tightening_holds"] as Row[])[0]!;
    expect(hold["lineage_roots"]).toEqual(["reg-t1"]);
    expect(excludedNow()).toContain(IN_SCOPE);
    expect(changes().length).toBe(1);
  });
});

describe("scope earn-in: a tick that ran closes its due slot (must-fail at base)", () => {
  it("a tick with zero proposals still refreshes the family's pacing, so its due score drops below the threshold", async () => {
    gaps = [regression("reg-b2", FILE_B, { evidence_resolve: undefined, falsifier: { class: "unset" } })];
    const spy = spyOn(console, "log").mockImplementation(() => {});
    let body: Row;
    try { body = await tick(); } finally { spy.mockRestore(); }
    expect(body!["proposed"]).toEqual([]);
    expect(settled).toEqual([{ leg: "ran" }]);
    expect(rhythm!.body["staleness"]).toBe(0);
    const due = conductor.rhythmDueScore(rhythm!.body as never, rhythm!.updated_at, nowMs);
    expect(due.due_score).toBeLessThan(1);
  });

  it("two consecutive calls within the cadence: the second returns not_due, evaluates nothing and logs no tick line", async () => {
    gaps = [regression("reg-a1", FILE_A), regression("reg-b2", FILE_B, { evidence_resolve: undefined, falsifier: { class: "unset" } })];
    const spy = spyOn(console, "log").mockImplementation(() => {});
    let first: Row, second: Row;
    let lines: string[] = [];
    try {
      first = await tick();
      const checksAfterFirst = checks.length;
      const linesAfterFirst = spy.mock.calls.length;
      nowMs += 60_000; // a minute later: well inside any cadence
      second = await tick();
      expect(checks.length).toBe(checksAfterFirst);
      expect(spy.mock.calls.length).toBe(linesAfterFirst);
    } finally { lines = spy.mock.calls.map((c) => String(c[0])); spy.mockRestore(); }
    expect(first!["reason"]).not.toBe("not_due");
    expect(second!["reason"]).toBe("not_due");
    expect(second!["evaluated"]).toBeUndefined();
    expect(lines.filter((l) => l.startsWith("[scope-earn-in] tick:")).length).toBe(1);
  });

  it("two concurrent callers that read the same due row: exactly one evaluates", async () => {
    gaps = [regression("reg-b2", FILE_B, { evidence_resolve: undefined, falsifier: { class: "unset" } })];
    const spy = spyOn(console, "log").mockImplementation(() => {});
    let a: Row, b: Row;
    try { [a, b] = await Promise.all([tick(), tick()]); } finally { spy.mockRestore(); }
    const reasons = [a!["reason"], b!["reason"]];
    expect(reasons.filter((r) => r === "not_due").length).toBe(1);
    expect([a!, b!].filter((r) => Array.isArray(r["evaluated"])).length).toBe(1);
  });
});

// QUALIFY RULE (a) — user ruling 2026-10-05T21:55Z, reworked to qa's conditions (10-05 ~22:30Z). A file with no
// regression history qualifies only when its EXISTING tests kill mutants of the file ITSELF: the importing test files at
// the runtime sha (green there unmutated), a small deterministic set of mutants of the target (negate a condition, empty
// a function body, flip a boolean, flip a comparison) applied in the detached worktree at the runtime sha, every
// selected mutant applied, and killed/applied >= the threshold read at use time from the scope-earn-in rhythm body
// (mutation_score_threshold, default 0.8). Zero importing tests or zero mutants is never coverage.
const evOf = (body: Row, path: string): Row => (body["evaluated"] as Row[]).find((e) => e["path"] === path)!;
async function quietTick(pointer: Row = {}): Promise<{ body: Row; lines: string[] }> {
  const spy = spyOn(console, "log").mockImplementation(() => {});
  let body: Row;
  let lines: string[] = [];
  try { body = await tick(pointer); } finally { lines = spy.mock.calls.map((c) => String(c[0])); spy.mockRestore(); }
  return { body: body!, lines };
}
const editRuns = () => checks.filter((c) => c["mutate_edit"]);
const IMPORTS_A = `import { describe, it } from "bun:test";\nimport { a } from "../../src/resolvers/fixture-earn-a.js";\n`;

describe("scope earn-in: qualify rule (a), the file's own tests kill its mutants (must-fail at base)", () => {
  beforeEach(() => { treeFiles.set(COVER_TEST, IMPORTS_A); });
  it("the criterion version is bumped for the loosening", () => {
    expect(earn?.["SCOPE_CRITERION_VERSION"]).toBe(NEW_VERSION);
  });

  it("CONTROL: a no-history file whose importing test kills every mutant is covered and proposed, with the mutants as evidence", async () => {
    const { body } = await quietTick();
    const e = evOf(body, FILE_A);
    expect(e["reason_key"]).toBe("qualified_by_coverage");
    expect(e["verdict"]).toBe("covered");
    const p = proposals().map((x) => x["body"] as Row).find((b) => b["path"] === FILE_A)!;
    expect(p["change"]).toBe("widen");
    expect(p["criterion_version"]).toBe(NEW_VERSION);
    const ev = (p["evidence"] as Row[])[0]!;
    expect(ev["basis"]).toBe("mutation_coverage");
    expect(ev["runtime_sha"]).toBe(RUNTIME);
    expect(ev["importing_tests"]).toEqual([COVER_TEST]);
    const ms = ev["mutants"] as Row[];
    expect(ms.length).toBeGreaterThanOrEqual(4);
    // Every operator has a site in the fixture, so every operator is represented.
    expect([...new Set(ms.map((m) => m["operator"]))].sort()).toEqual(["empty_body", "flip_boolean", "flip_comparison", "negate_condition"]);
    expect(ms.every((m) => m["killed_by"] === COVER_TEST)).toBe(true);
    expect(ev["score"]).toBe(1);
    expect(ev["threshold"]).toBe(0.8);
    // The target and the test were read at the RUNTIME sha; every run is pinned there; each mutant ran as an edit.
    expect(sourceReads.every((r) => r.sha === RUNTIME)).toBe(true);
    for (const c of checks) expect(c["base_ref"]).toBe(RUNTIME);
    expect(editRuns().length).toBe(ms.length);
    for (const c of editRuns()) expect((c["mutate_edit"] as Row)["file"]).toBe("src/resolvers/fixture-earn-a.ts");
  });

  it("VACUITY: an importing test that asserts nothing about the file lets every mutant survive: not covered", async () => {
    kills.set(COVER_TEST, "none");
    const { body } = await quietTick();
    const e = evOf(body, FILE_A);
    expect(e["reason_key"]).toBe("no_coverage");
    expect(String(e["reason"])).toContain("mutation score 0");
    expect(proposals().filter((p) => (p["body"] as Row)["path"] === FILE_A)).toEqual([]);
    expect(editRuns().length).toBeGreaterThan(0);
  });

  it("VACUITY: no test imports the file (zero tests) is not covered, and no mutant runs", async () => {
    treeFiles.set(COVER_TEST, `// mentions fixture-earn-a but imports nothing of it\nimport { b } from "../../src/resolvers/fixture-earn-b.js";\nconst s = "../../src/resolvers/fixture-earn-a.js";\n`);
    const { body } = await quietTick();
    const e = evOf(body, FILE_A);
    expect(e["reason_key"]).toBe("no_coverage");
    expect(String(e["reason"])).toContain("0 importing test");
    expect(editRuns().filter((c) => (c["mutate_edit"] as Row)["file"] === "src/resolvers/fixture-earn-a.ts")).toEqual([]);
  });

  it("VACUITY: a target with no mutable site (zero mutants) is not covered", async () => {
    treeFiles.set("src/resolvers/fixture-earn-a.ts", `export const A = 1;\nexport type T = { x: number };\n`);
    const { body } = await quietTick();
    expect(evOf(body, FILE_A)["reason_key"]).toBe("no_coverage");
    expect(String(evOf(body, FILE_A)["reason"])).toContain("0 mutants");
  });

  it("MUST-FAIL: a shell-gate refusal of the mutant run is reported as gate_refused with the refusal, never mutation_not_applied", async () => {
    editGateRefused = true;
    const { body } = await quietTick();
    expect(evOf(body, FILE_A)["verdict"]).toBe("unjudgeable");
    expect(evOf(body, FILE_A)["reason_key"]).toBe("gate_refused");
    expect(String(evOf(body, FILE_A)["reason"])).toContain("refused by containment");
    expect(proposals()).toEqual([]);
  });

  it("a mutant that does not apply makes the file unjudgeable, never covered", async () => {
    editFails = true;
    const { body } = await quietTick();
    expect(evOf(body, FILE_A)["verdict"]).toBe("unjudgeable");
    expect(evOf(body, FILE_A)["reason_key"]).toBe("mutation_not_applied");
    expect(proposals()).toEqual([]);
  });

  it("an importing test red at the runtime sha unmutated is no killer; with no green importing test the file is not covered", async () => {
    redTests.add(COVER_TEST);
    const { body } = await quietTick();
    expect(evOf(body, FILE_A)["reason_key"]).toBe("no_coverage");
    expect(String(evOf(body, FILE_A)["reason"])).toContain("red at the runtime sha");
    expect(editRuns()).toEqual([]);
  });

  it("the threshold is read from the rhythm body at use time: a borderline file flips with it", async () => {
    // Kills two of the four operators: score 0.5 (or near it) on the fixture.
    kills.set(COVER_TEST, new Set(["negate_condition", "flip_comparison"]));
    rhythm = dueRhythm({ mutation_score_threshold: 0.4 });
    const lo = await quietTick();
    expect(evOf(lo.body, FILE_A)["reason_key"]).toBe("qualified_by_coverage");
    const score = ((proposals().map((p) => p["body"] as Row).find((b) => b["path"] === FILE_A)!["evidence"] as Row[])[0]!["score"]) as number;
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(0.8);
    clearPool(); seedScope(BASE_EXCLUDED); checks = [];
    rhythm = dueRhythm({ mutation_score_threshold: 0.9 });
    const hi = await quietTick();
    expect(evOf(hi.body, FILE_A)["reason_key"]).toBe("no_coverage");
    expect(String(evOf(hi.body, FILE_A)["reason"])).toContain("threshold 0.9");
  });

  it("mutant selection is deterministic and bounded by mutants_per_file from the rhythm body", () => {
    const sel = earn!["selectMutants"] as (src: string, k: number) => Array<Row>;
    expect(sel).toBeInstanceOf(Function);
    const big = Array.from({ length: 40 }, (_, i) => `export function f${i}(x: number) { if (x > ${i}) return true; return false; }`).join("\n");
    const a1 = sel(big, 5);
    const a2 = sel(big, 5);
    expect(a1).toEqual(a2);
    expect(a1.length).toBe(5);
    expect(sel(big, 50).length).toBeLessThanOrEqual(20);
    // Every mutant is a real, syntactically valid change of the source.
    for (const m of a1) {
      const s = Number(m["start"]), e = Number(m["end"]);
      expect(big.slice(s, e)).toBe(String(m["original"]));
      expect(String(m["replacement"])).not.toBe(String(m["original"]));
    }
  });

  it("an unreadable test listing is unjudgeable, not covered and not no_coverage", async () => {
    listFails = true;
    expect(evOf((await quietTick()).body, FILE_A)["verdict"]).toBe("unjudgeable");
    expect(proposals()).toEqual([]);
  });

  it("evaluator files and directories stay refused even when their tests kill every mutant", async () => {
    seedScope([...BASE_EXCLUDED, EVAL_FILE]);
    treeFiles.set("src/resolvers/scope-earn-in.ts", TARGET_SRC);
    treeFiles.set(COVER_TEST, `import "../../src/resolvers/scope-earn-in.js";\n`);
    const { body } = await quietTick();
    expect(evOf(body, EVAL_FILE)["reason_key"]).toBe("evaluator_file");
    expect(evOf(body, "repos/identity-vessel/")["reason_key"]).toBe("directory");
  });

  it("the tick line names the criterion version and splits no-history files into qualified_by_coverage and no_coverage", async () => {
    const { body, lines } = await quietTick();
    const counts = body["by_reason"] as Record<string, number>;
    expect(counts["qualified_by_coverage"]).toBe(1);
    expect(counts["no_coverage"]).toBe(2); // FILE_B, FILE_C: no importing test
    expect(counts["no_regression_history"]).toBeUndefined();
    const line = lines.filter((l) => l.startsWith("[scope-earn-in] tick:"));
    expect(line.length).toBe(1);
    expect(line[0]).toContain(`criterion=${NEW_VERSION}`);
    expect(line[0]).toContain("fixture-earn-a.ts:qualified_by_coverage");
  });
});

// NEVER_PROPOSE (qa 10-05): the trust-boundary modules the operator excluded at 18:53Z that are not the evaluator's own
// files are refused like evaluator files, whatever their coverage.
const NEVER = [
  "src/resolvers/write-containment.ts", "src/resolvers/super-repo-checkout.ts", "src/resolvers/behavioral-verification.ts",
  "src/removed-line-predicate.ts", "src/vacuous-edit.ts", "src/resolvers/staged-mitosis-gate.ts", "src/resolvers/push-policy.ts",
  // qa 10-05 (second ruling): push capability, landing stage, pre-land gate, settlement, ingress, bootstrap config, the
  // judge's own tests; the credit writer lives in activity-api (below).
  "src/resolvers/git-push.ts", "src/resolvers/vessel-mitosis-cutover.ts", "src/resolvers/vessel-mitosis-evaluate.ts",
  "src/resolvers/attempt-register.ts", "src/routes/impulses.ts", "src/config.ts", "test/resolvers/system-authored-gap-checks.test.ts",
].map((rel) => ({ path: `repos/${V}/${rel}`, rel })).concat([{ path: "repos/activity-api/src/lib/posterior-update.ts", rel: "src/lib/posterior-update.ts" }]);
describe("scope earn-in: never-propose trust-boundary modules (must-fail at base)", () => {
  for (const { path, rel } of NEVER) {
    it(`${path}: never proposed by the tick and refused by the evaluator, even when its tests kill every mutant`, async () => {
      seedScope([...BASE_EXCLUDED, path]);
      treeFiles.set(rel, TARGET_SRC);
      treeFiles.set(COVER_TEST, `import "../../${rel.replace(/\.ts$/, ".js")}";\n`);
      const { body } = await quietTick();
      expect(evOf(body, path)["reason_key"]).toBe("never_propose");
      expect(proposals().filter((p) => (p["body"] as Row)["path"] === path)).toEqual([]);
      propose(path, "widen");
      const r = await apply();
      expect(r["applied"]).toEqual([]);
      expect(String(((r["refused"] as Row[]).find((x) => x["path"] === path) ?? {})["reason"])).toContain("NEVER_PROPOSE");
      expect(excludedNow()).toContain(path);
      // Absent from excluded_paths: refused by name, not read as a no-op.
      seedScope(BASE_EXCLUDED);
      propose(path, "widen");
      const r2 = await apply();
      expect(String(((r2["refused"] as Row[]).find((x) => x["path"] === path) ?? {})["reason"])).toContain("NEVER_PROPOSE");
    });
  }
  it("the evaluator-owned trust modules stay covered by EVALUATOR_FILES", () => {
    for (const f of ["src/lib/caller-credential.ts", "src/lib/self-auth.ts", "src/resolvers/retry-evidence.ts"]) expect(earn!.isEvaluatorFile(`repos/${V}/${f}`)).toBe(true);
  });
});

describe("scope earn-in: the evaluator applies a coverage widening, recorded as a loosening (must-fail at base)", () => {
  beforeEach(() => { treeFiles.set(COVER_TEST, IMPORTS_A); });
  it("re-runs the mutants itself, stamps the version, and the FIRST widening under the version carries the loosening note", async () => {
    treeFiles.set(COVER_TEST, `import { a } from "../../src/resolvers/fixture-earn-a.js";\nimport { b } from "../../src/resolvers/fixture-earn-b.js";\n`);
    propose(FILE_A, "widen", { evidence: [{ gap_id: "fabricated" }] });
    const r = await apply();
    expect((r["applied"] as Row[]).map((a) => a["path"])).toEqual([FILE_A]);
    expect(excludedNow()).not.toContain(FILE_A);
    expect(editRuns().length).toBeGreaterThan(0);
    const first = changes()[0]!["body"] as Row;
    expect(first["criterion_version"]).toBe(NEW_VERSION);
    expect((first["evidence"] as Row[])[0]!["basis"]).toBe("mutation_coverage");
    expect(String(first["criterion_note"])).toContain("LOOSENING");
    expect(String(first["criterion_note"])).toContain("2026-10-05T21:55Z");
    expect(String(first["criterion_note"])).toContain("L12");
    propose(FILE_B, "widen");
    await apply();
    const second = changes().map((c) => c["body"] as Row).find((b) => b["path"] === FILE_B)!;
    expect(second["criterion_version"]).toBe(NEW_VERSION);
    expect(second["criterion_note"]).toBeUndefined();
  });

  it("the evaluator reads the threshold itself: a proposal made under a lower threshold is refused after the rhythm raises it", async () => {
    kills.set(COVER_TEST, new Set(["negate_condition", "flip_comparison"]));
    propose(FILE_A, "widen");
    rhythm = dueRhythm({ mutation_score_threshold: 0.95 });
    const r = await apply();
    expect(r["applied"]).toEqual([]);
    expect(String(((r["refused"] as Row[])[0] ?? {})["reason"])).toContain("threshold 0.95");
    expect(excludedNow()).toContain(FILE_A);
  });
});

describe("scope earn-in: the exit counts widenings under ONE criterion version (must-fail at base)", () => {
  const rec = (seq: number, change: string, version: string, prior = "evaluator"): Row => ({
    id: `c${seq}`, body: { seq, change, criterion_version: version, applied_by: "scope_earn_in_apply", prior_attested_by: prior, path: `p${seq}` },
  });
  it("tightenings and expiries do not count toward the exit, and do not break the chain", () => {
    const m = earn!.scopeEarnInExitMetric([rec(1, "tighten", NEW_VERSION, "operator"), rec(2, "widen", NEW_VERSION), rec(3, "tighten", NEW_VERSION), rec(4, "expire", NEW_VERSION)]);
    expect(m["consecutive_without_operator_edit"]).toBe(1);
    expect(m["exit_met"]).toBe(false);
    const m2 = earn!.scopeEarnInExitMetric([rec(1, "tighten", NEW_VERSION, "operator"), rec(2, "widen", NEW_VERSION), rec(3, "tighten", NEW_VERSION), rec(4, "widen", NEW_VERSION)]);
    expect(m2["consecutive_without_operator_edit"]).toBe(2);
    expect(m2["exit_met"]).toBe(true);
  });
  it("widenings under an older criterion version do not count", () => {
    const m = earn!.scopeEarnInExitMetric([rec(1, "widen", "wiring-2026-10-03", "operator"), rec(2, "widen", "wiring-2026-10-03"), rec(3, "widen", NEW_VERSION)]);
    expect(m["widenings_this_version"]).toBe(1);
    expect(m["consecutive_without_operator_edit"]).toBe(1);
    expect(m["exit_met"]).toBe(false);
  });
  it("an operator edit after the last change (the live record attested by the operator) zeroes the count", () => {
    // Without the trailing operator edit the same records meet the exit; with it they do not.
    expect(earn!.scopeEarnInExitMetric([rec(1, "widen", NEW_VERSION, "operator"), rec(2, "widen", NEW_VERSION)])["exit_met"]).toBe(true);
    const m = earn!.scopeEarnInExitMetric([rec(1, "widen", NEW_VERSION, "operator"), rec(2, "widen", NEW_VERSION)], "operator");
    expect(m["consecutive_without_operator_edit"]).toBe(0);
    expect(m["exit_met"]).toBe(false);
  });
});

// EVERY EXCLUDED ENTRY IS CLASSIFIED (qa 10-05, second ruling): JUDGE/TRUST (never proposable; it evolves only by a future
// gate-evolution shadow promotion) or OPERATIONAL (earn-in eligible), as data in code with a reason each. An entry the
// table does not classify is refused (fail closed). The live record's 46 entries on node1, 10-05 22:45Z:
const LIVE_EXCLUDED_10_05 = [
  "repos/cycle-demo-3/", "repos/discovery-vessel/", "repos/human-surface-vessel/", "repos/identity-vessel/", "scripts/substrate/",
  "scripts/bootstrap-seeder.ts",
  "repos/activity-api/src/lib/posterior-update.ts", "repos/boredom-vessel/src/index.ts", "repos/llm-resolver-vessel/src/index.ts",
  "repos/goal-host-vessel/src/index.ts", "repos/goal-host-vessel/src/goal-target-inference.ts", "repos/concept-db/tests/write-shapes.test.ts",
  ...[
    "src/config.ts", "src/index.ts", "src/routes/impulses.ts", "src/removed-line-predicate.ts", "src/vacuous-edit.ts",
    "src/lib/caller-credential.ts", "src/lib/self-auth.ts",
    "src/resolvers/attempt-register.ts", "src/resolvers/git-push.ts", "src/resolvers/maintenance-lease.ts", "src/resolvers/push-policy.ts",
    "src/resolvers/vessel-mitosis-cutover.ts", "src/resolvers/vessel-mitosis-evaluate.ts", "src/resolvers/write-containment.ts",
    "src/resolvers/super-repo-checkout.ts", "src/resolvers/behavioral-verification.ts", "src/resolvers/staged-mitosis-gate.ts",
    "src/resolvers/apply-proposal-as-patch.ts", "src/resolvers/gap-lifecycle-scan.ts", "src/resolvers/pull-cutover.ts",
    "src/resolvers/substrate-gap.ts", "src/resolvers/composer-interruption-sweep.ts",
    "src/resolvers/feature-compose.ts", "src/resolvers/gap-to-feature.ts", "src/resolvers/pool-impulse.ts", "src/resolvers/rhythm-conductor-tick.ts",
    "src/resolvers/self-fact-reconcile.ts", "src/resolvers/scope-earn-in.ts", "src/resolvers/test-suite.ts", "src/resolvers/retry-evidence.ts",
    "test/resolvers/scope-earn-in.test.ts", "test/resolvers/evaluator-grant-scan.test.ts", "test/resolvers/scope-change-pin.test.ts",
    "test/resolvers/system-authored-gap-checks.test.ts",
  ].map((r) => `repos/${V}/${r}`),
];
const OPERATIONAL_10_05 = [
  "repos/cycle-demo-3/", "repos/boredom-vessel/src/index.ts", "repos/llm-resolver-vessel/src/index.ts",
  "repos/goal-host-vessel/src/goal-target-inference.ts", "repos/concept-db/tests/write-shapes.test.ts",
  `repos/${V}/src/resolvers/maintenance-lease.ts`, `repos/${V}/src/resolvers/composer-interruption-sweep.ts`,
];
describe("scope earn-in: every excluded entry is classified judge/trust or operational (must-fail at base)", () => {
  it("the shipped table classifies all 46 live entries, each with a reason; exactly the operational set is earn-in eligible", () => {
    expect(LIVE_EXCLUDED_10_05.length).toBe(46);
    const table = earn?.["SCOPE_CLASSIFICATION"] as Record<string, { class: string; reason: string }> | undefined;
    expect(table).toBeDefined();
    const missing = LIVE_EXCLUDED_10_05.filter((p) => !table![p]);
    expect(missing).toEqual([]);
    for (const p of LIVE_EXCLUDED_10_05) {
      expect(["judge_trust", "operational"]).toContain(table![p]!.class);
      expect(table![p]!.reason.length).toBeGreaterThan(8);
    }
    expect(LIVE_EXCLUDED_10_05.filter((p) => table![p]!.class === "operational").sort()).toEqual([...OPERATIONAL_10_05].sort());
    // Every evaluator file is JUDGE/TRUST in the table too.
    for (const f of earn!["EVALUATOR_FILES"] as string[]) expect(table![f]?.class).toBe("judge_trust");
  });

  it("FAIL CLOSED: an excluded entry the table does not classify is refused by the tick and the evaluator, whatever its coverage", async () => {
    const ORPHAN = `repos/${V}/src/resolvers/fixture-unclassified.ts`;
    seedScope([...BASE_EXCLUDED, ORPHAN]);
    treeFiles.set("src/resolvers/fixture-unclassified.ts", TARGET_SRC);
    treeFiles.set(COVER_TEST, `import "../../src/resolvers/fixture-unclassified.js";\n`);
    const { body } = await quietTick();
    expect(evOf(body, ORPHAN)["reason_key"]).toBe("unclassified");
    expect(proposals().filter((p) => (p["body"] as Row)["path"] === ORPHAN)).toEqual([]);
    propose(ORPHAN, "widen");
    const r = await apply();
    expect(r["applied"]).toEqual([]);
    expect(String(((r["refused"] as Row[]).find((x) => x["path"] === ORPHAN) ?? {})["reason"])).toContain("unclassified");
    expect(excludedNow()).toContain(ORPHAN);
    // Absent from excluded_paths: refused by name, not read as a no-op.
    seedScope(BASE_EXCLUDED);
    propose(ORPHAN, "widen");
    const r2 = await apply();
    expect(String(((r2["refused"] as Row[]).find((x) => x["path"] === ORPHAN) ?? {})["reason"])).toContain("unclassified");
  });

  it("the tick report carries the classification of every excluded entry", async () => {
    const { body } = await quietTick();
    const cls = body["classification"] as Row[];
    expect(cls.map((c) => c["path"]).sort()).toEqual([...BASE_EXCLUDED].sort());
    for (const c of cls) { expect(c["class"]).toBe("operational"); expect(String(c["reason"]).length).toBeGreaterThan(0); }
  });
});

describe("scope earn-in: which tests ran, and a shaped run budget per tick (must-fail at base)", () => {
  const T = (n: number) => `test/resolvers/fixture-cover-${n}.test.ts`;
  beforeEach(() => {
    for (const n of [4, 2, 3, 1]) { treeFiles.set(T(n), `import { a } from "../../src/resolvers/fixture-earn-a.js";\n`); kills.set(T(n), "all"); }
  });

  it("the default cap of 3 importing tests keeps path order (whatever order the listing returns), and the tick logs the tests used per file", async () => {
    const { body, lines } = await quietTick();
    const e = evOf(body, FILE_A);
    expect(e["tests_used"]).toEqual([T(1), T(2), T(3)]);
    expect(e["importing_tests"]).toBe(4);
    const line = lines.find((l) => l.startsWith("[scope-earn-in] coverage ") && l.includes("fixture-earn-a.ts"));
    expect(line).toBeDefined();
    expect(line!).toContain(`${T(1)}, ${T(2)}, ${T(3)}`);
    expect(line!).toContain("of 4 importing");
  });

  it("the run budget is read from the rhythm body; exhausting it is unjudgeable_budget, never a pass, and stops further runs", async () => {
    rhythm = dueRhythm({ max_test_runs_per_tick: 4 });
    const { body } = await quietTick();
    const e = evOf(body, FILE_A);
    expect(e["verdict"]).toBe("unjudgeable");
    expect(e["reason_key"]).toBe("unjudgeable_budget");
    expect(proposals()).toEqual([]);
    expect(checks.length).toBe(4);
    expect(body["test_runs_used"]).toBe(4);
    expect(body["test_runs_budget"]).toBe(4);
    // Running out of budget is not evidence against the family: no beta.
    expect(settled.map((x) => x.leg)).not.toContain("beta");
  });

  it("a budget that covers the work leaves the verdict unchanged and reports the runs used", async () => {
    rhythm = dueRhythm({ max_test_runs_per_tick: 200 });
    const { body } = await quietTick();
    expect(evOf(body, FILE_A)["reason_key"]).toBe("qualified_by_coverage");
    expect(body["test_runs_used"]).toBe(checks.length);
    expect(Number(body["test_runs_used"])).toBeGreaterThan(0);
  });

  it("the evaluator applies the same budget to its own re-run", async () => {
    propose(FILE_A, "widen");
    rhythm = dueRhythm({ max_test_runs_per_tick: 2 });
    const r = await apply();
    expect(r["applied"]).toEqual([]);
    expect(String(((r["refused"] as Row[])[0] ?? {})["reason"])).toContain("budget");
    expect(checks.length).toBe(2);
  });
});
