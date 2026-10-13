// SUPPLY AUTHORED BY THE SYSTEM (REALIGNMENT §2.3 supply contract; §2.0 consolidate, do not mint).
//
// The lane composes only ARMED gaps (composeEligibilitySkipReason: open, class1/class2, an edit site, not held).
// Every other open gap is excluded as needs_information because nobody wrote it a check, and the operator was
// arming gaps by hand-writing failing tests. These tests pin the organs that let the substrate write those
// checks itself, through the paths that already exist:
//   (a) a gap with no check (or no verified edit site) is classified needs-localization and is not compose work;
//   (b) a rhythm-paced tick dispatches ONE test-writing edit goal per such gap, naming its one out-of-suite check file
//       test/checks/<slug>.check.ts (B′: never an existing or discovered *.test.ts) and forbidding src edits,
//       bounded per tick and backed off per gap;
//   (c) when the test lands, it must import the edit site and the one judge must read it RED at HEAD FOR THE
//       RIGHT REASON (every named test among the run's failures, each an ASSERTION by the shared classifier the
//       report's red_reason carries, not a load error) before the gap is armed
//       through the ordinary substrateGap_write birth seam; anything else arms nothing (fail closed);
//   (d) the cadence is read from a timeShapedRhythm impulse at use time, never from a timer or env constant, and
//       the conductor reads the WHOLE registry (a family past the 50th row is still fired);
//   (e) the family is graded by the tick's report: the conductor leaves it pending, the tick settles it;
//   (f) a control arm by hash(gap id) parity is classified but never sent a goal.
// Controls: an already-armed gap and an operator-held gap get no goal. The shell-gate GIT_DIR form from
// local-tools-vessel is the concrete needs-localization fixture: its vessel already has a test importing
// src/shell-containment.ts, and under B′ the goal still names the gap's own check file (no append). Only the goal
// text and target are asserted.
//
// Hermetic: temp gap store, temp clone and runtime roots, fetch stubbed (any unexpected URL is a violation),
// the birth judge replaced, host-lifecycle exec blocked. Nothing runs a test suite or reaches the fleet.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests, __setDiscoveryForTests } from "../../src/config.js";

const ROOT = join(tmpdir(), `sys-gap-checks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const elig = await import("../../src/judge/gap-eligibility.js");
// The organ under test. Absent at the base, so every test below fails on its own assertion, not on a load error.
const supply = (await import("../../src/resolvers/gap-check-supply.js").catch(() => null)) as null | {
  checkSupplyDisposition: (row: Record<string, unknown>) => string | null;
  checkSupplyArm: (id: string) => "treatment" | "control";
  checkSupplySettlementLeg: (c: { dispatched: number; armed: number; refused: number }) => "alpha" | "beta" | null;
  resolveGapCheckSupplyTick: (pointer: Record<string, unknown>) => Promise<{ shape: string; body: Record<string, unknown> }>;
};
const conductor = await import("../../src/resolvers/rhythm-conductor-tick.js") as Record<string, unknown> & typeof import("../../src/resolvers/rhythm-conductor-tick.js");
const RESOLVER_FILE = join(import.meta.dir, "../../src/resolvers/gap-check-supply.ts");
const CONDUCTOR_FILE = join(import.meta.dir, "../../src/resolvers/rhythm-conductor-tick.ts");
const SEED_FILE = join(import.meta.dir, "../../src/seed/gap-check-supply-tick.ts");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "local-tools-vessel";
const SITE = `repos/${VESSEL}/src/shell-containment.ts`;
const GIT_DIR_SUMMARY = "shell gate allows the GIT_DIR form: `GIT_DIR=.git git config core.hooksPath /tmp/h` is let through by local-tools-vessel src/shell-containment.ts containShell, so a hooksPath rewrite escapes containment";
const GOAL_RE = /^Write ONE failing test in repos\/local-tools-vessel\/test\/checks\/[a-z0-9-]+\.check\.ts that reproduces: [\s\S]+\. [\s\S]*Do not change src\/[\s\S]*$/;
const CHECK_RE = /^test\/checks\/[a-z0-9-]+\.check\.ts$/;
const EXISTING_TEST = "src/shell-containment.test.ts";
/** What test_suite's red_reason says for a run whose named tests all failed on an assertion. */
const assertionRedReason = (t: string[]): Row => ({ ran: true, pass: 0, unhandled: false, unhandled_cause: null, unhandled_error: null, failures: t.map((name) => ({ name, cls: "assertion", error: "error: expect(received).toBe(expected)" })) });

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let goals: Array<{ goal: string; variables?: Record<string, unknown> }> = [];
let violations: string[] = [];
let rhythms: Array<Record<string, unknown>> = [];
let verdictFor: (id: string) => string = () => "present";
// The run report the judge observes. Default: every named test failed on an assertion.
let reportFor: (id: string, onlyTests: string[]) => Row | null = (_id, t) => ({ ran: true, total: t.length, fail: t.length, failingTests: t.map((x) => `(fail) ${x}`), red_reason: assertionRedReason(t) });
let judged: string[] = [];
let rhythmWrites: Row[] = [];
let directCalls: Row[] = [];
let registryOverride: Row[] | null = null;
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;

const dueRhythm = (extra: Row = {}): Row => ({
  id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(),
  body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 10, backoff_hours: 24, max_attempts: 2, ...extra },
});

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  mkdirSync(join(CLONES, VESSEL, "src"), { recursive: true });
  mkdirSync(join(CLONES, VESSEL, "test", "checks"), { recursive: true });
  mkdirSync(join(RUNTIME, VESSEL, "src"), { recursive: true });
  writeFileSync(join(CLONES, VESSEL, "src", "shell-containment.ts"), "export function containShell(cmd: string): boolean { return true; }\n");
  writeFileSync(join(RUNTIME, VESSEL, "src", "shell-containment.ts"), "export function containShell(cmd: string): boolean { return true; }\n");
  for (const f of ["site-x.ts", "site-y.ts"]) writeFileSync(join(CLONES, VESSEL, "src", f), `export const ${f.replace(/\W/g, "_")} = 1;\n`);
  writeFileSync(join(CLONES, VESSEL, EXISTING_TEST), `import { expect, test } from "bun:test";\nimport { containShell } from "./shell-containment.js";\ntest("allows ls", () => { expect(containShell("ls")).toBe(true); });\n`);
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    // goal-host's dispatch record, read back for a dispatched goal's outcome: unknown here (404), so nothing is graded.
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    if (url.endsWith("/run-goal")) {
      goals.push({ goal: String(body.goal ?? ""), variables: body.variables });
      return Response.json({ dispatchId: `d-${goals.length}` }, { status: 202 });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") {
      // The pool resolver's contract: newest first, an optional limit, count = rows returned.
      const all = registryOverride ?? rhythms;
      const rows = typeof imp.limit === "number" ? all.slice(0, imp.limit) : all;
      return Response.json({ body: { impulses: rows, count: rows.length } });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write" && imp?.shape === "timeShapedRhythm") { rhythmWrites.push(imp); return Response.json({ body: { ok: true } }); }
    if (imp?.pointer?.type === "gap_check_supply_tick") { directCalls.push(imp.pointer); return Response.json({ shape: "gapCheckSupplyReport", body: { fired: true } }); }
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    violations.push(`${init?.method ?? "GET"} ${url} ${JSON.stringify(body).slice(0, 160)}`);
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async (g: Row, o?: { onReport?: (r: Row) => void }) => {
    const id = String(g["id"] ?? "");
    judged.push(id);
    const er = ((g["classification_metadata"] ?? {}) as Row)["evidence_resolve"] as Row | undefined;
    const only = (((er?.["input"] ?? {}) as Row)["only_tests"] ?? []) as string[];
    const rep = reportFor(id, only);
    if (rep) o?.onReport?.(rep);
    return verdictFor(id);
  });
  console.log = () => {};
  console.warn = () => {};
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch;
  console.log = origLog;
  console.warn = origWarn;
  sg.__setBirthJudgeForTests(null);
  restoreCutoverExecModules();
  __resetDiscoveryForTests();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => {
  goals = []; violations = []; judged = []; verdictFor = () => "present"; rhythms = [dueRhythm()];
  rhythmWrites = []; directCalls = []; registryOverride = null;
  reportFor = (_id, t) => ({ ran: true, total: t.length, fail: t.length, failingTests: t.map((x) => `(fail) ${x}`), red_reason: assertionRedReason(t) });
  execGuard = installCutoverExecGuard();
  g2fPolicy.__resetPolicyReadsForTests();
});
afterEach(() => {
  const blocked = execGuard?.restore() ?? [];
  expect(blocked).toEqual([]);
  expect(violations).toEqual([]);
});

async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);
async function seed(id: string, summary: string, meta: Row, status = "open"): Promise<void> {
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status, detected_at: new Date().toISOString(), summary, classification_metadata: meta } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function tick(pointer: Row = {}): Promise<Row> {
  const r = await supply!.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", ...pointer });
  await sg.__settleBirthEvaluationsForTests();
  return r.body;
}
/** A gap id in the wanted experiment arm (the supply's own hash parity), so fixtures are deterministic. */
function idIn(prefix: string, arm: "treatment" | "control"): string {
  if (!supply) return prefix;
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${i}`; if (supply.checkSupplyArm(id) === arm) return id; }
  throw new Error("no id in arm " + arm);
}
const T = (prefix: string): string => idIn(`${prefix}-${RUN}`, "treatment");
const ledgerOf = (m: Row): Row => ((m["check_supply"] ?? {}) as Row);
const GIT_DIR_ID = T("sgc-gitdir");
const ARMED_CHECK = { evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: "test/existing.test.ts", only_tests: ["already red"] }, zero_field: "requested_not_passing" } };

