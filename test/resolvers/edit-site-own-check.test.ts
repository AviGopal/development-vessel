// A GAP WHOSE EDIT SITE IS ITS OWN CHECK IS NOT COMPOSE WORK, AND AN ARMED ONE IS UN-ARMED (2026-10-21).
//
// recommit-route-edit-7ffa6330-step-2-* was armed with edit_site == its check's test_file ==
// src/resolvers/substrate-gap.test.ts. The only edit that greens such a check is editing the check (self-certification);
// the semantic gate vetoed every draft, and the row looped on both nodes (about 5 composes in 2 h) toward its lineage cap.
//
// THE CONTRACT:
//   - the one eligibility predicate (gap-eligibility composeEligibilitySkipReason) answers edit_site_is_own_check when
//     the row's edit site is the test file its check runs (evidence_resolve test_suite input.test_file, or
//     check_supply.test_file), compared repo-relative (a repos/<vessel>/ prefix, "./", an absolute clone path, :line);
//     so the auto-pick, the targeted entry and feature_compose's admission all refuse it, each with that reason and a
//     `[check-supply] refused <id>: edit_site_is_own_check (<site>)` line from the pick;
//   - the write seam labels such a check unresolvable, reason edit_site_is_own_check, and gap-check-supply's tick
//     writes every armed row nothing else does, so an EXISTING armed row is un-armed, the decision recorded on it;
//   - the verify and the arm step (check-supply-admission checkImportsEditSite) refuse a check whose edit site is the
//     check file or any test file, stage edit_site_is_own_check, before anything runs.
// Refused, never re-sited: the instance's check reaches its module only through a template-literal dynamic import, so
// which src module it tests is not decidable from its imports.
// CONTROL: a row sited at the src module the check imports is still compose work and stays armed.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `own-check-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
const elig = await import("../../src/judge/gap-eligibility.js") as Record<string, unknown> & typeof import("../../src/judge/gap-eligibility.js");
const adm = await import("../../src/judge/gap-admission.js");
const supply = await import("../../src/resolvers/gap-check-supply.js");
const csa = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown> & typeof import("../../src/resolvers/check-supply-admission.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const ID = `recommit-route-edit-7ffa6330-step-2-verify_failed-${RUN}`;
/** The live instance's stored fields, verbatim. */
const instanceMeta = (): Row => ({
  edit_site: "repos/development-vessel/src/resolvers/substrate-gap.test.ts",
  evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: "src/resolvers/substrate-gap.test.ts", only_tests: ["still dedups by class against well-formed rows"], timeout_ms: 180000 }, zero_field: "requested_not_passing" },
  falsifier: "class2",
  predicate_source: "gap_falsify:inherit",
});
const rowOf = (id: string, meta: Row): Row => ({ id, category: "systematic_failure", source: "substrate_detected", status: "open", summary: `fixture ${id}`, detected_at: new Date().toISOString(), classification_metadata: meta });
const withSite = (site: string): Row => ({ ...instanceMeta(), edit_site: site });

