// THE ARM NAMES THE NODE THAT WROTE IT, AND THE NODE THAT HANDED ITS CHECK TO THE GAP-STORE HOLDER.
//
// A node that forwards its gap store hands a landed check to the holder for its birth verdict, and arms from the
// holder's stamp on a later tick (gap-check-supply-forwarding-arm.test.ts). Its arm ledger was the same as the holder's
// own: no node, no hand-off, so a forwarding node's arm could not be attributed. The arm now records armed_by_node (the
// tick's bootstrap identity, checkSupplyNode) and, for an arm that came through the hand-off, handed_off_from (the node
// that handed the check off, stamped by the hand-off write).
//
// The two nodes are one process, as in the forwarding-arm test; each turn runs under its own node name.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-armattr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const HOLDER = "http://holder.test/v2/impulses/resolve";
const ENV_KEYS = ["SUBSTRATE_NAME", "WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT", "SELF_RESOLVE_ENDPOINT"] as const;
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
const HOLDER_NODE = `holder-node-${Math.random().toString(36).slice(2, 8)}`;
const FORWARDING_NODE = `forwarding-node-${Math.random().toString(36).slice(2, 8)}`;
async function asHolder<T>(fn: () => Promise<T>): Promise<T> {
  const was = process.env["GAP_STORE_ENDPOINT"];
  const wasNode = process.env["SUBSTRATE_NAME"];
  delete process.env["GAP_STORE_ENDPOINT"];
  process.env["SUBSTRATE_NAME"] = HOLDER_NODE;
  try { return await fn(); } finally {
    if (was === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = was;
    if (wasNode === undefined) delete process.env["SUBSTRATE_NAME"]; else process.env["SUBSTRATE_NAME"] = wasNode;
  }
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
async function forwardingTick(now: number, node: string = FORWARDING_NODE): Promise<Row> {
  process.env["GAP_STORE_ENDPOINT"] = HOLDER;
  process.env["SUBSTRATE_NAME"] = node;
  try {
    const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
    return r.body as Row;
  } finally { delete process.env["GAP_STORE_ENDPOINT"]; delete process.env["SUBSTRATE_NAME"]; }
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
describe("[CONTROL] a check judged where the store is held arms with its node and no hand-off", () => {
  it("[CONTROL] a local arm records armed_by_node (the holder's own name) and no handed_off_from", async () => {
    const id = T("attr-local");
    await seed(id);
    await holderTick(later()); // dispatch
    writeCheck(id, `attr local ${RUN}`, 2);
    await holderTick(later()); // judged here, armed in the same tick
    const led = ledgerOf(await stored(id));
    expect(led["state"]).toBe("armed");
    expect(led["armed_by_node"]).toBe(HOLDER_NODE);
    expect(led["handed_off_from"]).toBeUndefined();
  });
});

describe("a forwarding node's arm is attributed to it and to its hand-off", () => {
  it("[MUST-FAIL] an arm from the holder's verdict records armed_by_node and handed_off_from, both the forwarding node", async () => {
    const id = T("attr-fwd");
    await seed(id);
    await forwardingTick(later()); // dispatch
    writeCheck(id, `attr forwarded ${RUN}`, 2);
    await forwardingTick(later()); // the hand-off; the holder measures it
    await forwardingTick(later()); // the settlement from the holder's stamp
    const row = await stored(id);
    const led = ledgerOf(row);
    expect(led["state"]).toBe("armed");
    expect(metaOf(row)["predicate_birth_verdict"]).toBe("present");
    expect(led["armed_by_node"]).toBe(FORWARDING_NODE);
    expect(led["handed_off_from"]).toBe(FORWARDING_NODE);
    expect(suiteRuns.filter((r) => r.test_file === checkPathOf(id)).every((r) => r.on_holder)).toBe(true);
  });

  it("[MUST-FAIL] a handed-off check the HOLDER's own tick arms names the holder as arming node and the forwarding node as the hand-off", async () => {
    const id = T("attr-fwd-holder");
    await seed(id);
    await forwardingTick(later()); // dispatch
    writeCheck(id, `attr handed off, armed by holder ${RUN}`, 2);
    await forwardingTick(later()); // the hand-off; the holder measures it
    await holderTick(later()); // the holder's own tick reaches the row first
    const led = ledgerOf(await stored(id));
    expect(led["state"]).toBe("armed");
    expect(led["armed_by_node"]).toBe(HOLDER_NODE);
    expect(led["handed_off_from"]).toBe(FORWARDING_NODE);
  });
});

describe("the arm entry is a copy taken at arm time", () => {
  it("[MUST-FAIL] hand-off by A, armed on B, then a re-attempt handed off by C: the arm entry still says A and B", async () => {
    const A = FORWARDING_NODE;
    const C = `third-node-${RUN}`;
    const id = T("attr-copy");
    await seed(id);
    await forwardingTick(later(), A); // dispatch
    const first = `attr copy first ${RUN}`;
    writeCheck(id, first, 2);
    await forwardingTick(later(), A); // A hands the check off; the holder measures it
    await holderTick(later()); // B (the holder) arms it
    const armedRow = await stored(id);
    expect(ledgerOf(armedRow)["state"]).toBe("armed");
    expect(ledgerOf(armedRow)["handed_off_from"]).toBe(A);
    // A re-attempt: the row goes back to a dispatched goal and its check gains a title, so a new check is handed off.
    const reopened = structuredClone(armedRow!);
    const meta = metaOf(reopened);
    meta["check_supply"] = { ...ledgerOf(reopened), state: "goal_dispatched" };
    reopened["classification_metadata"] = meta;
    const w = await asHolder(() => sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: reopened } as never));
    expect(w.shape).not.toBe("structuredError");
    await asHolder(() => sg.__settleBirthEvaluationsForTests());
    writeFileSync(join(CLONES, VESSEL, checkPathOf(id)), `${H}import * as mod from "../../src/widget";\ntest("${first}", () => { expect(mod.widget).toBe(2); });\ntest("attr copy second ${RUN}", () => { expect(mod.widget).toBe(2); });\n`);
    await forwardingTick(later(), C); // C hands the new check off: the row's handed_off_from is now C's
    const led = ledgerOf(await stored(id));
    expect(led["handed_off_from"]).toBe(C);
    expect(led["arm"]).toMatchObject({ armed_by_node: HOLDER_NODE, handed_off_from: A });
  });
});

/** A re-attempt: the row back at a dispatched goal, its check grown to `n` titles (so a new check is judged). */
async function reattempt(id: string, n: number): Promise<void> {
  const row = structuredClone((await stored(id))!);
  const meta = metaOf(row);
  meta["check_supply"] = { ...ledgerOf(row), state: "goal_dispatched" };
  row["classification_metadata"] = meta;
  const w = await asHolder(() => sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: row } as never));
  expect(w.shape).not.toBe("structuredError");
  await asHolder(() => sg.__settleBirthEvaluationsForTests());
  const tests = Array.from({ length: n }, (_, i) => `test("attr rearm ${i} ${RUN}", () => { expect(mod.widget).toBe(2); });`).join("\n");
  writeFileSync(join(CLONES, VESSEL, checkPathOf(id)), `${H}import * as mod from "../../src/widget";\n${tests}\n`);
}
const armsOf = async (id: string): Promise<Row[]> => ((ledgerOf(await stored(id))["arms"] ?? []) as Row[]);

