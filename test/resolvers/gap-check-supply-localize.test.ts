// I1: A GAP THAT HAS ITS CHECK AND LACKS ONLY A SITE IS LOCALIZED BEFORE ADMISSION, NEVER SENT A TEST-WRITING GOAL.
//
// An armed class2 gap (its own check, birth verdict present) with no site field is excluded by compose admission as
// needs_information(no_edit_site) before any localizer runs; the only localizer (gap-to-feature localizeGap) ran after a
// pick, and its result never reached the row (af21e4fe wrote it with a pointer the store refused; f77676f6 fixed the
// wrapper and dropped the payload). gap-check-supply already selects these rows, and sent them a test-writing goal that
// would replace a check they already have. Now its tick sites them from their own evidence (checkSupplySite, else
// localizeGap without the LLM), writes edit_site + the shaped localizationRecord (gap.localization) with
// localized_by/localization_method, and sends nothing.
// Harness: as gap-check-supply-order.test.ts (temp gap store, temp clones, stubbed fetch, a "present" birth judge).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";

const ROOT = join(tmpdir(), `gcs-loc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
const EDIT = `repos/${VESSEL}/src/widget.ts`;

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let goals: Array<{ goal: string; variables?: Record<string, unknown> }> = [];
let rhythms: Row[] = [];
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;

const dueRhythm = (extra: Row = {}): Row => ({
  id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(),
  body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 1, backoff_hours: 24, max_attempts: 3, ...extra },
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
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) { goals.push({ goal: String(body.goal ?? ""), variables: body.variables }); return Response.json({ dispatchId: `d-${RUN}-${goals.length}` }, { status: 202 }); }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: rhythms, count: rhythms.length } });
    if (imp?.type === "poolImpulse" && imp?.shape === "autonomyScope") return Response.json({ body: { impulses: [{ id: "autonomy-scope", shape: "autonomyScope", body: { excluded_paths: ["repos/some-other-vessel/"], require_falsifier_classes: ["class2"] } }], count: 1 } });
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
  globalThis.fetch = originalFetch; console.log = origLog; console.warn = origWarn;
  sg.__setBirthJudgeForTests(null); restoreCutoverExecModules(); __resetDiscoveryForTests();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { goals = []; rhythms = [dueRhythm()]; execGuard = installCutoverExecGuard(); g2fPolicy.__resetPolicyReadsForTests(); });
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
/** Seed one open, unarmed gap; detected_at sets its age; meta adds an edit site / a stated falsifier. */
async function seed(id: string, detectedAt: string, summary: string, meta: Row = {}): Promise<void> {
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: detectedAt, summary, classification_metadata: meta } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function closeAllOpen(): Promise<void> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never);
  for (const g of ((r.body as { gaps?: Row[] }).gaps ?? [])) {
    if (String(g["status"] ?? "open") !== "open") continue;
    const meta = { ...((g["classification_metadata"] ?? {}) as Row), closed_reason: "fixture isolation", closed_by: "gap-check-supply-order.test.ts" };
    await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...g, status: "closed", classification_metadata: meta } } as never);
  }
  await sg.__settleBirthEvaluationsForTests();
}
async function tick(now: number): Promise<Row> {
  const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
  await sg.__settleBirthEvaluationsForTests();
  return r.body as Row;
}
const dispatchedIds = () => goals.map((g) => String(g.variables?.["gap_id"] ?? ""));
async function storeRow(id: string): Promise<Row> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  const row = ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
  if (!row) throw new Error(`seeded gap ${id} not in the store`);
  return row;
}
/** The age the dispatch sort reads (gap-check-supply step 3): first_detected_at ?? detected_at. */
const sortAge = (r: Row): string => String(r["first_detected_at"] ?? r["detected_at"] ?? "");
/** PRECONDITIONS (qa): every seeded gap is a supply candidate (not birth-armed, not held), and the ages the sort reads
 *  are in the intended order. Without these, a red or green could come from candidacy, not ordering. */
async function expectCandidatesInAgeOrder(idsOldestFirst: string[]): Promise<void> {
  const rows = await Promise.all(idsOldestFirst.map(storeRow));
  for (const r of rows) expect(supply.checkSupplyDisposition(r)).not.toBeNull();
  // a candidate whose vessel does not resolve is skipped without using the slot, so it could never compete (qa)
  for (const r of rows) expect(supply.checkSupplyVessel(r)).toBe(VESSEL);
  for (let i = 1; i < rows.length; i++) expect(sortAge(rows[i - 1]!) < sortAge(rows[i]!)).toBe(true);
}

const CHECK = { shape: "test_suite", input: { vessel: VESSEL, test_file: "test/checks/widget.check.ts", only_tests: ["widget returns 2"] } };
const OTHER = `repos/${VESSEL}/src/gadget.ts`;
async function seedArmed(id: string, summary: string, meta: Row = {}): Promise<Row> {
  await seed(id, "2026-10-01T00:00:00Z", summary, { evidence_resolve: CHECK, ...meta });
  return storeRow(id);
}
const metaOf = (r: Row): Row => (r["classification_metadata"] ?? {}) as Row;
const SITE_FIELDS = ["edit_site", "file_path", "change_site", "suspected_real_location"];

describe("gap-check-supply localizes a siteless armed gap instead of asking for a test", () => {
  beforeAll(() => {
    writeFileSync(join(CLONES, VESSEL, "src", "gadget.ts"), "export const gadget = 1;\n");
    writeFileSync(join(RUNTIME, VESSEL, "src", "gadget.ts"), "export const gadget = 1;\n");
  });

  it("[MUST-FAIL] an armed class2 gap whose summary names an existing src file gains edit_site + a localizationRecord, and no goal is sent", async () => {
    await closeAllOpen();
    const id = T("gcs-loc-main");
    const pre = await seedArmed(id, `fixture ${RUN}: ${EDIT} widget returns 1; it must return 2`);
    // PRECONDITIONS: armed class2, no site field, excluded only for no_edit_site, and a supply candidate.
    expect(metaOf(pre)["falsifier"]).toBe("class2");
    for (const f of SITE_FIELDS) expect(metaOf(pre)[f] ?? null).toBeNull();
    const elig = await import("../../src/judge/gap-eligibility.js");
    expect(elig.composeEligibilitySkipReason(pre)).toBe("no_edit_site");
    expect(supply.checkSupplyDisposition(pre)).not.toBeNull();
    const body = await tick(Date.now());
    const post = await storeRow(id);
    expect(metaOf(post)["edit_site"]).toBe(EDIT);
    expect(metaOf(post)["localized_by"]).toBe("gap-check-supply");
    expect(metaOf(post)["localization_method"]).toBe("check_supply_site");
    const rec = post["localization"] as Row;
    expect(rec?.["file"]).toBe(EDIT);
    expect(rec?.["gap_id"]).toBe(id);
    const core = await import("../../src/resolvers/compose-admission-core.js");
    expect(core.validLocalizationRecord(rec)).toBe(true);
    expect(elig.composeEligibilitySkipReason(post)).not.toBe("no_edit_site");
    expect(dispatchedIds()).toEqual([]);
    expect((body["localized"] as Row[]).map((x) => x["id"])).toEqual([id]);
    expect(metaOf(post)["falsifier"]).toBe("class2");
  });

  it("[CONTROL A] a summary naming no file that exists gets no site and no goal", async () => {
    await closeAllOpen();
    const id = T("gcs-loc-nofile");
    await seedArmed(id, `fixture ${RUN}: repos/${VESSEL}/src/not-there.ts misbehaves`);
    await tick(Date.now());
    const post = await storeRow(id);
    for (const f of SITE_FIELDS) expect(metaOf(post)[f] ?? null).toBeNull();
    expect(post["localization"] ?? null).toBeNull();
    expect(dispatchedIds()).toEqual([]);
  });

  it("[CONTROL B] a gap that already has an edit site is never re-aimed", async () => {
    await closeAllOpen();
    const id = T("gcs-loc-own");
    await seedArmed(id, `fixture ${RUN}: ${OTHER} names another file`, { edit_site: EDIT });
    await tick(Date.now());
    const post = await storeRow(id);
    expect(metaOf(post)["edit_site"]).toBe(EDIT);
    expect(metaOf(post)["localized_by"] ?? null).toBeNull();
  });

  it("[CONTROL C] a literal row (expected_literal) gets no site", async () => {
    await closeAllOpen();
    const id = T("gcs-loc-literal");
    await seed(id, "2026-10-01T00:00:00Z", `fixture ${RUN}: ${EDIT} still holds a literal`, { expected_literal: "widget = 1" });
    await tick(Date.now());
    const post = await storeRow(id);
    expect(metaOf(post)["edit_site"] ?? null).toBeNull();
    expect(metaOf(post)["localized_by"] ?? null).toBeNull();
  });

  it("[PARAPHRASE] the same file named in reworded summaries gets the same site", async () => {
    for (const [i, s] of [`the widget in ${EDIT} is wrong`, `${EDIT}: widget() must return 2, it returns 1`, `fix widget (see ${EDIT})`].entries()) {
      await closeAllOpen();
      const id = T(`gcs-loc-para${i}`);
      await seedArmed(id, `fixture ${RUN}: ${s}`);
      await tick(Date.now());
      expect(metaOf(await storeRow(id))["edit_site"]).toBe(EDIT);
    }
    expect(dispatchedIds()).toEqual([]);
  });

  it("[HELD-OUT] another file of the vessel, named the same way, is sited at that file", async () => {
    await closeAllOpen();
    const id = T("gcs-loc-held");
    await seedArmed(id, `fixture ${RUN}: ${OTHER} gadget returns 1`);
    await tick(Date.now());
    const post = await storeRow(id);
    expect(metaOf(post)["edit_site"]).toBe(OTHER);
    expect((post["localization"] as Row)?.["file"]).toBe(OTHER);
  });
});
