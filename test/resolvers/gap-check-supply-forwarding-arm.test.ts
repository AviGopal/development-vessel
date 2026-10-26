// THE ARM STEP ON A NODE THAT FORWARDS ITS GAP STORE (GAP_STORE_ENDPOINT set) HANDS THE CHECK TO THE HOLDER.
//
// Measured deadlock: the node that runs check supply continuously forwards its gap store. Its arm step spent the
// tick's budget (max_per_tick, default 1) on the first row whose check had landed, then asked the one judge, which
// abstains on a forwarding node ("the gap store is held elsewhere, so its sweep measures it") -> 'unknown' -> the row
// stayed goal_dispatched with nothing logged, and was re-judged, and abstained, on every tick. No gap could arm there.
//
// The holder's own write seam already measures any class-2 check written to it without a minted verdict
// (substrate-gap applyBirthStamp -> scheduleBirthEvaluation -> the one judge, where the store is held), and the
// minted stamp never crosses the forward anyway. So the forwarding node writes the candidate, keeping the
// needs-localization hold, and settles from the holder's stamp on a later tick.
//
// The two nodes are one process here: the holder is the in-process substrate-gap resolver answering the forward URL
// with GAP_STORE_ENDPOINT unset for the whole of its turn (the write AND its scheduled birth evaluation), and the
// check runs through the REAL test_suite resolver against a temp clone, as in gap-check-supply-check-file.test.ts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-fwdarm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const HOLDER = "http://holder.test/v2/impulses/resolve";
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT", "SELF_RESOLVE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
process.env["SELF_RESOLVE_ENDPOINT"] = "http://self.test/v2/impulses/resolve";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const elig = await import("../../src/judge/gap-eligibility.js");
const supply = await import("../../src/resolvers/gap-check-supply.js");
const csa = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
const { resolveTestSuite } = await import("../../src/resolvers/test-suite.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "fixture-vessel";
const H = `import { expect, test } from "bun:test";\n`;
const SITE = `repos/${VESSEL}/src/widget.ts`;

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let maxPerTick = 50;
/** Every check run, and which node ran it (the holder: GAP_STORE_ENDPOINT unset while it ran). */
let suiteRuns: Array<{ test_file: unknown; body: Row; on_holder: boolean }> = [];
/** The holder's row right after each forwarded write that carried a check, BEFORE its birth evaluation ran. */
let beforeEval: Array<{ id: string; verdict: unknown; eligibility: unknown; suspect: string | null; state: unknown }> = [];
let holderGate: Promise<void> | null = null;
/** Check files the holder cannot measure (its run reports measured:false, which the judge reads as unknown). */
let unmeasurable = new Set<string>();
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
let lastShellOutput = "";
const dueRhythm = (): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(), body: { axis: "load", family: "gap-check-supply", require_control: false, budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: maxPerTick, backoff_hours: 24, max_attempts: 5 } });

