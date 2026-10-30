// A SETTLED ARM JUDGEMENT IS TAKEN AGAIN WHEN WHAT IT READ HAS CHANGED (gap an-arm-refused-row-is-never-re-judged-after-
// the-cause-of-the-refusal-is-corrected-so-it-waits-the-full-backoff-and-re-drafts).
//
// arm_refused, existence_only and green_at_head are settled (JUDGED_NOT_ARMED): the arm loop read only in-flight rows, so
// a row refused for its region (region_not_literal_once on the arm write) stayed refused after the region was corrected,
// waited out backoff_hours, and was then sent a new test-writing goal whose baseline subtracted the landed, correct check.
// The arm step now records what each settled judgement read besides its titles (judged_inputs: the row's region and
// edit_site, the landed check's sha256); a settled row whose inputs differ, or whose landed check declares a title it never
// judged, is judged again on the next tick from the EXISTING landed check, through the arm path, against its own baseline.
//
//   [MUST-FAIL] arm_refused(region_not_literal_once) -> the region corrected to a literal-once line -> armed on the next
//               tick from the landed check, no new dispatch. Red BY ASSERTION at the parent with no new seam (state).
//   [MUST-FAIL] arm_refused(region_red_unchanged), its inputs recorded -> the region set to null -> re-judged and armed.
//   [MUST-FAIL] a changed landed check (another blob than the one judged) re-judges a settled arm_refused.
//   [CONTROL]   an arm_refused whose titles and inputs are all unchanged stays settled inside the backoff.
//   [CONTROL]   a genuine green_at_head (judged by the arm step, nothing changed since) stays settled.
// End to end on the harness of gap-check-supply-no-control.test.ts: the birth judge's test_suite is the REAL resolveTestSuite.
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { landCheck } from "./landed-check.fixture.js";

const ROOT = join(tmpdir(), `gcs-rejudge-in-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
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
const supply = await import("../../src/resolvers/gap-check-supply.js") as Record<string, unknown> & typeof import("../../src/resolvers/gap-check-supply.js");
const csa = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
const { resolveTestSuite } = await import("../../src/resolvers/test-suite.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "fixture-vessel";
const SITE_REL = "src/widget.ts";
const SITE = `repos/${VESSEL}/${SITE_REL}`;
// The defect: add subtracts. add(2, 1) must be 3; add(5, 0) is 5 either way (the control's input, untouched by it).
const TREE: Record<string, string> = { [SITE_REL]: "export function add(a: number, b: number): number {\n  return a - b;\n}\n" };
const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let lastShellOutput = "";
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
const dueRhythm = (): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(), body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 50, backoff_hours: 24, max_attempts: 5 } });

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const base of [join(CLONES, VESSEL), join(RUNTIME, VESSEL)]) {
    for (const d of ["test/checks", "node_modules"]) mkdirSync(join(base, d), { recursive: true });
    for (const [rel, text] of Object.entries(TREE)) { mkdirSync(join(base, rel, ".."), { recursive: true }); writeFileSync(join(base, rel), text); }
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) return Response.json({ dispatchId: `d-${RUN}-${Math.random().toString(36).slice(2, 8)}` }, { status: 202 });
    if (url === "http://self.test/v2/impulses/resolve" && imp?.pointer?.type === "test_suite") {
      const r = await resolveTestSuite(imp.pointer);
      return Response.json({ shape: r.shape, body: r.body });
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
beforeEach(() => { execGuard = installCutoverExecGuard(); g2fPolicy.__resetPolicyReadsForTests(); });
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);
const ledgerOf = (r: Row | undefined): Row => ((metaOf(r)["check_supply"] ?? {}) as Row);
async function seed(id: string): Promise<void> {
  const summary = `fixture ${id}: ${SITE} \`add\` returns 1 for add(2, 1) where 3 is required`;
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: {} } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function tick(now: number): Promise<void> {
  await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
  await sg.__settleBirthEvaluationsForTests();
}
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
const checkPathOf = (id: string): string => `test/checks/${(csa["checkSupplyCheckFile"] as (x: string) => string)(id)}`;
let clock = Date.now() + 5000 * 3600_000;
const later = (): number => (clock += 30 * 3600_000);
/** Seed a gap, let the supply dispatch for it, land `check` as its check file, and let the arm step judge it. */
async function landAndArm(prefix: string, check: string): Promise<Row> {
  const id = T(prefix);
  await seed(id);
  await tick(later());
  expect(ledgerOf(await storeRow(id))).toMatchObject({ state: "goal_dispatched", test_file: checkPathOf(id), edit_site: SITE });
  writeFileSync(join(CLONES, VESSEL, checkPathOf(id)), check);
  landCheck(join(CLONES, VESSEL), checkPathOf(id));
  await tick(later());
  return (await storeRow(id))!;
}