describe("the one eligibility predicate refuses a row sited at its own check (pure)", () => {
  it("[MUST-FAIL] the live instance (edit_site repos/development-vessel/src/… vs test_file src/…) is edit_site_is_own_check", () => {
    expect(elig.composeEligibilitySkipReason(rowOf(ID, instanceMeta()))).toBe("edit_site_is_own_check");
  });

  it("[MUST-FAIL] the same file under every stored spelling: ./, an absolute clone path, a :line suffix, the supply's ledger", () => {
    for (const site of ["./src/resolvers/substrate-gap.test.ts", "src/resolvers/substrate-gap.test.ts:120", "/workspace/git/vessels/development-vessel/src/resolvers/substrate-gap.test.ts"]) {
      expect(elig.composeEligibilitySkipReason(rowOf(ID, withSite(site)))).toBe("edit_site_is_own_check");
    }
    const supplyRow = rowOf(ID, { edit_site: "repos/x-vessel/test/checks/a.check.ts", check_supply: { state: "armed", vessel: "x-vessel", test_file: "test/checks/a.check.ts" }, falsifier: "class2" });
    expect(elig.composeEligibilitySkipReason(supplyRow)).toBe("edit_site_is_own_check");
  });

  it("[CONTROL] a row sited at the src module the check imports is compose work; another vessel's same path is a different file", () => {
    expect(elig.composeEligibilitySkipReason(rowOf(ID, withSite("repos/development-vessel/src/resolvers/substrate-gap.ts")))).toBeNull();
    expect(elig.composeEligibilitySkipReason(rowOf(ID, withSite("repos/goal-host-vessel/src/resolvers/substrate-gap.test.ts")))).toBeNull();
  });

  it("[MUST-FAIL] the auto-pick and targeted admission exclude it by name, one counted line per refusal", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      const ex = adm.composeAdmissionExclusion(rowOf(ID, instanceMeta()));
      expect(ex).toMatchObject({ skip: "edit_site_is_own_check", reason: "edit_site_is_own_check(repos/development-vessel/src/resolvers/substrate-gap.test.ts)" });
      const t = adm.targetedComposeExclusion(rowOf(ID, instanceMeta()), { gap_id: ID });
      expect(JSON.stringify(t?.body ?? null)).toContain("edit_site_is_own_check");
    } finally { console.log = orig; }
    expect(lines).toContain(`[check-supply] refused ${ID}: edit_site_is_own_check (repos/development-vessel/src/resolvers/substrate-gap.test.ts)`);
    expect(adm.composeAdmissionExclusion(rowOf(ID, withSite("repos/development-vessel/src/resolvers/substrate-gap.ts")))).toBeNull();
  });

  it("[MUST-FAIL] the write seam's classifier labels such a check unresolvable, edit_site_is_own_check; a src-sited one is class2", () => {
    const c = sg.classifyFalsifier(instanceMeta());
    expect(c.falsifier).toBe("unresolvable");
    expect(String(c.unresolvable_reason)).toStartWith("edit_site_is_own_check:");
    expect(sg.classifyFalsifier(withSite("repos/development-vessel/src/resolvers/substrate-gap.ts")).falsifier).toBe("class2");
  });
});

describe("the verify and the arm step refuse a check whose edit site is a test (check-supply-admission)", () => {
  const CHECK = "test/checks/own.check.ts";
  const src = (spec: string): string => `import { expect, test } from "bun:test";\nimport * as mod from "${spec}";\ntest("t", () => { expect(Object.keys(mod).length).toBe(-1); });\n`;
  it("[MUST-FAIL] an edit site that is a test file the check imports is refused, stage edit_site_is_own_check", async () => {
    const r = await csa.checkImportsEditSite(src("../../src/x.test"), CHECK, "repos/v/src/x.test.ts", () => true);
    expect(r).toMatchObject({ ok: false, stage: "edit_site_is_own_check", edit_site: "src/x.test.ts" });
    const self = await csa.checkImportsEditSite(src("./own.check"), CHECK, `repos/v/${CHECK}`, () => true);
    expect(self).toMatchObject({ ok: false, stage: "edit_site_is_own_check" });
  });

  it("[CONTROL] the src module the check imports is still its edit site", async () => {
    expect(await csa.checkImportsEditSite(src("../../src/x"), CHECK, "repos/v/src/x.ts", () => true)).toEqual({ ok: true, edit_site: "src/x.ts" });
  });

  it("[MUST-FAIL] the test_writing verify refuses it before running anything", async () => {
    const root = mkdtempSync(join(tmpdir(), "own-check-verify-"));
    const gapId = `own-check-verify-${RUN}`;
    mkdirSync(join(root, "test", "checks"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "x.test.ts"), "export const n = 1;\n");
    writeFileSync(join(root, "test", "checks", csa.checkSupplyCheckFile(gapId)), src("../../src/x.test"));
    let calls = 0;
    const j = await csa.judgeTestWritingCheck({ gapId, vesselRoot: root, editSite: "repos/v/src/x.test.ts", run: async () => { calls += 1; return ""; } });
    expect(j.stage).toBe("edit_site_is_own_check");
    expect(calls).toBe(0);
  });
});

