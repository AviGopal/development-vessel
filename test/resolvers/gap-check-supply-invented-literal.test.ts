// THE ARM STEP REFUSES A CHECK THAT EXPECTS AN INVENTED LITERAL (qa ruling, 2026-10-24). development-vessel 85ca4d09's
// check (the-gap-store-merge-migration-on-a-forwarding-node-is-refuse) expects runGapStoreMergeMigration to return
// { status: "skipped", reason: "local_copy_on_forwarding_node_is_stale_and_must_be_retired" }: a reason in neither the
// edit site nor the gap's text, so its red is the invented value's. Refused statically at arm,
// check_expects_invented_literal. The hand-written 5e69d7a0 check (its arm_refused is in its gap's text) and every
// replayed check stay allowed. End to end on the 5e69d7a0 pair's harness (this vessel's own src/ as the fixture clone):
// the refusal is static, so no run of the check is needed to reach it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-invented-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
const supply = await import("../../src/resolvers/gap-check-supply.js");
const csa = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
const { resolveTestSuite } = await import("../../src/resolvers/test-suite.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const REPO = join(import.meta.dir, "..", "..");
const FIX = join(import.meta.dir, "..", "fixtures", "check-asserts-defect-output");
const fixture = (name: string): string => readFileSync(join(FIX, name), "utf8");
const VESSEL = "fixture-dv";
const SITE = `repos/${VESSEL}/src/resolvers/gap-store-merge-migration.ts`;
const ROW = JSON.parse(fixture("85ca4d09-row-evidence.json")) as { summary: string; must_fail: string; control: string; falsifier_spec: string };

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
const dueRhythm = (): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(), body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 50, backoff_hours: 24, max_attempts: 5, mutants_per_file: 6 } });
const clone = join(CLONES, VESSEL);
const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: clone, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  mkdirSync(join(clone, "test/checks"), { recursive: true });
  mkdirSync(join(clone, "test/resolvers"), { recursive: true });
  cpSync(join(REPO, "src"), join(clone, "src"), { recursive: true });
  for (const f of ["package.json", "tsconfig.json"]) cpSync(join(REPO, f), join(clone, f));
  cpSync(join(REPO, "test/resolvers/isolated-gap-store-run.ts"), join(clone, "test/resolvers/isolated-gap-store-run.ts"));
  writeFileSync(join(clone, "test/checks/mg-log-env.ts"), fixture("5e69d7a0-correct-arm-refusal-logs.env.ts.txt"));
  symlinkSync(join(REPO, "node_modules"), join(clone, "node_modules"));
  writeFileSync(join(clone, ".gitignore"), "node_modules\n");
  mkdirSync(RUNTIME, { recursive: true });
  symlinkSync(clone, join(RUNTIME, VESSEL));
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture: this vessel's src");
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
      const local = String(imp?.pointer?.command ?? "").replace(/^ROOT='([^']*)'/, (_m, p: string) => `ROOT='${join(CLONES, basename(p))}'`);
      const p = Bun.spawnSync(["bash", "-c", local], { cwd: clone, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
      return Response.json({ stdout: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) });
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

const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);
const ledgerOf = (r: Row | undefined): Row => ((metaOf(r)["check_supply"] ?? {}) as Row);
const regionGateOf = (r: Row | undefined): Row => (((ledgerOf(r)["mutation_gate"] ?? {}) as Row)["region_gate"] ?? {}) as Row;
async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
const checkPathOf = (id: string): string => `test/checks/${(csa["checkSupplyCheckFile"] as (x: string) => string)(id)}`;
let clock = Date.now() + 5000 * 3600_000;
const later = (): number => (clock += 30 * 3600_000);
async function tick(): Promise<void> {
  await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: later() } as never);
  await sg.__settleBirthEvaluationsForTests();
}
/** Seed the 5e69d7a0 row (its own evidence, no literal region), dispatch, land and commit `check`, and judge it. */
async function landAndArm(prefix: string, check: string): Promise<Row> {
  const id = T(prefix);
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: ROW.summary,
    classification_metadata: { edit_site: SITE, must_fail: ROW.must_fail, control: ROW.control, falsifier_spec: ROW.falsifier_spec } } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
  await tick();
  expect(ledgerOf(await storeRow(id))).toMatchObject({ state: "goal_dispatched", test_file: checkPathOf(id) });
  writeFileSync(join(clone, checkPathOf(id)), check);
  git("add", "-A");
  git("commit", "-q", "-m", `check ${id}`);
  await tick();
  return (await storeRow(id))!;
}