/** The holder's turn: the store is held here, so nothing is forwarded and the one judge does not abstain. */
async function asHolder<T>(fn: () => Promise<T>): Promise<T> {
  const was = process.env["GAP_STORE_ENDPOINT"];
  delete process.env["GAP_STORE_ENDPOINT"];
  try { return await fn(); } finally { if (was === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = was; }
}
async function holderRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
/** The forward URL, answered by the holder's own resolvers (the route's dispatch, in process). */
async function holderAnswers(pointer: Row): Promise<Response> {
  // The holder serves the check's own pointer too, as a real holder does: a forwarding node reads a present's run
  // report there (gap-check-supply holderCheckReport), the holder's run on the holder's tree.
  if (pointer["type"] === "test_suite") return asHolder(() => fetch("http://self.test/v2/impulses/resolve", { method: "POST", body: JSON.stringify({ impulse: { pointer } }) }));
  return asHolder(async () => {
    let release: () => void = () => {};
    holderGate = new Promise<void>((r) => { release = r; });
    try {
      let r: { shape: string; body: unknown };
      if (pointer["type"] === "substrateGap") r = await sg.resolveSubstrateGap(pointer as never);
      else if (pointer["type"] === "substrateGap_write") {
        r = await sg.resolveSubstrateGapWrite(pointer as never);
        const g = (pointer["gap"] ?? {}) as Row;
        if (((g["classification_metadata"] ?? {}) as Row)["evidence_resolve"]) {
          const row = await holderRow(String(g["id"]));
          const m = metaOf(row);
          beforeEval.push({ id: String(g["id"]), verdict: m["predicate_birth_verdict"], eligibility: row ? elig.composeEligibilitySkipReason(row) : "absent", suspect: sg.predicateSuspect(m), state: ledgerOf(row)["state"] });
        }
      } else r = { shape: "structuredError", body: { detail: `the test holder does not serve ${String(pointer["type"])}` } };
      release();
      await sg.__settleBirthEvaluationsForTests();
      return Response.json(r);
    } finally { release(); holderGate = null; }
  });
}

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const d of ["src", "test/checks", "node_modules"]) mkdirSync(join(CLONES, VESSEL, d), { recursive: true });
  mkdirSync(join(RUNTIME, VESSEL, "src"), { recursive: true });
  for (const base of [join(CLONES, VESSEL), join(RUNTIME, VESSEL)]) writeFileSync(join(base, "src", "widget.ts"), "export const widget = 1;\n");
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url === HOLDER) return holderAnswers((imp.pointer ?? {}) as Row);
    if (url.endsWith("/run-goal")) return Response.json({ dispatchId: `d-${RUN}-${Math.random().toString(36).slice(2, 8)}` }, { status: 202 });
    if (url === "http://self.test/v2/impulses/resolve" && imp?.pointer?.type === "test_suite") {
      if (holderGate) await holderGate;
      const onHolder = !process.env["GAP_STORE_ENDPOINT"];
      if (unmeasurable.has(String(imp.pointer.test_file))) {
        suiteRuns.push({ test_file: imp.pointer.test_file, body: { measured: false }, on_holder: onHolder });
        return Response.json({ shape: "test_suite", body: { test_file: imp.pointer.test_file, ran: false, measured: false, why: "fixture: the holder cannot measure this check" } });
      }
      const r = await resolveTestSuite(imp.pointer);
      const b = { ...((r.body ?? {}) as Row) };
      suiteRuns.push({ test_file: b["test_file"], body: b, on_holder: onHolder });
      return Response.json({ shape: r.shape, body: b });
    }
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability" && (body?.pointer ?? imp?.pointer)?.shape === "shellResult") {
      return Response.json({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } });
    }
    if (url.startsWith("http://shell.test")) {
      const local = String(imp?.pointer?.command ?? "").replace(/^ROOT='[^']*'/, `ROOT='${join(CLONES, VESSEL)}'`);
      const p = Bun.spawnSync(["bash", "-c", local], { cwd: join(CLONES, VESSEL), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
      lastShellOutput = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
      return Response.json({ stdout: lastShellOutput });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: [dueRhythm()], count: 1 } });
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write") return Response.json({ body: { ok: true } });
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  console.log = () => {};
  console.warn = () => {};
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch;
  console.log = origLog;
  console.warn = origWarn;
  restoreCutoverExecModules();
  __resetDiscoveryForTests();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { suiteRuns = []; beforeEval = []; unmeasurable = new Set(); maxPerTick = 50; delete process.env["GAP_STORE_ENDPOINT"]; execGuard = installCutoverExecGuard(); g2fPolicy.__resetPolicyReadsForTests(); });
afterEach(() => { delete process.env["GAP_STORE_ENDPOINT"]; expect(execGuard?.restore() ?? []).toEqual([]); });

const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);
const ledgerOf = (r: Row | undefined): Row => ((metaOf(r)["check_supply"] ?? {}) as Row);
async function seed(id: string): Promise<void> {
  const summary = `fixture ${id}: repos/${VESSEL}/src/widget.ts \`widget\` returns 1 where 2 is required`;
  const w = await asHolder(() => sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: {} } } as never));
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await asHolder(() => sg.__settleBirthEvaluationsForTests());
}
/** One check-supply tick on the FORWARDING node: its gap reads and writes go to HOLDER. */
async function forwardingTick(now: number): Promise<Row> {
  process.env["GAP_STORE_ENDPOINT"] = HOLDER;
  try {
    const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
    return r.body as Row;
  } finally { delete process.env["GAP_STORE_ENDPOINT"]; }
}
/** One tick on the HOLDER (the store held here). */
async function holderTick(now: number): Promise<Row> {
  const r = await asHolder(() => supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never));
  await asHolder(() => sg.__settleBirthEvaluationsForTests());
  return r.body as Row;
}
const stored = (id: string): Promise<Row | undefined> => asHolder(() => holderRow(id));
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
const checkPathOf = (id: string): string => `test/checks/${(csa["checkSupplyCheckFile"] as (x: string) => string)(id)}`;
const writeCheck = (id: string, title: string, expected: number): void =>
  writeFileSync(join(CLONES, VESSEL, checkPathOf(id)), `${H}import * as mod from "../../src/widget";\ntest("${title}", () => { expect(mod.widget).toBe(${expected}); });\n`);
let clock = Date.now() + 5000 * 3600_000;
const later = (): number => (clock += 30 * 3600_000);
/** A minute on: inside every outcome bound, so a dispatched row with no titles is left unwritten (the store reads newest first). */
const soon = (): number => (clock += 60_000);

