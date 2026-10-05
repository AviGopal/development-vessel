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

const originalFetch = globalThis.fetch;
let violations: string[] = [];
let execGuard: ExecGuard | null = null;
let gaps: Row[] = [];
let rhythm: { id: string; body: Row; updated_at?: string } | null = null;
let settled: Array<{ leg: string }> = [];
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
    settle: async (_r: unknown, leg: string) => { settled.push({ leg }); },
    runCheck: async (input: Row) => fakeCheck(input),
    poolRead: (shape: string) => poolRows(shape),
    poolWrite: (pointer: Row, ...rest: unknown[]) => {
      writes.push({ pointer, auth: rest[0], nargs: 1 + rest.length });
      return pool.resolvePoolImpulseWrite(pointer as never, rest[0] as never);
    },
    report: async (panel: Row) => { reports.push(panel); },
    unitsText: () => unitsText,
    runtimeSha: () => runtimePin,
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
    expect(p["criterion_version"]).toBe("wiring-2026-10-03");
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
    expect(settled).toEqual([{ leg: "alpha" }]);
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
    expect(m).toEqual({ criterion_changes_applied: 2, consecutive_without_operator_edit: 2, exit_met: true });
    // An operator edits the record: the next criterion change starts the count again.
    seedScope(excludedNow());
    propose(FILE_C, "widen");
    await apply();
    m = earn!.scopeEarnInExitMetric(changes());
    expect(m).toEqual({ criterion_changes_applied: 3, consecutive_without_operator_edit: 1, exit_met: false });
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
    for (const f of ["src/resolvers/scope-earn-in.ts", "src/resolvers/pool-impulse.ts", "src/resolvers/test-suite.ts", "src/resolvers/gap-to-feature.ts", "src/resolvers/feature-compose.ts", "test/resolvers/scope-earn-in.test.ts", "test/resolvers/evaluator-grant-scan.test.ts", "src/resolvers/self-fact-reconcile.ts", "test/resolvers/scope-change-pin.test.ts"]) {
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
    expect((body!["by_reason"] as Record<string, number>)["no_runtime_pin"]).toBe(1);
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