describe("system-authored gap checks: (a) classification", () => {
  it("a gap with no check is classified needs-localization and is not compose-eligible", () => {
    expect(supply).not.toBeNull();
    const noCheck: Row = { id: "x", status: "open", summary: GIT_DIR_SUMMARY, classification_metadata: {} };
    const sitedNoCheck: Row = { id: "y", status: "open", summary: "s", classification_metadata: { edit_site: SITE, falsifier: "none" } };
    expect(supply!.checkSupplyDisposition(noCheck)).toBe("needs_localization");
    expect(supply!.checkSupplyDisposition(sitedNoCheck)).toBe("needs_localization");
    expect(elig.composeEligibilitySkipReason(noCheck)).not.toBeNull();
    expect(elig.composeEligibilitySkipReason(sitedNoCheck)).not.toBeNull();
    // the written disposition is one the shared eligibility predicate reads as held
    expect(elig.composeEligibilitySkipReason({ id: "z", status: "open", classification_metadata: { falsifier: "class2", edit_site: SITE, disposition: "needs_localization" } })).toBe("held");
  });

  it("CONTROL: armed, held, parked and closed gaps are not needs-localization", () => {
    expect(supply).not.toBeNull();
    expect(supply!.checkSupplyDisposition({ id: "a", status: "open", classification_metadata: { falsifier: "class2", edit_site: SITE } })).toBeNull();
    expect(supply!.checkSupplyDisposition({ id: "h", status: "open", classification_metadata: { operator_hold: true } })).toBeNull();
    expect(supply!.checkSupplyDisposition({ id: "p", status: "open", classification_metadata: { disposition: "awaiting_operator_review" } })).toBeNull();
    expect(supply!.checkSupplyDisposition({ id: "c", status: "closed", classification_metadata: {} })).toBeNull();
  });
});