// First, so the holder's one-per-tick budget meets only this test's rows.
describe("[CONTROL] on the holder (no GAP_STORE_ENDPOINT) the arm step is unchanged", () => {
  it("[CONTROL] a red check is judged here and arms in the same tick, with the minted present; max_per_tick 1 still judges one row per tick", async () => {
    const a = T("hold-a");
    const b = T("hold-b");
    await seed(a);
    await seed(b);
    await holderTick(later());
    writeCheck(a, `hold a ${RUN}`, 2);
    writeCheck(b, `hold b ${RUN}`, 2);
    maxPerTick = 1;
    await holderTick(later());
    const states = [ledgerOf(await stored(a))["state"], ledgerOf(await stored(b))["state"]].sort();
    expect(states).toEqual(["armed", "goal_dispatched"]);
    expect(suiteRuns.filter((r) => r.test_file === checkPathOf(a) || r.test_file === checkPathOf(b)).length).toBe(1);
    expect(beforeEval.length).toBe(0); // nothing went through a forward
    const armedId = ledgerOf(await stored(a))["state"] === "armed" ? a : b;
    const waitingId = armedId === a ? b : a;
    expect(metaOf(await stored(armedId))["predicate_birth_verdict"]).toBe("present");
    expect(metaOf(await stored(waitingId))["evidence_resolve"]).toBeUndefined();
  });
});

