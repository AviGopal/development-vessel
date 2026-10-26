// PRE-REGISTERED REPLAYS OF THE FIVE STILL-ARMED WRONG CHECKS THROUGH THE ARM GATES (qa/research, 2026-10-24). The
// post-install by-effect read compares against these predictions; they are stated once, here and in the range's CREC
// header, and not changed after. Each check is the system-authored one, verbatim (fixtures), on its own gap's evidence:
//  - development-vessel 4560f675 (registry-change-observer probe dispatch): REFUSED, red_independent_of_edit_site (the
//    edit-site gate: no operator mutant of the observer moves its `dispatched` false); its derived region (token
//    dispatchRecommendationForProbe, the call statement) does not move it either. One arm failure_lessons record.
//  - development-vessel 5e69d7a0 (mutation-gate refusal logs): REFUSED, region_red_unchanged (the token
//    red_independent_of_edit_site's two refusal returns), with one arm failure_lessons record.
//  - concept-db 23f78717: REFUSED, region_red_unchanged (text anchor "not yet implemented"); measured end to end in
//    gap-check-supply-region-mutant.test.ts on the impulses.ts extract; asserted here at the decision.
//  - libp2p-federation-transport 84460a91: UNMEASURED, recorded reason "token resolveViaLibp2p: 0 non-declaration
//    occurrence(s) of 1; token resolveViaHttp: 0 non-declaration occurrence(s) of 1" (gated since its literal is in
//    another repo; no region derivable).
//  - development-vessel 40d50487: OUTSIDE REACH of the region gate in this range: its literal region occurs in its own
//    edit site (the exemption; the next range lifts it).
// Gate (8), CHECK_DEPENDS_ON_HOST_STATE, does not join this range: 4560f675 is refused above, and 97204187's check is
// already arm_refused red_independent_of_edit_site on the live store.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { landCheck } from "./landed-check.fixture.js";

const ROOT = join(tmpdir(), `gcs-replays-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
const SITE_OF = (rel: string) => `repos/${VESSEL}/${rel}`;
const SITE = SITE_OF("src/resolvers/gap-check-supply.ts");
const ROW = JSON.parse(fixture("5e69d7a0-row-evidence.json")) as { summary: string; must_fail: string; control: string; falsifier_spec: string };

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
/** Seed a row with its own evidence, dispatch, land and commit `check`, and judge it. */
async function landAndArm(prefix: string, check: string, ev: { summary: string; must_fail?: string | null; control?: string | null; falsifier_spec?: string | null; region?: string | null } = ROW, site = SITE): Promise<Row> {
  const id = T(prefix);
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: ev.summary,
    classification_metadata: { edit_site: site, ...(ev.must_fail ? { must_fail: ev.must_fail } : {}), ...(ev.control ? { control: ev.control } : {}), ...(ev.falsifier_spec ? { falsifier_spec: ev.falsifier_spec } : {}), ...(ev.region ? { region: ev.region } : {}) } } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
  await tick();
  expect(ledgerOf(await storeRow(id))).toMatchObject({ state: "goal_dispatched", test_file: checkPathOf(id) });
  writeFileSync(join(clone, checkPathOf(id)), check);
  git("add", "-A");
  git("commit", "-q", "-m", `check ${id}`);
  landCheck(clone, checkPathOf(id));
  await tick();
  return (await storeRow(id))!;
}

const ev = (f: string) => JSON.parse(fixture(f)) as { summary: string; falsifier_spec?: string | null; must_fail?: string | null; control?: string | null; region?: string | null };
const lessonsOf = (r: Row | undefined): Row[] => (Array.isArray(metaOf(r)["failure_lessons"]) ? (metaOf(r)["failure_lessons"] as Row[]) : []);

describe("pre-registered replays of the five still-armed wrong checks", () => {
  it("[REPLAY] dv 4560f675: REFUSED red_independent_of_edit_site, its region unmoved too, one arm lesson", async () => {
    const row = await landAndArm("rp-4560", fixture("4560f675-registry-observer-probe-dispatch.check.ts.txt"), ev("4560f675-row-evidence.json"), SITE_OF("src/observers/registry-change-observer.ts"));
    expect(ledgerOf(row)["state"]).toBe("arm_refused");
    expect(String(ledgerOf(row)["reason"])).toStartWith("red_independent_of_edit_site:");
    expect(regionGateOf(row)).toMatchObject({ region: "derived_from_token_anchor", anchor: "dispatchRecommendationForProbe", changed: 0 });
    expect(lessonsOf(row).map((l) => [l["class"], l["stage"]])).toEqual([["red_independent_of_edit_site", "arm"]]);
  }, 240_000);
  it("[REPLAY] dv 5e69d7a0: REFUSED region_red_unchanged, one arm lesson", async () => {
    const row = await landAndArm("rp-5e69", fixture("5e69d7a0-mutation-gate-refusal-logs.check.ts.txt"));
    expect(String(ledgerOf(row)["reason"])).toStartWith("region_red_unchanged:");
    expect(lessonsOf(row).map((l) => [l["class"], l["stage"]])).toEqual([["region_red_unchanged", "arm"]]);
  }, 240_000);
  it("[REPLAY] cdb 23f78717: its region is derived (text anchor), refused end to end in the region-mutant test", () => {
    const r = supply.derivedTextRegion(fixture("concept-db-impulses.extract-78b70967.ts.txt"), "src/routes/impulses.ts", "The resolver case at ~:713-717 throws \"not yet implemented\" for all three.");
    expect(r).toMatchObject({ anchor: "not yet implemented", kind: "text" });
  });
  it("[REPLAY] libp2p 84460a91: UNMEASURED, its reason recorded", () => {
    const e = ev("84460a91-row-evidence.json");
    const site = fixture("libp2p-federation-transport-index.84460a91.ts.txt");
    expect(supply.regionGateApplies({ region: e.region }, site)).toBe(true);
    expect(supply.explainedTextRegion(site, "src/index.ts", e.summary, e.falsifier_spec ?? "")).toEqual({ region: null, why: "token resolveViaLibp2p: 0 non-declaration occurrence(s) of 1; token resolveViaHttp: 0 non-declaration occurrence(s) of 1" });
  });
  it("[REPLAY] dv 40d50487: OUTSIDE REACH in this range (its literal is in its own site)", () => {
    const e = ev("40d50487-row-evidence.json");
    expect(supply.regionGateApplies({ region: e.region }, readFileSync(join(REPO, "src/resolvers/gap-check-supply.ts"), "utf8"))).toBe(false);
  });
});