describe("system-authored gap checks: (b) the rhythm tick dispatches one test-writing goal per gap", () => {
  it("one goal per needs-localization gap: GIT_DIR gets its own check file even though a test already imports its edit site; armed and held gaps get none", async () => {
    expect(supply).not.toBeNull();
    const gitDir = GIT_DIR_ID, armed = T("sgc-armed"), held = T("sgc-held"), fresh = T("sgc-fresh");
    await seed(gitDir, GIT_DIR_SUMMARY, {});
    await seed(fresh, `fresh fixture ${RUN}: local-tools-vessel containShell lets an env-prefixed git through`, {});
    await seed(armed, `armed fixture ${RUN}: containShell lets a hooksPath rewrite through`, { edit_site: SITE, ...ARMED_CHECK });
    await seed(held, `held fixture ${RUN}: local-tools-vessel containShell misses a form`, { operator_hold: true });
    const body = await tick();
    const goalFor = (id: string) => goals.filter((g) => g.variables?.["gap_id"] === id);
    expect(goalFor(armed).length).toBe(0);
    expect(goalFor(held).length).toBe(0);
    // an existing test already imports the edit site: NO append (B′), the gap's own check file, src forbidden
    expect(goalFor(gitDir).length).toBe(1);
    expect(goalFor(gitDir)[0]!.goal).toMatch(GOAL_RE);
    expect(goalFor(gitDir)[0]!.goal).not.toContain(EXISTING_TEST);
    expect(goalFor(gitDir)[0]!.goal).toContain("GIT_DIR=.git git config core.hooksPath /tmp/h");
    // no test covers an unnamed site: a new test file, src forbidden
    expect(goalFor(fresh).length).toBe(1);
    expect(goalFor(fresh)[0]!.goal).toMatch(GOAL_RE);
    const m = metaOf(await storeRow(gitDir));
    expect(m["disposition"]).toBe("needs_localization");
    expect(m["gap_check_supply_arm"]).toBe("treatment");
    const ledger = ledgerOf(m);
    expect(ledger["state"]).toBe("goal_dispatched");
    expect(ledger["test_file"]).toMatch(CHECK_RE);
    expect(ledger["edit_site"]).toBe(SITE);
    expect(ledger["baseline_titles"]).toEqual([]);
    expect(ledger["vessel"]).toBe(VESSEL);
    expect(ledger["attempts"]).toBe(1);
    expect(metaOf(await storeRow(armed))["check_supply"]).toBeUndefined();
    expect(metaOf(await storeRow(held))["check_supply"]).toBeUndefined();
    expect(Number((body["dispatched"] as unknown[] | undefined)?.length ?? -1)).toBeGreaterThanOrEqual(2);
  });

  it("honours backoff: no second goal inside the backoff window, one after it, none past max_attempts", async () => {
    expect(supply).not.toBeNull();
    const id = T("sgc-backoff");
    await seed(id, `backoff fixture ${RUN}: local-tools-vessel containShell lets env-prefixed git through`, {});
    const t0 = Date.now();
    await tick({ now_ms: t0 });
    await tick({ now_ms: t0 + 60_000 });
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(1);
    await tick({ now_ms: t0 + 25 * 3600_000 });
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(2);
    await tick({ now_ms: t0 + 400 * 3600_000 });
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(2);
    expect(ledgerOf(metaOf(await storeRow(id)))["state"]).toBe("exhausted");
  });

  it("is bounded per tick by the rhythm's max_per_tick", async () => {
    expect(supply).not.toBeNull();
    for (let i = 0; i < 3; i++) await seed(T(`sgc-budget-${i}`), `budget fixture ${i} ${RUN}: local-tools-vessel containShell form ${i}`, {});
    rhythms = [dueRhythm({ max_per_tick: 1 })];
    await tick({ now_ms: Date.now() + 1000 * 3600_000 });
    expect(goals.length).toBe(1);
  });
});

/** Dispatch a new-file goal for a fresh gap, then land `content` at the file it named. */
async function landTest(prefix: string, content: (title: string) => string, at: number): Promise<{ id: string; title: string; testFile: string }> {
  const id = T(prefix);
  await seed(id, `${prefix} fixture ${RUN}: local-tools-vessel containShell lets a GIT_DIR form through`, {});
  rhythms = [dueRhythm({ max_per_tick: 50 })];
  await tick({ now_ms: at });
  const testFile = String(ledgerOf(metaOf(await storeRow(id)))["test_file"] ?? "");
  expect(testFile).toMatch(CHECK_RE);
  const title = `${prefix} reproduces ${RUN}`;
  writeFileSync(join(CLONES, VESSEL, testFile), content(title));
  return { id, title, testFile };
}
const IMPORTING_RED = (title: string): string => `import { expect, test } from "bun:test";\nimport { containShell } from "../../src/shell-containment.js";\ntest("${title}", () => { expect(containShell("GIT_DIR=.git git config core.hooksPath /tmp/h")).toBe(false); });\n`;

