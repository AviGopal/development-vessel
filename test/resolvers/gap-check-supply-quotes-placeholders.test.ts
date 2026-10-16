// THE CHECK GOAL QUOTES THE PLACEHOLDERS IT COPIES (CHANGE-32a).
//
// A check goal is built from the gap's own prose (symptomOf(summary)). A gap ABOUT placeholders quotes them, and two
// pre-gate rows hold them unquoted: "{{…}}" (outbound-requests-are-sent-with-placeholder-credentials…) and "{{goal.*}}" /
// "{{goal.id}}" (author-producer-live-validates-store-mutating-write-shapes). The gap-store write gate reads an unquoted
// {{…}} as an unrendered template and refused EVERY ledger write that carried the goal (58x and 39x in 24 h on compose2),
// so the supply could never record what it had sent. The gate's own quotation is backticks; the goal now wraps exactly
// what the gate flags (quoteUnrenderedTokens, built on the gate's unrenderedBindingToken).
//
//   [MUST-FAIL] the goal built from each real stored summary carries no token the gate flags; the placeholders are quoted.
//   [MUST-FAIL] a pre-gate row quoting {{goal.*}}: an accepted send records the FULL ledger, goal text included.
//   [CONTROL]   a genuinely unrendered binding in check_supply.goal, written directly, is still refused by the gate.
//   [CONTROL]   a goal with no token is unchanged; an already-quoted token is not wrapped again.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";

const ROOT = join(tmpdir(), `gcs-quote-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const supply = await import("../../src/resolvers/gap-check-supply.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "local-tools-vessel";

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let goals: Array<{ goal: string; variables?: Record<string, unknown> }> = [];
let rhythms: Row[] = [];
/** goal-host's dispatch records, by dispatch id: what GET /executions/:id answers. Absent ⇒ 404. */
let executions: Record<string, { status: string; reached: boolean | null; outcome?: Record<string, unknown> }> = {};
/** What /run-goal answers: null => 202 with a dispatch id; else this status and body. */
let runGoalAnswer: { status: number; body: Record<string, unknown> } | null = null;
/** The live autonomyScope record's excluded paths (null ⇒ no record). */
let excluded: string[] | null = null;
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;

const dueRhythm = (extra: Row = {}): Row => ({
  id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(),
  body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 10, backoff_hours: 24, max_attempts: 3, ...extra },
});

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const d of [join(CLONES, VESSEL, "src"), join(CLONES, VESSEL, "test"), join(RUNTIME, VESSEL, "src")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(CLONES, VESSEL, "src", "widget.ts"), "export const widget = 1;\n");
  writeFileSync(join(RUNTIME, VESSEL, "src", "widget.ts"), "export const widget = 1;\n");
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const exec = url.match(/\/executions\/([^/?#]+)$/);
    if (exec) {
      const rec = executions[decodeURIComponent(exec[1]!)];
      return rec ? Response.json({ dispatchId: exec[1], ...rec }) : new Response("not found", { status: 404 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) {
      goals.push({ goal: String(body.goal ?? ""), variables: body.variables });
      if (runGoalAnswer) return Response.json(runGoalAnswer.body, { status: runGoalAnswer.status });
      return Response.json({ dispatchId: `d-${RUN}-${goals.length}` }, { status: 202 });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: rhythms, count: rhythms.length } });
    if (imp?.type === "poolImpulse" && imp?.shape === "autonomyScope") {
      const rows = excluded === null ? [] : [{ id: "autonomy-scope", shape: "autonomyScope", body: { excluded_paths: excluded, require_falsifier_classes: ["class2"] } }];
      return Response.json({ body: { impulses: rows, count: rows.length } });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write") return Response.json({ body: { ok: true } });
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "present");
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
  goals = []; executions = {}; runGoalAnswer = null; excluded = ["repos/some-other-vessel/"]; rhythms = [dueRhythm()];
  execGuard = installCutoverExecGuard();
  g2fPolicy.__resetPolicyReadsForTests();
});
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const ledgerOf = (r: Row | undefined): Row => ((((r?.["classification_metadata"] ?? {}) as Row)["check_supply"] ?? {}) as Row);
async function seed(id: string, what: string): Promise<void> {
  const summary = `${what} fixture ${RUN}: local-tools-vessel src/widget.ts \`widget\` returns the wrong value`;
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: {} } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function tick(now: number): Promise<Row> {
  const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
  await sg.__settleBirthEvaluationsForTests();
  return r.body as Row;
}
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
const goalsFor = (id: string) => goals.filter((g) => g.variables?.["gap_id"] === id);

