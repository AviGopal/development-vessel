// THE ARM STEP REFUSES A CHECK WHOSE CALLS NEVER REACH THE GAP'S REGION (2026-10-24).
//
// goal-host 6c6d632's check-supply check calls dispatchFailureReasons and asserts toContain("the command produced no
// result"). The gap's region (`if (r == null) return "the command produced no result";`) is in runGoalAsPoolWalkBody,
// which dispatchFailureReasons never reaches, so the check's red is its fixture's: dispatchFailureReasons cannot parse
// the walk-log objects it is given. It armed: the mutation gate mutates the declarations the check names
// (dispatchFailureReasons itself), and a mutant moving that red counted as "the check tests the site". The arm step now
// refuses it statically, before the run (gap-check-supply.ts checkMissesRegionRefusal: check_call_misses_region), when
// neither the declarations the check names nor the same-file declarations they reach contain the gap's region. A check
// whose call reaches the region arms as before.
//
// END TO END, as gap-check-supply-contract-mismatch.test.ts (the harness is the same): the birth judge's test_suite
// self-resolve is answered by the REAL resolveTestSuite, which runs bun on the temp clone. The clone's src/index.ts is the
// extract of goal-host src/index.ts at 6c6d632's parent (test/fixtures/check-asserts-defect-output), and the check is
// 6c6d632's, verbatim.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-region-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
const FIX = join(import.meta.dir, "..", "fixtures", "check-asserts-defect-output");
const fixture = (name: string): string => readFileSync(join(FIX, name), "utf8");
const SITE_REL = "src/index.ts";
const SITE = `repos/${VESSEL}/${SITE_REL}`;
const REGION = "if (r == null) return \"the command produced no result\";";
const TREE: Record<string, string> = { [SITE_REL]: fixture("goal-host-index.extract-9fe59e85.ts.txt") };
// The row's control: the fixed behaviour (a refusal reported as a refusal), through an export that reaches the region.
const CHECK_REACHES = `import { test, expect } from "bun:test";\nimport * as mod from "../../src/index";\n\ntest("a containment-refused shell write is reported as a refusal", async () => {\n  expect(await mod.runGoalAs(null)).toContain("refused by containment");\n});\n`;

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let lastShellOutput = "";
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
const dueRhythm = (): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(), body: { axis: "load", family: "gap-check-supply", require_control: false, budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 50, backoff_hours: 24, max_attempts: 5 } });

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
  const summary = `fixture ${id}: ${SITE} \`runGoalAs\` reports a containment-refused shell write to the walk as 'the command produced no result'`;
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: { edit_site: SITE, region: REGION } } } as never);
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
  await tick(later());
  return (await storeRow(id))!;
}

describe("the arm step refuses a check whose calls never reach the gap's region", () => {
  it("[MUST-FAIL] 6c6d632's check (verbatim) is NOT armed: check_call_misses_region", async () => {
    const row = await landAndArm("rg-6c6d632", fixture("6c6d632-containment-refused.check.ts.txt"));
    expect(metaOf(row)["evidence_resolve"]).toBeUndefined();
    expect(ledgerOf(row)["state"]).toBe("arm_refused");
    expect(String(ledgerOf(row)["reason"])).toContain("check_call_misses_region");
    expect(String(ledgerOf(row)["reason"])).toContain("dispatchFailureReasons");
    expect(String(ledgerOf(row)["reason"])).toContain("in runGoalAsPoolWalkBody");
  });

  it("[CONTROL] a check whose called export reaches the region arms normally", async () => {
    const row = await landAndArm("rg-reaches", CHECK_REACHES);
    expect(ledgerOf(row)["state"]).toBe("armed");
    expect(metaOf(row)["edit_site"]).toBe(SITE);
    expect(metaOf(row)["predicate_birth_verdict"]).toBe("present");
  });

  it("[CONTROL] the refusal is static: no region on the site, nothing decided", () => {
    const refusal = supply["checkMissesRegionRefusal"] as undefined | ((siteSrc: string, siteRel: string, checkSrc: string, region: string) => { reason: string } | null);
    expect(typeof refusal).toBe("function");
    const check = fixture("6c6d632-containment-refused.check.ts.txt");
    expect(refusal!(TREE[SITE_REL]!, SITE_REL, check, REGION)?.reason).toContain("check_call_misses_region");
    expect(refusal!(TREE[SITE_REL]!, SITE_REL, check, "")).toBeNull();
    expect(refusal!(TREE[SITE_REL]!, SITE_REL, check, "seen.has(")).toBeNull();
    expect(refusal!(TREE[SITE_REL]!, SITE_REL, CHECK_REACHES, REGION)).toBeNull();
  });
});