describe("system-authored gap checks: (c) a landed test arms the gap only when red at HEAD for the right reason", () => {
  it("CONTROL: an importing test whose named test fails on an assertion arms the gap through substrateGap_write", async () => {
    expect(supply).not.toBeNull();
    const { id, title, testFile } = await landTest("sgc-arm-red", IMPORTING_RED, Date.now() + 1000 * 3600_000);
    const body = await tick({ now_ms: Date.now() + 1100 * 3600_000 });
    // judged exactly once: the arm write carries the verdict as the trusted birth stamp, so the seam does not re-run it
    expect(judged.filter((x) => x === id).length).toBe(1);
    const m = metaOf(await storeRow(id));
    expect(m["falsifier"]).toBe("class2");
    const er = (m["evidence_resolve"] ?? {}) as Row;
    expect(er["shape"]).toBe("test_suite");
    expect(er["zero_field"]).toBe("requested_not_passing");
    expect((er["input"] as Row)["test_file"]).toBe(testFile);
    expect((er["input"] as Row)["only_tests"]).toEqual([title]);
    expect(m["edit_site"]).toBe(SITE);
    expect(m["predicate_birth_verdict"]).toBe("present");
    expect(m["predicate_source"]).toBe("gap_check_supply");
    expect(m["disposition"]).toBe("");
    expect(ledgerOf(m)["state"]).toBe("armed");
    expect(elig.composeEligibilitySkipReason((await storeRow(id))!)).toBeNull();
    const measures = (body["measures"] ?? {}) as Row;
    expect(Number(measures["armed_system_authored"])).toBeGreaterThanOrEqual(1);
    expect(Number(measures["system_authored_red_at_head"])).toBeGreaterThanOrEqual(1);
    expect(typeof measures["system_authored_share"]).toBe("number");
    expect(typeof measures["red_at_head_share"]).toBe("number");
  });

  it("NO APPEND (B′): two gaps on the same edit site each get their own check file in the same tick; nothing is busy", async () => {
    expect(supply).not.toBeNull();
    const first = T("sgc-append-first"), second = T("sgc-append-second");
    await seed(first, `append fixture ${RUN}: local-tools-vessel src/shell-containment.ts containShell lets GIT_DIR=.git through`, {});
    await seed(second, `append fixture two ${RUN}: local-tools-vessel src/shell-containment.ts containShell lets GIT_DIR=../.git through`, {});
    rhythms = [dueRhythm({ max_per_tick: 50, max_attempts: 10 })];
    await tick({ now_ms: Date.now() + 1200 * 3600_000 });
    expect(goals.filter((g) => g.variables?.["gap_id"] === first).length).toBe(1);
    expect(goals.filter((g) => g.variables?.["gap_id"] === second).length).toBe(1);
    const f1 = String(ledgerOf(metaOf(await storeRow(first)))["test_file"]);
    const f2 = String(ledgerOf(metaOf(await storeRow(second)))["test_file"]);
    expect(f1).toMatch(CHECK_RE);
    expect(f2).toMatch(CHECK_RE);
    expect(f1).not.toBe(f2);
    // the existing test is untouched by either goal
    for (const g of goals) expect(g.goal).not.toContain(EXISTING_TEST);
  });

  it("a re-dispatched check arms from the NEW titles only (the previous attempt's titles are its baseline)", async () => {
    expect(supply).not.toBeNull();
    const t0 = Date.now() + 1250 * 3600_000;
    const { id, testFile } = await landTest("sgc-baseline", (t) => `import { expect, test } from "bun:test";\nimport { containShell } from "../../src/shell-containment.js";\ntest("${t}", () => { expect(containShell("ls")).toBe(true); });\n`, t0);
    // attempt 1 lands GREEN: nothing is armed, the gap waits out its backoff
    verdictFor = (gid) => (gid === id ? "absent" : "present");
    await tick({ now_ms: t0 + 3600_000 });
    expect(ledgerOf(metaOf(await storeRow(id)))["state"]).toBe("green_at_head");
    const oldTitle = `sgc-baseline reproduces ${RUN}`;
    // attempt 2: the same check file; its existing title is the baseline
    rhythms = [dueRhythm({ max_per_tick: 50, max_attempts: 10 })];
    await tick({ now_ms: t0 + 30 * 3600_000 });
    const led = ledgerOf(metaOf(await storeRow(id)));
    expect(led["state"]).toBe("goal_dispatched");
    expect(led["test_file"]).toBe(testFile);
    expect(led["baseline_titles"]).toEqual([oldTitle]);
    const newTitle = `sgc-baseline new red ${RUN}`;
    writeFileSync(join(CLONES, VESSEL, testFile), readFileSync(join(CLONES, VESSEL, testFile), "utf-8") + `test("${newTitle}", () => { expect(containShell("GIT_DIR=.git git config core.hooksPath /tmp/h")).toBe(false); });\n`);
    verdictFor = () => "present";
    await tick({ now_ms: t0 + 31 * 3600_000 });
    const m = metaOf(await storeRow(id));
    expect(m["falsifier"]).toBe("class2");
    expect(((m["evidence_resolve"] as Row)["input"] as Row)["test_file"]).toBe(testFile);
    expect(((m["evidence_resolve"] as Row)["input"] as Row)["only_tests"]).toEqual([newTitle]);
    expect(m["edit_site"]).toBe(SITE);
  });

  it("a test GREEN at HEAD does NOT arm the gap (fail closed)", async () => {
    expect(supply).not.toBeNull();
    const { id } = await landTest("sgc-arm-green", (t) => `import { expect, test } from "bun:test";\nimport { containShell } from "../../src/shell-containment.js";\ntest("${t}", () => { expect(containShell("ls")).toBe(true); });\n`, Date.now() + 2000 * 3600_000);
    verdictFor = (gid) => (gid === id ? "absent" : "present");
    await tick({ now_ms: Date.now() + 2100 * 3600_000 });
    expect(judged).toContain(id);
    const m = metaOf(await storeRow(id));
    expect(m["evidence_resolve"]).toBeUndefined();
    expect(m["falsifier"]).not.toBe("class2");
    expect(ledgerOf(m)["state"]).toBe("green_at_head");
    expect(elig.composeEligibilitySkipReason((await storeRow(id))!)).not.toBeNull();
  });

  it("a trivial red that does not import the edit site (expect(1).toBe(2)) does NOT arm", async () => {
    expect(supply).not.toBeNull();
    const { id } = await landTest("sgc-trivial", (t) => `import { expect, test } from "bun:test";\ntest("${t}", () => { expect(1).toBe(2); });\n`, Date.now() + 2200 * 3600_000);
    await tick({ now_ms: Date.now() + 2300 * 3600_000 });
    const m = metaOf(await storeRow(id));
    expect(m["evidence_resolve"]).toBeUndefined();
    expect(m["falsifier"]).not.toBe("class2");
    expect(ledgerOf(m)["state"]).toBe("arm_refused");
  });

  it("a gap WITH its own edit site: an assertion-red test that imports nothing does NOT arm; the refusal names the import", async () => {
    expect(supply).not.toBeNull();
    const id = T("sgc-noimport");
    await seed(id, `sgc-noimport fixture ${RUN}: local-tools-vessel site-x misbehaves: \`site_x_ts\` is 1; it must be 2`, { edit_site: `repos/${VESSEL}/src/site-x.ts` });
    rhythms = [dueRhythm({ max_per_tick: 50, max_attempts: 10 })];
    await tick({ now_ms: Date.now() + 2600 * 3600_000 });
    const testFile = String(ledgerOf(metaOf(await storeRow(id)))["test_file"] ?? "");
    expect(testFile).toMatch(CHECK_RE);
    writeFileSync(join(CLONES, VESSEL, testFile), `import { expect, test } from "bun:test";\ntest("noimport red ${RUN}", () => { expect(1).toBe(2); });\n`);
    await tick({ now_ms: Date.now() + 2700 * 3600_000 });
    const m = metaOf(await storeRow(id));
    expect(m["evidence_resolve"]).toBeUndefined();
    expect(m["falsifier"]).not.toBe("class2");
    expect(ledgerOf(m)["state"]).toBe("arm_refused");
    expect(String(ledgerOf(m)["reason"])).toContain("does not import the edit site");
  });

  it("a gap WITH its own edit site: an assertion-red test importing a DIFFERENT module does NOT arm; the refusal names the import", async () => {
    expect(supply).not.toBeNull();
    const id = T("sgc-otherimport");
    await seed(id, `sgc-otherimport fixture ${RUN}: local-tools-vessel site-x misbehaves: \`site_x_ts\` is 1; it must be 2`, { edit_site: `repos/${VESSEL}/src/site-x.ts` });
    rhythms = [dueRhythm({ max_per_tick: 50, max_attempts: 10 })];
    await tick({ now_ms: Date.now() + 2800 * 3600_000 });
    const testFile = String(ledgerOf(metaOf(await storeRow(id)))["test_file"] ?? "");
    expect(testFile).toMatch(CHECK_RE);
    writeFileSync(join(CLONES, VESSEL, testFile), `import { expect, test } from "bun:test";\nimport { site_y_ts } from "../../src/site-y.js";\ntest("otherimport red ${RUN}", () => { expect(site_y_ts).toBe(2); });\n`);
    await tick({ now_ms: Date.now() + 2900 * 3600_000 });
    const m = metaOf(await storeRow(id));
    expect(m["evidence_resolve"]).toBeUndefined();
    expect(m["falsifier"]).not.toBe("class2");
    expect(ledgerOf(m)["state"]).toBe("arm_refused");
    expect(String(ledgerOf(m)["reason"])).toContain("does not import the edit site");
  });

  it("CONTROL: a gap WITH its own edit site and an assertion-red test importing that module arms", async () => {
    expect(supply).not.toBeNull();
    const id = T("sgc-siteimport");
    await seed(id, `sgc-siteimport fixture ${RUN}: local-tools-vessel site-x misbehaves: \`site_x_ts\` is 1; it must be 2`, { edit_site: `repos/${VESSEL}/src/site-x.ts` });
    rhythms = [dueRhythm({ max_per_tick: 50, max_attempts: 10 })];
    await tick({ now_ms: Date.now() + 3000 * 3600_000 });
    const testFile = String(ledgerOf(metaOf(await storeRow(id)))["test_file"] ?? "");
    expect(testFile).toMatch(CHECK_RE);
    writeFileSync(join(CLONES, VESSEL, testFile), `import { expect, test } from "bun:test";\nimport { site_x_ts } from "../../src/site-x.js";\ntest("siteimport red ${RUN}", () => { expect(site_x_ts).toBe(2); });\n`);
    await tick({ now_ms: Date.now() + 3100 * 3600_000 });
    const m = metaOf(await storeRow(id));
    expect(m["falsifier"]).toBe("class2");
    expect(m["edit_site"]).toBe(`repos/${VESSEL}/src/site-x.ts`);
  });

  it("a test that fails to LOAD (red, but the named test is not among the failures) does NOT arm", async () => {
    expect(supply).not.toBeNull();
    const { id } = await landTest("sgc-loadfail", IMPORTING_RED, Date.now() + 2400 * 3600_000);
    reportFor = (gid, t) => (gid === id ? { ran: true, total: 1, fail: 1, failingTests: ["(fail) (unnamed)"], red_reason: { ran: true, pass: 0, unhandled: true, unhandled_cause: "module", unhandled_error: "error: Cannot find module", failures: [] } } : { ran: true, total: t.length, fail: t.length, failingTests: t.map((x) => `(fail) ${x}`), red_reason: assertionRedReason(t) });
    await tick({ now_ms: Date.now() + 2500 * 3600_000 });
    expect(judged).toContain(id);
    const m = metaOf(await storeRow(id));
    expect(m["evidence_resolve"]).toBeUndefined();
    expect(m["falsifier"]).not.toBe("class2");
    expect(ledgerOf(m)["state"]).toBe("arm_refused");
  });

  it("[B′] a named test that IS among the failures but failed for a wrong reason (the shared classifier says network) does NOT arm", async () => {
    expect(supply).not.toBeNull();
    const { id } = await landTest("sgc-wrongreason", IMPORTING_RED, Date.now() + 2450 * 3600_000);
    reportFor = (gid, t) => ({ ran: true, total: t.length, fail: t.length, failingTests: t.map((x) => `(fail) ${x}`), red_reason: gid === id ? { ...assertionRedReason(t), failures: t.map((name) => ({ name, cls: "wrong_reason", cause: "network", error: "TypeError: Unable to connect." })) } : assertionRedReason(t) });
    await tick({ now_ms: Date.now() + 2550 * 3600_000 });
    expect(judged).toContain(id);
    const m = metaOf(await storeRow(id));
    expect(m["evidence_resolve"]).toBeUndefined();
    expect(ledgerOf(m)["state"]).toBe("arm_refused");
    expect(String(ledgerOf(m)["reason"])).toContain("network");
  });
});