describe("the forwarding node's arm step hands the check to the gap-store holder", () => {
  it("[MUST-FAIL] a check red at HEAD is measured by the HOLDER and the row arms, held unarmed until the holder's present is read back", async () => {
    const id = T("fwd-red");
    await seed(id);
    await forwardingTick(later()); // dispatch: the test-writing goal
    expect(ledgerOf(await stored(id))["state"]).toBe("goal_dispatched");
    const title = `fwd widget is two ${RUN}`;
    writeCheck(id, title, 2);
    await forwardingTick(later()); // the hand-off; the holder measures it in its own turn
    const afterHandOff = await stored(id);
    await forwardingTick(later()); // the settlement from the holder's stamp
    const armed = await stored(id);
    const m = metaOf(armed);

    // The row arms, from a verdict the holder MEASURED (its run of the check, not this node's).
    expect(ledgerOf(armed)["state"]).toBe("armed");
    expect(m["predicate_birth_verdict"]).toBe("present");
    expect(m["evidence_resolve"]).toEqual({ shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: checkPathOf(id), only_tests: [title] }, zero_field: "requested_not_passing" });
    expect(m["edit_site"]).toBe(SITE);
    expect(m["predicate_source"]).toBe(supply.CHECK_SUPPLY_SOURCE);
    expect(sg.predicateSuspect(m)).toBeNull();
    expect(elig.composeEligibilitySkipReason(armed!)).toBeNull();
    // Two runs, both the holder's: its birth evaluation, and the report the arm gates judge, read through the forward.
    const runs = suiteRuns.filter((r) => r.test_file === checkPathOf(id));
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.on_holder)).toBe(true);
    expect(runs[0]!.body).toMatchObject({ ran: true, requested_not_passing: 1 });
    expect(runs[1]!.body).toMatchObject({ ran: true, requested_not_passing: 1 });

    // (i) NOT ARMED BY THE WRITE ALONE: right after the hand-off write, before the holder ran the check, the row is
    // pending (predicate_suspect) and held; after the holder's present, still held until this node reads it back.
    // Two forwarded writes carried the check: the hand-off, and the settlement, which carries the holder's verdict
    // forward (the same check: no second birth evaluation; the second run above is the report read).
    const pre = beforeEval.filter((s) => s.id === id);
    expect(pre.length).toBe(2);
    expect(pre[0]).toMatchObject({ verdict: "pending", eligibility: "held", state: "goal_dispatched" });
    expect(pre[0]!.suspect).not.toBeNull();
    expect(pre[1]).toMatchObject({ verdict: "present", eligibility: null, suspect: null, state: "armed" });
    expect(metaOf(afterHandOff)["predicate_birth_verdict"]).toBe("present");
    expect(elig.composeEligibilitySkipReason(afterHandOff!)).toBe("held");
    expect(ledgerOf(afterHandOff)["state"]).toBe("goal_dispatched");
  });

  it("[MUST-FAIL] the budget counts HAND-OFFS: with max_per_tick 1, a second landed check is deferred to the next tick, then handed off", async () => {
    const a = T("fwd-budget-a");
    const b = T("fwd-budget-b");
    await seed(a);
    await seed(b);
    await forwardingTick(later()); // both dispatched (max_per_tick 50)
    expect(ledgerOf(await stored(a))["state"]).toBe("goal_dispatched");
    expect(ledgerOf(await stored(b))["state"]).toBe("goal_dispatched");
    writeCheck(a, `fwd budget a ${RUN}`, 2);
    writeCheck(b, `fwd budget b ${RUN}`, 2);
    maxPerTick = 1;
    const handedOff = async (): Promise<string[]> => {
      const out: string[] = [];
      for (const id of [a, b]) if (((metaOf(await stored(id))["evidence_resolve"] ?? {}) as { input?: Row }).input?.["test_file"] === checkPathOf(id)) out.push(id);
      return out;
    };
    await forwardingTick(later());
    const first = await handedOff();
    expect(first.length).toBe(1); // one hand-off this tick: the holder runs one check
    const deferred = first[0] === a ? b : a;
    expect(ledgerOf(await stored(deferred))["state"]).toBe("goal_dispatched"); // deferred, not settled or lost
    expect(suiteRuns.length).toBe(1);
    await forwardingTick(later()); // the first settles (spends nothing); the deferred one is handed off
    expect((await handedOff()).sort()).toEqual([a, b].sort());
    expect(metaOf(await stored(deferred))["predicate_birth_verdict"]).toBe("present");
    expect(ledgerOf(await stored(first[0]!))["state"]).toBe("armed");
    await forwardingTick(later());
    expect(ledgerOf(await stored(a))["state"]).toBe("armed");
    expect(ledgerOf(await stored(b))["state"]).toBe("armed");
  });

  it("[MUST-FAIL] an abstain never spends the budget: a row waiting on the holder's unmeasured check does not block the next hand-off at max_per_tick 1", async () => {
    const w = T("fwd-wait");
    const c = T("fwd-next");
    await seed(w);
    await seed(c);
    await forwardingTick(later()); // both dispatched (max_per_tick 50)
    maxPerTick = 1;
    unmeasurable.add(checkPathOf(w));
    writeCheck(w, `fwd wait ${RUN}`, 2);
    await forwardingTick(soon()); // w handed off; the holder cannot measure it: unknown
    expect(metaOf(await stored(w))["predicate_birth_verdict"]).toBe("unknown");
    writeCheck(c, `fwd next ${RUN}`, 2);
    await forwardingTick(soon()); // w (the newer row, read first) waits and spends nothing; c is handed off
    const mc = metaOf(await stored(c));
    expect(((mc["evidence_resolve"] ?? {}) as { input?: Row }).input?.["test_file"]).toBe(checkPathOf(c));
    expect(mc["predicate_birth_verdict"]).toBe("present");
    const rw = await stored(w);
    expect(ledgerOf(rw)["state"]).toBe("goal_dispatched");
    expect(elig.composeEligibilitySkipReason(rw!)).toBe("held");
    expect(suiteRuns.filter((r) => r.test_file === checkPathOf(w)).length).toBe(1); // handed off once, never re-sent
  });

  it("[CONTROL ii] a check that PASSES at HEAD ends green_at_head through the holder path: not armed, the check taken back off, asked again", async () => {
    const id = T("fwd-green");
    await seed(id);
    await forwardingTick(later());
    const title = `fwd widget is one ${RUN}`;
    writeCheck(id, title, 1);
    await forwardingTick(later()); // hand-off: the holder reads it absent
    const pre = beforeEval.filter((s) => s.id === id);
    expect(pre.length).toBe(1);
    expect(pre[0]).toMatchObject({ verdict: "pending", eligibility: "held" });
    await forwardingTick(later()); // settlement
    const row = await stored(id);
    const led = ledgerOf(row);
    expect(led["state"]).toBe("green_at_head");
    expect(led["judged_titles"]).toEqual([title]);
    expect(metaOf(row)["evidence_resolve"] ?? null).toBeNull();
    expect(elig.composeEligibilitySkipReason(row!)).toBe("unarmed");
    expect(supply.checkSupplyDisposition(row!)).not.toBeNull();
    const runs = suiteRuns.filter((r) => r.test_file === checkPathOf(id));
    expect(runs.length).toBe(1);
    expect(runs[0]!.on_holder).toBe(true);
    expect(runs[0]!.body).toMatchObject({ ran: true, requested_not_passing: 0 });
  });

  it("[CONTROL ii'] a handed-off green check that the HOLDER's own tick settles first is taken off the row too: not stranded held", async () => {
    const id = T("fwd-green-holder");
    await seed(id);
    await forwardingTick(later());
    writeCheck(id, `fwd green settled by holder ${RUN}`, 1);
    await forwardingTick(later()); // hand-off: the holder reads it absent
    expect(metaOf(await stored(id))["predicate_birth_verdict"]).toBe("absent");
    await holderTick(later()); // the holder's own supply tick reaches the row before the forwarding node does
    const row = await stored(id);
    expect(ledgerOf(row)["state"]).toBe("green_at_head");
    expect(metaOf(row)["evidence_resolve"] ?? null).toBeNull();
    expect(supply.checkSupplyDisposition(row!)).not.toBeNull();
  });
});