// END TO END over the store: a row ALREADY armed (planted as the live one is stored, class2) is un-armed by the tick.
const originalFetch = globalThis.fetch;
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
const dueRhythm = (): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(), body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 50, backoff_hours: 24, max_attempts: 5 } });
let logs: string[] = [];
const origLog = console.log;
const origWarn = console.warn;

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) return Response.json({ dispatchId: `d-${RUN}` }, { status: 202 });
    // the birth judge's own run of a planted check: unknown (no measurement), so nothing is decided by a run here
    if (url === "http://self.test/v2/impulses/resolve" && imp?.pointer?.type === "test_suite") return new Response("unavailable", { status: 503 });
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: [dueRhythm()], count: 1 } });
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write") return Response.json({ body: { ok: true } });
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
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
beforeEach(() => { logs = []; execGuard = installCutoverExecGuard(); g2fPolicy.__resetPolicyReadsForTests(); });
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

/** Plant rows exactly as stored (the seam's own classification is what is under test, so it is bypassed here). */
function plant(rows: Row[]): void {
  const file = join(sg.gapStoreRootForTest(), "gaps", "gaps.json");
  let all: Row[] = [];
  try { all = JSON.parse(readFileSync(file, "utf8")) as Row[]; } catch { all = []; }
  writeFileSync(file, JSON.stringify([...all.filter((r) => !rows.some((x) => x["id"] === r["id"])), ...rows], null, 2));
}
async function stored(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);

describe("an ALREADY-ARMED row sited at its own check is un-armed by gap-check-supply's tick", () => {
  it("[MUST-FAIL] the planted live row is un-armed with the named reason and the decision recorded; the pick still refuses it", async () => {
    const own = `${ID}-armed`, ctl = `${ID}-control`;
    plant([
      rowOf(own, { ...instanceMeta(), falsifier_classified_at: new Date().toISOString() }),
      rowOf(ctl, { ...withSite("repos/development-vessel/src/resolvers/substrate-gap.ts"), falsifier_classified_at: new Date().toISOString() }),
    ]);
    expect(metaOf(await stored(own))["falsifier"]).toBe("class2");
    const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: Date.now() + 5000 * 3600_000 } as never);
    await sg.__settleBirthEvaluationsForTests();
    expect((r.body as Row)["unarmed_own_check"]).toEqual([own]);
    const m = metaOf(await stored(own));
    expect(m["falsifier"]).toBe("unresolvable");
    expect(String(m["falsifier_unresolvable_reason"])).toStartWith("edit_site_is_own_check:");
    expect(m["own_check_unarmed"]).toMatchObject({ site: "repos/development-vessel/src/resolvers/substrate-gap.test.ts", check: "src/resolvers/substrate-gap.test.ts", reason: "edit_site_is_own_check" });
    expect(logs).toContain(`[check-supply] un-armed ${own}: edit_site_is_own_check (repos/development-vessel/src/resolvers/substrate-gap.test.ts)`);
    expect(elig.composeEligibilitySkipReason((await stored(own))!)).toBe("edit_site_is_own_check");
  });

  it("[CONTROL] an armed row sited at the src module stays armed and is not written by the sweep", async () => {
    const ctl = `${ID}-control2`;
    plant([rowOf(ctl, { ...withSite("repos/development-vessel/src/resolvers/substrate-gap.ts"), falsifier_classified_at: new Date().toISOString() })]);
    const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: Date.now() + 6000 * 3600_000 } as never);
    await sg.__settleBirthEvaluationsForTests();
    expect(((r.body as Row)["unarmed_own_check"] as string[] | undefined) ?? []).not.toContain(ctl);
    const m = metaOf(await stored(ctl));
    expect(m["falsifier"]).toBe("class2");
    expect(m["own_check_unarmed"]).toBeUndefined();
    expect(elig.composeEligibilitySkipReason((await stored(ctl))!)).toBeNull();
  });
});