describe("every arm keeps its own entry: a re-arm adds one, bounded", () => {
  it("[MUST-FAIL] armed on B from A's hand-off, re-attempted, armed on C: both arm entries are readable with their own attribution", async () => {
    const A = FORWARDING_NODE;
    const C = `rearm-node-${RUN}`;
    const id = T("attr-rearm");
    await seed(id);
    await forwardingTick(later(), A); // dispatch
    writeCheck(id, `attr rearm first ${RUN}`, 2);
    await forwardingTick(later(), A); // A hands the check off
    await holderTick(later()); // B (the holder) arms it
    expect(ledgerOf(await stored(id))["state"]).toBe("armed");
    await reattempt(id, 2);
    await forwardingTick(later(), C); // C hands the new check off
    await forwardingTick(later(), C); // and arms it from the holder's verdict
    const led = ledgerOf(await stored(id));
    expect(led["state"]).toBe("armed");
    const arms = (led["arms"] ?? []) as Row[];
    expect(arms.length).toBe(2);
    expect(arms[0]).toMatchObject({ armed_by_node: HOLDER_NODE, handed_off_from: A });
    expect(arms[1]).toMatchObject({ armed_by_node: C, handed_off_from: C });
    expect(led["arm"]).toEqual(arms[1]); // the latest
  });

  it("[CONTROL] a single local arm has one entry", async () => {
    const id = T("attr-one");
    await seed(id);
    await holderTick(later());
    writeCheck(id, `attr one ${RUN}`, 2);
    await holderTick(later());
    const arms = await armsOf(id);
    expect(arms.length).toBe(1);
    expect(arms[0]!["armed_by_node"]).toBe(HOLDER_NODE);
    expect(arms[0]!["handed_off_from"]).toBeUndefined();
  });

  it("[CONTROL] the bound: six arms keep the last five, the oldest dropped", async () => {
    const id = T("attr-bound");
    await seed(id);
    await holderTick(later());
    writeCheck(id, `attr bound ${RUN}`, 2);
    await holderTick(later()); // arm 1
    const seen: Row[] = [(await armsOf(id)).at(-1)!];
    for (let n = 2; n <= 6; n++) {
      await reattempt(id, n);
      await holderTick(later()); // arm n, judged and armed here
      expect(ledgerOf(await stored(id))["state"]).toBe("armed");
      seen.push((await armsOf(id)).at(-1)!);
    }
    const arms = await armsOf(id);
    expect(new Set(seen.map((e) => e["armed_at"])).size).toBe(6);
    expect(arms.length).toBe(5);
    expect(arms).toEqual(seen.slice(1));
  });
});