describe("system-authored gap checks: (d) cadence comes from a rhythm impulse", () => {
  it("no timeShapedRhythm for the family, or one not due, dispatches nothing", async () => {
    expect(supply).not.toBeNull();
    const id = T("sgc-norhythm");
    await seed(id, `rhythm fixture ${RUN}: local-tools-vessel containShell lets env git through`, {});
    rhythms = [];
    const none = await tick();
    expect(none["fired"]).toBe(false);
    expect(none["reason"]).toBe("no_rhythm");
    rhythms = [dueRhythm({ staleness: 0 })];
    const notDue = await tick();
    expect(notDue["fired"]).toBe(false);
    expect(notDue["reason"]).toBe("not_due");
    expect(goals.length).toBe(0);
  });

  it("source: reads timeShapedRhythm at use time; no timer or env cadence; the conductor and a seeded tick template carry it", () => {
    let src = "";
    try { src = readFileSync(RESOLVER_FILE, "utf-8"); } catch { src = ""; }
    expect(src).toContain("timeShapedRhythm");
    expect(src).not.toMatch(/\bset(Interval|Timeout)\s*\(/);
    expect(src).not.toMatch(/process\.env\[?["'.]?[A-Z_]*(INTERVAL|CADENCE|PERIOD|BACKOFF|PER_TICK)/);
    const cond = readFileSync(CONDUCTOR_FILE, "utf-8");
    expect(cond).toMatch(/"gap-check-supply":\s*\{\s*type:\s*"gap_check_supply_tick"/);
    let seedSrc = "";
    try { seedSrc = readFileSync(SEED_FILE, "utf-8"); } catch { seedSrc = ""; }
    expect(seedSrc).toContain('resolver: "gap_check_supply_tick"');
  });

  it("the conductor reads the WHOLE registry: a gap-check-supply rhythm after the first 50 rows is fired through its direct resolver", async () => {
    const fillers: Row[] = Array.from({ length: 55 }, (_, i) => ({
      id: `rhythm-filler-${i}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(),
      body: { axis: "load", family: `filler-${i}`, budget: 0.2, alpha: 1, beta: 1, staleness: 0 },
    }));
    registryOverride = [...fillers, { ...dueRhythm(), id: "rhythm-gap-check-supply", updated_at: "2026-01-01T00:00:00.000Z" }];
    __setDiscoveryForTests({
      lookup: async (shape: string) => ({ ok: true, shape, cached: false, producers: [{ id: "pool-fixture", resolveEndpoint: "http://pool.fixture/v2/impulses/resolve", origin: "local" }] }),
      describe: (r: { shape?: string }) => `${String(r.shape)} fixture producer`,
      failureBackoffMs: 2_000,
    } as never);
    const queue = join(ROOT, `queue-${RUN}.json`);
    writeFileSync(queue, JSON.stringify({ tasks: [] }));
    try {
      const r = await conductor.resolveRhythmConductorTick({ type: "rhythm_conductor_tick", bucket_load: 0, registry_endpoint: "http://test/v2/impulses/resolve", queue_path: queue });
      const body = r.body as Row;
      expect(body["considered"]).toBe(56);
      expect(body["registry_complete"]).toBe(true);
      expect(directCalls.length).toBe(1);
      expect(directCalls[0]!["type"]).toBe("gap_check_supply_tick");
      // the conductor leaves a report-settled family PENDING: no credit for the call returning
      expect(rhythmWrites.filter((w) => w["id"] === "rhythm-gap-check-supply").length).toBe(0);
    } finally {
      __resetDiscoveryForTests();
    }
  });
});

describe("system-authored gap checks: (e) graded by the tick's report, not the exit", () => {
  it("the conductor settles gap-check-supply PENDING whatever its direct call returned (or if it outlived the wait)", () => {
    const settle = (conductor as Record<string, unknown>)["directFamilySettlement"] as undefined | ((spec: unknown, resp: unknown) => string);
    const families = (conductor as Record<string, unknown>)["FAMILY_RESOLVERS"] as Record<string, Row> | undefined;
    expect(typeof settle).toBe("function");
    expect(settle!(families?.["gap-check-supply"], null)).toBe("pending");
    expect(settle!(families?.["gap-check-supply"], { body: { dispatched: [{}] } })).toBe("pending");
    expect(settle!(families?.["gap-organizing"], null)).toBe("alpha");
  });

  it("the tick's report decides the leg: something done = success, all refused = failure, nothing done = neither", () => {
    expect(supply).not.toBeNull();
    // A dispatch alone is no longer pinned to alpha: credit comes from an armed check (gap-check-supply-outcome.test.ts,
    // gap gap-check-supply-never-reads-its-dispatch-outcome-so-a-failed-test-writing-goal-sits-goal-dispatched-forever).
    expect(supply!.checkSupplySettlementLeg({ dispatched: 0, armed: 1, refused: 2 })).toBe("alpha");
    expect(supply!.checkSupplySettlementLeg({ dispatched: 0, armed: 0, refused: 1 })).toBe("beta");
    expect(supply!.checkSupplySettlementLeg({ dispatched: 0, armed: 0, refused: 0 })).toBeNull();
  });

  it("a completed tick that dispatched settles its family success; one that did nothing writes no settlement", async () => {
    expect(supply).not.toBeNull();
    await seed(T("sgc-settle"), `settle fixture ${RUN}: local-tools-vessel containShell lets env git through`, {});
    rhythms = [dueRhythm({ max_per_tick: 50 })];
    const t = Date.now() + 3000 * 3600_000;
    await tick({ now_ms: t });
    // What a dispatching tick settles is pinned in gap-check-supply-outcome.test.ts (same gap); here only the idle half.
    rhythmWrites = [];
    const idle = await tick({ now_ms: t + 60_000 }); // everything is inside its backoff
    expect((idle["dispatched"] as unknown[]).length).toBe(0);
    expect(rhythmWrites.length).toBe(0);
  });
});

describe("system-authored gap checks: (f) a control arm for causal measurement", () => {
  it("a control-arm gap is classified and recorded but gets no goal; its arm is stable for its id", async () => {
    expect(supply).not.toBeNull();
    const id = idIn(`sgc-control-${RUN}`, "control");
    expect(supply!.checkSupplyArm(id)).toBe("control");
    expect(supply!.checkSupplyArm(id)).toBe(supply!.checkSupplyArm(String(id)));
    await seed(id, `control fixture ${RUN}: local-tools-vessel containShell lets env git through`, {});
    rhythms = [dueRhythm({ max_per_tick: 50 })];
    const body = await tick({ now_ms: Date.now() + 4000 * 3600_000 });
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(0);
    const m = metaOf(await storeRow(id));
    expect(m["gap_check_supply_arm"]).toBe("control");
    expect(m["disposition"]).toBe("needs_localization");
    expect(m["check_supply"]).toBeUndefined();
    expect(Number(((body["arms"] ?? {}) as Row)["control"])).toBeGreaterThanOrEqual(1);
    expect(Number(((body["arms"] ?? {}) as Row)["treatment"])).toBeGreaterThanOrEqual(1);
  });
});

// (g) C-invented-1: AN EXISTENCE ASSERTION IS NEVER A FALSIFIER. The goal never offers an example symbol (a drafter copied the
// old `["name"]` example; `export function name()` then "fixed" the gap). A symbol anchors a check only when it ALREADY
// resolves in the code (used/declared in the edit site's code; with no site, declared in the vessel's src), so the red must
// come from behaviour; text anchors only when it is an observed output; a code-site gap with no anchor gets NO goal (loud
// no_anchor, re-read every tick).
describe("system-authored gap checks: (g) anchors come from the evidence and resolve in the code", () => {
  const anchorsOf = (evidence: string, site: string | null, spec = "", decl: Set<string> | null = null): Array<[string, string]> =>
    (supply as unknown as { falsifiableAnchors: (e: string, s: string | null, sp?: string, d?: Set<string> | null) => Array<{ kind: string; value: string }> })
      .falsifiableAnchors(evidence, site, spec, decl).map((a) => [a.kind, a.value]);
  const SITE_SRC = [
    "export async function resolveLedgerDigest(p: unknown) { return parseLedger(String(p)); }",
    "export function parseLedger(s: string) { return s ? [s] : null; }",
    "export function computeTotals(rows: number[]) { return rows.reduce((a, b) => a + b, 0); }",
    "export function name(): string { return \"satisfier:ledger_digest\"; }",
    "const SHAPE = \"ledgerDigestReport\"; // emits scriptRunResult rows",
  ].join("\n");
  const cases: Array<[string, string, string | null, string, Array<[string, string]>]> = [
    ["symptom-only (capability id, class label, path)", "Capability 'satisfier:ledger_digest' is systematically failing due to an 'execution_error'. I was unable to retrieve the source code for repos/x/src/ledger-digest.ts", SITE_SRC, "", []],
    ["the ORIGINAL (c) fixture text: symptom-only", "sgc fixture: local-tools-vessel site-x misbehaves", SITE_SRC, "", []],
    ["MUST-FAIL (a): a camelCase SHAPE the site does not use", "the walk produced no scriptRunResult and no gvlPointer for this goal", SITE_SRC, "", []],
    ["MUST-FAIL (a): a camelCase name present only in a string or comment of the site", "ledgerDigestReport is never written", SITE_SRC, "", []],
    ["MUST-FAIL (b): a plain word that happens to be an export (`name`), not code-formatted", "the report has the wrong name for the vessel", SITE_SRC, "", []],
    ["MUST-FAIL (c): a quoted GOAL question is not an observed output", 'goal "What is happening within this codebase?" was not reached', SITE_SRC, "", []],
    ["a quoted phrase with no output context is not an anchor", 'the user asked "summarise the open orders please" twice', SITE_SRC, "", []],
    ["backticked symbol that resolves", "`parseLedger` gives up on an empty file", SITE_SRC, "", [["symbol", "parseLedger"]]],
    ["called symbol that resolves", "computeTotals( ) double counts refunds", SITE_SRC, "", [["symbol", "computeTotals"]]],
    ["a code-formatted symbol that does NOT resolve is not an anchor", "`rateLimiter` lets a burst through", SITE_SRC, "", []],
    ["no edit site: resolves only against the vessel's declarations", "rateLimiter lets a burst of 50 through", null, "", [["symbol", "rateLimiter"]]],
    ["no edit site, undeclared camelCase: none", "scriptRunResult was empty", null, "", []],
    ["an observed message in quotes (context word)", 'the importer logs "missing header row in upload" and stops', SITE_SRC, "", [["text", "missing header row in upload"]]],
    ["a quoted phrase in the falsifier_spec is an observed output", "the importer stops early", SITE_SRC, 'must-fail: "missing header row in upload" is printed', [["text", "missing header row in upload"]]],
    ["behaviour pair", "the widget returns 1; it must return 2", SITE_SRC, "", [["behaviour", "returns 1; it must return 2"]]],
    ["the ORIGINAL widget fixture text: a plain word, even one the site declares, is not an anchor", "local-tools-vessel src/widget.ts widget returns the wrong value", "export function widget() { return 1; }", "", []],
    ["MUST-FAIL (b'): the hollow export `name` with a behaviour verb, as a plain word, does not anchor", "the vessel name lets nothing through", SITE_SRC, "", []],
  ];
  for (const [label, evidence, site, spec, want] of cases) it(`${label} → ${want.length ? want.map((w) => w.join(":")).join(", ") : "no anchor"}`, () => {
    expect(typeof (supply as unknown as Row)["falsifiableAnchors"]).toBe("function");
    expect(anchorsOf(evidence, site, spec, site === null ? new Set(["rateLimiter", "containShell"]) : null)).toEqual(want);
  });

  it("MUST-FAIL: a symptom-only code-site gap gets NO goal; it is recorded no_anchor (loud, falsifier unknown) and re-read when its evidence gains an anchor", async () => {
    expect(supply).not.toBeNull();
    const id = T("sgc-noanchor");
    await seed(id, `noanchor fixture ${RUN}: local-tools-vessel site-x misbehaves`, { edit_site: SITE });
    await tick({ now_ms: Date.now() + 2000 * 3600_000 });
    expect(goals.filter((g) => g.variables?.["gap_id"] === id)).toEqual([]);
    const m = metaOf(await storeRow(id));
    expect(ledgerOf(m)["state"]).toBe("no_anchor");
    expect(ledgerOf(m)["reason"]).toBe("evidence names no falsifiable anchor");
    expect(m["falsifier"] ?? "none").toBe("none");
    await seed(id, `noanchor fixture ${RUN}: \`containShell\` returns true for "git -c core.hooksPath=/tmp/h status"; it must return false`, { edit_site: SITE });
    await tick({ now_ms: Date.now() + 2001 * 3600_000 });
    const g = goals.filter((x) => x.variables?.["gap_id"] === id);
    expect(g.length).toBe(1);
    expect(g[0]!.goal).toContain("symbol `containShell`");
  });

  it("CONTROL: a CONFIG edit site (an activity seed) keeps its consumer-behaviour goal; the anchor rule is for code sites", async () => {
    expect(supply).not.toBeNull();
    mkdirSync(join(CLONES, VESSEL, "src", "seed"), { recursive: true });
    writeFileSync(join(CLONES, VESSEL, "src", "seed", "shell-ticks.ts"), "export const SHELL_TICKS = [{ id: \"shell-tick\", resolver: \"shell_report\" }];\n");
    const id = T("sgc-config");
    await seed(id, `config fixture ${RUN}: the shell report tick is systematically failing`, { edit_site: `repos/${VESSEL}/src/seed/shell-ticks.ts` });
    await tick({ now_ms: Date.now() + 2003 * 3600_000 });
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(1);
    expect(ledgerOf(metaOf(await storeRow(id)))["state"]).toBe("goal_dispatched");
  });

  it("MUST-FAIL (d) + G2: a goal built on a resolved symbol asks for behaviour, with no existence/typeof wording and no placeholder anywhere", async () => {
    expect(supply).not.toBeNull();
    const id = T("sgc-g2");
    await seed(id, GIT_DIR_SUMMARY, { edit_site: SITE });
    await tick({ now_ms: Date.now() + 2002 * 3600_000 });
    const g = goals.filter((x) => x.variables?.["gap_id"] === id)[0]!;
    expect(g.goal).toContain("symbol `containShell`");
    expect(g.goal).toMatch(/what it returns, throws, logs or prints/);
    expect(g.goal).not.toMatch(/typeof|\bexist|\["name"\]|must exist/i);
    expect(readFileSync(RESOLVER_FILE, "utf8")).not.toMatch(/\["name"\]|for a symbol that must exist/);
  });
});

// (h) ARM-GUARD: AN EXISTENCE-ONLY CHECK IS NEVER ARMED. The arm step refuses a landed check whose every assertion in its named
// tests only asserts that a name exists, is defined, or has a type (typeof … "function", toBeDefined, `"x" in mod`,
// toHaveProperty, Object.keys containment, toBeInstanceOf(Function)): adding the name closes it. It covers every check the old
// goal builder wrote. One behaviour assertion keeps a check armable; the red-for-the-right-reason judge decides as before.
describe("system-authored gap checks: (h) an existence-only check is never armed", () => {
  const ex = (src: string, titles: string[]) => (supply as unknown as { existenceOnlyCheck: (s: string, t: string[]) => { existence_only: boolean; assertions: number; existence: number } }).existenceOnlyCheck(src, titles);
  const IMP = `import { expect, test } from "bun:test";\nimport * as mod from "../../src/shell-containment.js";\n`;
  const forms: Array<[string, string]> = [
    ["typeof … toBe(\"function\")", `expect(typeof (mod as Record<string, unknown>)["name"]).toBe("function");`],
    ["typeof member .not.toBe(\"undefined\")", `expect(typeof mod.containShellStrict).not.toBe("undefined");`],
    ["toBeDefined on a module member", `expect((mod as any).getTypesafeJevDecision).toBeDefined();`],
    ["not.toBeUndefined", `expect(mod["checkThing"]).not.toBeUndefined();`],
    ["\"x\" in mod", `expect("containShellStrict" in mod).toBe(true);`],
    ["toHaveProperty", `expect(mod).toHaveProperty("containShellStrict");`],
    ["Object.keys containment", `expect(Object.keys(mod)).toContain("containShellStrict");`],
    ["toBeInstanceOf(Function)", `expect(mod.containShell).toBeInstanceOf(Function);`],
    ["two existence assertions together", `expect(typeof mod.a).toBe("function");\n  expect(mod.b).toBeDefined();`],
  ];
  for (const [label, body] of forms) it(`MUST-FAIL: ${label} → existence-only`, () => {
    expect(typeof (supply as unknown as Row)["existenceOnlyCheck"]).toBe("function");
    const r = ex(`${IMP}test("t1", () => {\n  ${body}\n});\n`, ["t1"]);
    expect(r.existence_only).toBe(true);
  });
  const behaviours: Array<[string, string]> = [
    ["a call's result", `expect(mod.containShell("GIT_DIR=.git git config core.hooksPath /tmp/h")).toBe(false);`],
    ["a throw", `expect(() => mod.containShell("")).toThrow("empty command");`],
    ["MIXED: existence + a behaviour assertion", `expect(typeof mod.containShell).toBe("function");\n  expect(mod.containShell("rm -rf /")).toBe(false);`],
    ["typeof of a CALL's result alone (it calls the code: behaviour, not a name)", `expect(typeof mod.containShell("ls")).toBe("boolean");`],
  ];
  for (const [label, body] of behaviours) it(`CONTROL: ${label} → armable`, () => {
    expect(ex(`${IMP}test("t1", () => {\n  ${body}\n});\n`, ["t1"]).existence_only).toBe(false);
  });
  it("only the NAMED tests count: an existence-only named test is refused even if another test in the file asserts behaviour", () => {
    const src = `${IMP}test("named", () => { expect(mod.thing).toBeDefined(); });\ntest("other", () => { expect(mod.containShell("ls")).toBe(true); });\n`;
    expect(ex(src, ["named"]).existence_only).toBe(true);
    expect(ex(src, ["named", "other"]).existence_only).toBe(false);
  });
  it("MUST-FAIL (tick): a landed existence-only check is NOT armed; state existence_only, loud reason, falsifier unchanged", async () => {
    expect(supply).not.toBeNull();
    const { id } = await landTest("sgc-exonly", (t) => `${IMP}test("${t}", () => { expect(typeof (mod as Record<string, unknown>)["name"]).toBe("function"); });\n`, Date.now() + 3000 * 3600_000);
    await tick({ now_ms: Date.now() + 3100 * 3600_000 });
    const m = metaOf(await storeRow(id));
    expect(ledgerOf(m)["state"]).toBe("existence_only");
    expect(String(ledgerOf(m)["reason"])).toMatch(/^existence_only: all 1 assertion\(s\)/);
    expect(m["falsifier"] ?? "none").toBe("none");
    expect(m["evidence_resolve"] ?? null).toBeNull();
    expect(judged.filter((x) => x === id)).toEqual([]); // refused before the birth verdict runs
  });
  it("CONTROL (tick): a landed behaviour check arms as before", async () => {
    expect(supply).not.toBeNull();
    const { id } = await landTest("sgc-behaviour", IMPORTING_RED, Date.now() + 3200 * 3600_000);
    await tick({ now_ms: Date.now() + 3300 * 3600_000 });
    expect(metaOf(await storeRow(id))["falsifier"]).toBe("class2");
  });
});