const MIN = 60_000;
async function seedRaw(id: string, summary: string): Promise<void> {
  // A row as the LIVE store holds a pre-gate one (written before 2026-10-03's binding gate): straight into the
  // scratch store, the way another process's writer replaces it (tmp + rename), keeping every row already there.
  const { readFileSync, renameSync } = await import("node:fs");
  const file = join(sg.gapStoreRootForTest(), "gaps", "gaps.json");
  if (!sg.isScratchGapStoreRoot(sg.gapStoreRootForTest())) throw new Error("not a scratch store");
  let rows: Row[] = [];
  try { rows = JSON.parse(readFileSync(file, "utf8")) as Row[]; } catch { rows = []; }
  rows.push({ id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: { edit_site: `repos/${VESSEL}/src/widget.ts`, disposition: "needs_localization" } });
  writeFileSync(`${file}.seed.tmp`, JSON.stringify(rows, null, 2));
  renameSync(`${file}.seed.tmp`, file);
}


const SUMMARY_CRED = "Outbound HTTP requests are sent carrying obvious placeholder credentials. Nothing refuses a request whose URL, query, header or body carries a placeholder secret (YOUR_API_KEY, <API_KEY>, xxx, {{…}}, [Insert …]) before it is sent.";
const SUMMARY_AUTHOR = "author_producer validates an LLM-authored task_config by calling the REAL resolver, with {{goal.*}} placeholders left literal; three {{goal.id}} rows written in walk ba1f2760.";
async function seedRaw(id: string, summary: string): Promise<void> {
  const { readFileSync, renameSync } = await import("node:fs");
  const file = join(sg.gapStoreRootForTest(), "gaps", "gaps.json");
  if (!sg.isScratchGapStoreRoot(sg.gapStoreRootForTest())) throw new Error("not a scratch store");
  let rows: Row[] = [];
  try { rows = JSON.parse(readFileSync(file, "utf8")) as Row[]; } catch { rows = []; }
  rows.push({ id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: { edit_site: `repos/${VESSEL}/src/widget.ts`, disposition: "needs_localization" } });
  writeFileSync(`${file}.seed.tmp`, JSON.stringify(rows, null, 2));
  renameSync(`${file}.seed.tmp`, file);
}

describe("check-supply: the goal quotes the placeholders it copies", () => {
  it("[MUST-FAIL] the goal built from each real stored summary carries no token the gate flags", () => {
    for (const summary of [SUMMARY_CRED, SUMMARY_AUTHOR]) {
      const goal = supply.checkSupplyGoal(VESSEL, "test/checks/x.check.test.ts", summary, `repos/${VESSEL}/src/widget.ts`);
      expect(sg.unrenderedBindingToken(goal)).toBeNull();
    }
    expect(supply.checkSupplyGoal(VESSEL, "test/checks/x.check.test.ts", SUMMARY_CRED)).toContain("`{{…}}`");
    expect(supply.checkSupplyGoal(VESSEL, "test/checks/x.check.test.ts", SUMMARY_AUTHOR)).toContain("`{{goal.*}}`");
  });

  it("[MUST-FAIL] a pre-gate row quoting {{goal.*}}: an accepted send records the full ledger, goal included, and is not re-sent", async () => {
    const id = T("gcs-quote");
    await seedRaw(id, `${SUMMARY_AUTHOR} fixture ${RUN}: local-tools-vessel src/widget.ts \`widget\``);
    const t0 = Date.now();
    await tick(t0);
    expect(goalsFor(id).length).toBe(1);
    const l = ledgerOf(await storeRow(id));
    expect(l["state"]).toBe("goal_dispatched");
    expect(String(l["dispatch_id"] ?? "")).toMatch(/^d-/);
    expect(String(l["goal"] ?? "")).toContain("`{{goal.*}}`");
    await tick(t0 + 60_000);
    expect(goalsFor(id).length).toBe(1);
  });

  it("[CONTROL] a genuinely unrendered binding written directly in check_supply.goal is still refused", async () => {
    const id = T("gcs-unbound");
    await seed(id, "unbound slot");
    const row = await storeRow(id);
    const meta = { ...((row?.["classification_metadata"] ?? {}) as Row), check_supply: { state: "goal_dispatched", goal: "Write a test for {{goal.id}}" } };
    const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...row, classification_metadata: meta } } as never);
    expect(w.shape).toBe("structuredError");
    expect(JSON.stringify(w.body)).toContain("{{goal.id}}");
  });

  it("[CONTROL] a goal with no token is unchanged; an already-quoted token is not wrapped again", () => {
    const q = supply.quoteUnrenderedTokens as (s: string) => string;
    expect(q("plain goal text, no tokens")).toBe("plain goal text, no tokens");
    expect(q("already `{{goal.id}}` quoted")).toBe("already `{{goal.id}}` quoted");
    expect(q("two {{a.b}} and {{a.b}}")).toBe("two `{{a.b}}` and `{{a.b}}`");
  });
});