const ev = (f: string) => JSON.parse(fixture(f)) as { summary: string; falsifier_spec?: string | null; must_fail?: string | null; control?: string | null };
const gapText = (e: { summary: string; falsifier_spec?: string | null; must_fail?: string | null; control?: string | null }) => [e.summary, e.falsifier_spec, e.must_fail, e.control].filter((x): x is string => typeof x === "string").join("\n");
const MERGE_SITE = readFileSync(join(REPO, "src/resolvers/gap-store-merge-migration.ts"), "utf8");
const DV_SITE = fixture("gap-check-supply.bf88c790.ts.txt");

describe("checks that expect an invented literal are refused at arm", () => {
  it("[MUST-FAIL] 85ca4d09's check expects a reason nobody wrote", () => {
    const r = supply.inventedLiteralRefusal(fixture("85ca4d09-gap-store-merge-forwarding.check.ts.txt"), MERGE_SITE, gapText(ROW));
    expect(r?.reason).toStartWith("check_expects_invented_literal:");
    expect(r?.reason).toContain("local_copy_on_forwarding_node_is_stale_and_must_be_retired");
  });
  it("[CONTROL] the hand-written 5e69d7a0 check and 5e69d7a0's own: their literals are in the gap's text or the site", () => {
    const e = ev("5e69d7a0-row-evidence.json");
    expect(supply.inventedLiteralRefusal(fixture("5e69d7a0-correct-arm-refusal-logs.check.ts.txt"), DV_SITE, gapText(e))).toBeNull();
    expect(supply.inventedLiteralRefusal(fixture("5e69d7a0-mutation-gate-refusal-logs.check.ts.txt"), DV_SITE, gapText(e))).toBeNull();
  });
  it("[CONTROL] the replayed checks are unchanged: 23f78717, ribosome 44abf5e, 84460a91, 40d50487, da804a66", () => {
    const cases: Array<[string, string, string]> = [
      ["23f78717-concept-delete-write.check.ts.txt", fixture("concept-db-impulses.extract-78b70967.ts.txt"), ""],
      ["44abf5e-replay-judge.check.ts.txt", fixture("ribosome-replay-observer.44abf5e.ts.txt"), ""],
      ["84460a91-federation-egress-deadline.check.ts.txt", fixture("libp2p-federation-transport-index.84460a91.ts.txt"), gapText(ev("84460a91-row-evidence.json"))],
      ["40d50487-no-new-title-age.check.ts.txt", DV_SITE, gapText(ev("40d50487-row-evidence.json"))],
      ["da804a66-reach-judge-conditions.check.ts.txt", "", ""],
    ];
    for (const [f, site, text] of cases) expect([f, supply.inventedLiteralRefusal(fixture(f), site, text)]).toEqual([f, null]);
  });
  it("[CONTROL] what carries: an identifier-like literal (snake_case or camelCase); prose, single words and negated expectations are not read", () => {
    const check = (lit: string, neg = false) => `import { expect, test } from "bun:test";\nimport * as mod from "../../src/x";\ntest("t", () => { expect(mod.f())${neg ? ".not" : ""}.toBe(${JSON.stringify(lit)}); });\n`;
    expect(supply.inventedLiteralRefusal(check("never_said_here"), "", "")?.reason).toContain("never_said_here");
    // The phrase arm is dropped (option a): a correct check may expect the fix's NEW prose, which no site holds yet.
    expect(supply.inventedLiteralRefusal(check("three plain words"), "", "")).toBeNull();
    expect(supply.inventedLiteralRefusal(check("refused by containment"), "", "the walk reports containment-refused writes")).toBeNull();
    expect(supply.inventedLiteralRefusal(check("neverSaidHere"), "", "")?.reason).toContain("neverSaidHere");
    expect(supply.inventedLiteralRefusal(check("skipped"), "", "")).toBeNull();
    expect(supply.inventedLiteralRefusal(check("never_said_here", true), "", "")).toBeNull();
    expect(supply.inventedLiteralRefusal(check("said_in_the_site"), "const x = \"said_in_the_site\";", "")).toBeNull();
    expect(supply.inventedLiteralRefusal(check("said in the gap"), "", "the gap: said in the gap")).toBeNull();
  });
  it("[MUST-FAIL] end to end: 85ca4d09's check, verbatim, on its own gap row is arm_refused check_expects_invented_literal", async () => {
    const row = await landAndArm("invented", fixture("85ca4d09-gap-store-merge-forwarding.check.ts.txt"));
    expect(ledgerOf(row)["state"]).toBe("arm_refused");
    expect(String(ledgerOf(row)["reason"])).toStartWith("check_expects_invented_literal:");
    expect(metaOf(row)["evidence_resolve"] ?? null).toBeNull();
  }, 120_000);
});