const RED_TITLE = "add(2, 1) is 3";
const GREEN_TITLE = "add(5, 0) stays 5 (control)";
const RED = `  test("${RED_TITLE}", () => { expect(mod.add(2, 1)).toBe(3); });\n`;
const GREEN = `  test("${GREEN_TITLE}", () => { expect(mod.add(5, 0)).toBe(5); });\n`;
const checkOf = (...tests: string[]): string => `import { describe, expect, test } from "bun:test";\nimport * as mod from "../../src/widget";\ndescribe("add", () => {\n${tests.join("")}});\n`;
/** Inside the 24 h backoff and past the 600 s bookkeeping floor. */
const soon = (): number => (clock += 11 * 60_000);
/** Write the row's check_supply ledger as an earlier arm step left it. */
async function setLedger(id: string, patch: Row): Promise<void> {
  const row = (await storeRow(id))!;
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: row["category"], source: row["source"], summary: row["summary"], detected_at: row["detected_at"], status: "open", classification_metadata: { check_supply: { ...ledgerOf(row), ...patch } } } } as never);
  if (w.shape === "structuredError") throw new Error("ledger write refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
/** Seed a gap, let the supply dispatch for it, and land `check` as its check file (not yet judged). */
async function dispatchAndLand(prefix: string, check: string): Promise<string> {
  const id = T(prefix);
  await seed(id);
  await tick(later());
  expect(ledgerOf(await storeRow(id))).toMatchObject({ state: "goal_dispatched", test_file: checkPathOf(id) });
  writeFileSync(join(CLONES, VESSEL, checkPathOf(id)), check);
  landCheck(join(CLONES, VESSEL), checkPathOf(id));
  return id;
}
/** What the next attempt's goal is told, read from the ledger as the dispatch step reads it: a test-side copy of the
 *  private settledHistory (history, plus the current state when it is a judged-not-armed one), into priorAttemptSentence. */
function nextAttemptSentence(l: Row): string {
  const prior = Array.isArray(l["history"]) ? (l["history"] as Row[]).slice(-4) : [];
  const judged = supply.JUDGED_NOT_ARMED.has(String(l["state"] ?? "")) ? [{ attempt: Number(l["attempts"] ?? 0), state: l["state"], reason: l["reason"] ?? "", titles: Array.isArray(l["judged_titles"]) ? l["judged_titles"] : [] }] : [];
  return supply.priorAttemptSentence([...prior, ...judged]);
}
const PROSE_REGION = "the line where add combines its two inputs";
const LITERAL_REGION = "return a - b;";
/** Write row metadata fields (not the ledger) as an operator correction would. */
async function setMeta(id: string, patch: Row): Promise<void> {
  const row = (await storeRow(id))!;
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: row["category"], source: row["source"], summary: row["summary"], detected_at: row["detected_at"], status: "open", classification_metadata: patch } } as never);
  if (w.shape === "structuredError") throw new Error("meta write refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
/** The inputs the arm step records for a judgement, computed test-side from the row as stored and the landed check. */
function inputsOf(row: Row | undefined, check: string): Row {
  const m = metaOf(row);
  const r = m["region"];
  return { region: r === undefined || r === null ? "" : String(r).trim(), edit_site: String(m["edit_site"] ?? "").trim(), check_sha256: createHash("sha256").update(check).digest("hex") };
}
const PAIR = checkOf(RED, GREEN);

describe("a settled row is judged again when its inputs changed", () => {
  it("[MUST-FAIL] arm_refused(region_not_literal_once), region corrected to a literal: armed next tick from the landed check", async () => {
    const id = await dispatchAndLand("rji-region", PAIR);
    await setMeta(id, { region: PROSE_REGION });
    await tick(soon());
    const refusedRow = await storeRow(id);
    expect(ledgerOf(refusedRow)["state"]).toBe("arm_refused");
    expect(String(ledgerOf(refusedRow)["reason"])).toContain("region_not_literal_once");
    const attempts = ledgerOf(refusedRow)["attempts"];
    await setMeta(id, { region: LITERAL_REGION });
    await tick(soon());
    const row = await storeRow(id);
    expect(ledgerOf(row)["state"]).toBe("armed");
    expect(ledgerOf(row)["attempts"]).toBe(attempts); // the landed check, judged again: no new goal
    expect(((metaOf(row)["evidence_resolve"] as Row | undefined)?.["input"] as Row | undefined)?.["only_tests"]).toEqual([RED_TITLE, GREEN_TITLE]);
    expect(ledgerOf(row)["reason"]).toBe("");
  });

  it("[MUST-FAIL] arm_refused(region_red_unchanged), the region set to null after the judgement: re-judged and armed", async () => {
    const id = await dispatchAndLand("rji-null", PAIR);
    await setMeta(id, { region: LITERAL_REGION });
    const judgedOn = await storeRow(id);
    await setLedger(id, { state: "arm_refused", judged_titles: [RED_TITLE, GREEN_TITLE], judged_inputs: inputsOf(judgedOn, PAIR), reason: "region_red_unchanged: the check's red survives replacing the gap's region" });
    await setMeta(id, { region: null });
    await tick(soon());
    expect(ledgerOf(await storeRow(id))["state"]).toBe("armed");
  });

  it("[MUST-FAIL] a landed check that changed since the judgement re-judges a settled arm_refused", async () => {
    const id = await dispatchAndLand("rji-blob", checkOf(GREEN));
    const judgedOn = await storeRow(id);
    await setLedger(id, { state: "arm_refused", judged_titles: [GREEN_TITLE], judged_inputs: inputsOf(judgedOn, checkOf(GREEN)), reason: "check_no_control: an earlier judgement" });
    writeFileSync(join(CLONES, VESSEL, checkPathOf(id)), checkOf(GREEN).replace("add(5, 0)).toBe(5)", "add(7, 0)).toBe(7)"));
    landCheck(join(CLONES, VESSEL), checkPathOf(id));
    await tick(soon());
    const l = ledgerOf(await storeRow(id));
    expect(l["state"]).toBe("green_at_head"); // judged again, on the new blob: its one test passes at HEAD
    expect(l["judged_inputs"]).toEqual(inputsOf(await storeRow(id), checkOf(GREEN).replace("add(5, 0)).toBe(5)", "add(7, 0)).toBe(7)")));
  });
});

describe("settled rows whose inputs did not change", () => {
  it("[CONTROL] an arm_refused whose titles and inputs are all unchanged stays settled inside the backoff", async () => {
    const id = await dispatchAndLand("rji-same", PAIR);
    await setLedger(id, { state: "arm_refused", judged_titles: [RED_TITLE, GREEN_TITLE], judged_inputs: inputsOf(await storeRow(id), PAIR), reason: "arm_refused: an earlier judgement" });
    const before = ledgerOf(await storeRow(id));
    await tick(soon());
    expect(ledgerOf(await storeRow(id))).toEqual(before);
  });

  it("[CONTROL] a genuine green_at_head, judged by the arm step and unchanged since, stays settled", async () => {
    const id = await dispatchAndLand("rji-green", checkOf(GREEN));
    await tick(soon());
    const before = ledgerOf(await storeRow(id));
    expect(before).toMatchObject({ state: "green_at_head", judged_titles: [GREEN_TITLE] });
    await tick(soon());
    expect(ledgerOf(await storeRow(id))).toEqual(before);
  });
});
