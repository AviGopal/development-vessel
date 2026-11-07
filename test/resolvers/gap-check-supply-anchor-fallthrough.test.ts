// WHAT A ROW'S WRITERS ALREADY PUT THERE ANCHORS ITS CHECK (user ruling on the step-3 anchor census, "Yes, all three").
//
// Step 3 of gap_check_supply_tick builds a test-writing goal only for a row whose evidence names a falsifiable anchor
// (falsifiableAnchors over the summary and falsifier_spec). A census of the honest-and-landable rows found 16 of 33
// skipped "evidence names no falsifiable anchor" every tick, several carrying an anchor their writers had put there:
// the `in the region "X"` clause goal-host's restateWithTargetFile writes into a route-edit summary, snake_case names
// the site's code uses (unbackticked, so only the region gate's site_tokens rule read them), and, for an "investigate
// and decompose gap <parent>:" wrapper, the parent row's own evidence. A row the evidence alone leaves unanchored now
// falls through to those, in that order (checkSupplyAnchors); nothing else changes.
//   [MUST-FAIL] (a) a route-edit row whose only anchor is a region literal occurring once in its site: a goal is built.
//   [MUST-FAIL] (b) a row whose only anchor is an unbackticked snake_case token its site uses: a goal is built.
//   [MUST-FAIL] (c) a wrapper whose parent's falsifier_spec names a symbol that resolves in the wrapper's site: a goal
//               is built on the parent's anchor; a structured parent field outranks the id in the summary prefix.
//   [CONTROL]   a region literal occurring 0 or 2 times in the site: no anchor.
//   [CONTROL]   a wrapper whose parent is not in the store read: no anchor.
//   [CONTROL]   a row the evidence already anchors: its goal is exactly the goal of its own anchors (no token added).
//   [CONTROL]   a hollow-class recipe goal (the boredom writer's template, a one-word quoted class name): no anchor.
//   [CONTROL]   a decomposed step that is not a wrapper, with a structured parent_gap_id whose parent anchors: no anchor.
// The MUST-FAILs drive the tick (dry run) through exports that exist at the parent commit, so each is red there by
// its own assertion. Hermetic: temp gap store and clone root, fetch stubbed, exec guard on, dry run (no send, no write).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-anchor-ft-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT", "SUBSTRATE_NAME", "SUPER_REPO_DIR"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
// THE SHAPED POLICIES DIRECTORY (signal-window.ts shapedPolicyPath): its own, so no live policy dispatches baselines here.
process.env["SUPER_REPO_DIR"] = join(ROOT, "policy-super");
mkdirSync(join(ROOT, "policy-super", ".git"), { recursive: true });
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
process.env["SUBSTRATE_NAME"] = "node-a";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const supply = (await import("../../src/resolvers/gap-check-supply.js")) as Record<string, any>;
const supply_checkSupplyAdmission = (await import("../../src/resolvers/check-supply-admission.js")) as Record<string, any>;
const admission = await import("../../src/resolvers/check-supply-admission.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "local-tools-vessel";
const H = 3_600_000;
const site = (f: string): string => `repos/${VESSEL}/src/${f}`;
const SITES: Record<string, string> = {
  // (a) the region literal occurs once, in code; the summary names nothing else the site has.
  "anchor-region.ts": `export function routeNote(kind: string): string {\n  if (kind === "edit") return "landing note";\n  return "other";\n}\n`,
  // the region literal twice.
  "anchor-twice.ts": `export function routeNotes(kind: string): string[] {\n  if (kind === "edit") return ["landing note"];\n  return ["landing note", "other"];\n}\n`,
  // (b) a snake_case token the code writes as a string.
  "anchor-token.ts": `export function routeOf(ran: boolean): string {\n  return ran ? "landed" : "arm_refused";\n}\n`,
  // (c) the parent's symbol, used in the wrapper's site.
  "anchor-parent.ts": `export function legibilityScore(px: number): number {\n  return px >= 12 ? 1 : 0;\n}\n`,
};
const RESTATED = (file: string, region: string, request: string): string =>
  `Edit ${site(file)} to satisfy the following request. The relevant code is in the region "${region}". If that file is the wrong target, say so rather than editing it.  ${request}`;
const RECIPE = (cls: string): string =>
  `In ${site("anchor-token.ts")}, add or refine a deterministic parse+command+oracle for the "${cls}" goal-failure class following the reach_by_construction_recipe: parse the goal operands once into a shared function, emit a deterministic shell command that produces the answer, and add a matching independent oracle that recomputes from the authoritative source and verifies the produced value. The change must typecheck.`;

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let rhythm: Row = {};
let goals: string[] = [];
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
const storeFile = (): string => join(sg.gapStoreRootForTest(), "gaps", "gaps.json");

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const d of [join(CLONES, VESSEL, "src"), join(CLONES, VESSEL, "test", "checks"), join(RUNTIME, VESSEL, "src")]) mkdirSync(d, { recursive: true });
  for (const [f, src] of Object.entries(SITES)) { writeFileSync(join(CLONES, VESSEL, "src", f), src); writeFileSync(join(RUNTIME, VESSEL, "src", f), src); }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) { goals.push(String(body.goal ?? "")); return Response.json({ dispatchId: `d-${RUN}-${goals.length}` }, { status: 202 }); }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: [rhythm], count: 1 } });
    if (imp?.type === "poolImpulse_write" && imp?.shape === "timeShapedRhythm") { rhythm = { ...rhythm, body: imp.body }; return Response.json({ body: { ok: true, id: imp.id } }); }
    if (imp?.type === "poolImpulse" && imp?.shape === "autonomyScope") {
      const rows = [{ id: "autonomy-scope", shape: "autonomyScope", body: { excluded_paths: ["repos/some-other-vessel/"] } }];
      return Response.json({ body: { impulses: rows, count: rows.length } });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write") return Response.json({ body: { ok: true } });
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "unknown");
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
beforeEach(async () => {
  await sg.__settleBirthEvaluationsForTests();
  writeFileSync(storeFile(), "[]"); // each case reads only its own rows
  goals = [];
  execGuard = installCutoverExecGuard();
  g2fPolicy.__resetPolicyReadsForTests();
});
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id, 0) === "treatment" && supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
async function seed(id: string, summary: string, meta: Row): Promise<void> {
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "substrate_detected", status: "open", detected_at: "2029-12-01T00:00:00.000Z", summary, classification_metadata: meta } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function stored(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
/** One due dry-run pass: what step 3 would send (id -> goal) and why it skipped the rest (id -> reason). */
async function pass(now: number): Promise<{ sent: Map<string, string>; skipped: Map<string, string> }> {
  rhythm = { id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date(now - 40 * H).toISOString(),
    body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 20, backoff_hours: 24, max_attempts: 3, control_fraction: 0 } };
  const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now, dry_run: true } as never);
  await sg.__settleBirthEvaluationsForTests();
  const body = (r.body ?? {}) as { dispatched?: Array<{ id: string; goal: string }>; skipped?: Array<{ id: string; reason: string }> };
  return { sent: new Map((body.dispatched ?? []).map((d) => [String(d.id), String(d.goal)])), skipped: new Map((body.skipped ?? []).map((s) => [String(s.id), String(s.reason)])) };
}
const expectNoAnchor = (p: { sent: Map<string, string>; skipped: Map<string, string> }, id: string): void => {
  expect(p.sent.has(id)).toBe(false);
  expect(p.skipped.get(id)).toBe(supply.NO_ANCHOR_REASON);
};

describe("step 3 falls through to the anchors a row's writers already wrote", () => {
  it("[MUST-FAIL] (a) a route-edit row whose only anchor is a region literal occurring once in its site gets a test-writing goal", async () => {
    const id = T("gcs-ft-region-once");
    await seed(id, RESTATED("anchor-region.ts", "landing note", "Make the route name the file it touched."), { edit_site: site("anchor-region.ts"), falsifier: "none", route_edit_persisted: true });
    const p = await pass(Date.parse("2031-06-01T00:00:00.000Z"));
    expect(p.skipped.get(id)).toBeUndefined();
    expect(p.sent.get(id) ?? "").toContain(`region "landing note"`);
  });

  it("[MUST-FAIL] (b) a row whose only anchor is an unbackticked snake_case token its site uses gets a test-writing goal", async () => {
    const id = T("gcs-ft-token");
    await seed(id, "The supply records arm_refused for a row whose check never ran, so the lane parks a row it never judged.", { edit_site: site("anchor-token.ts"), falsifier: "none" });
    const p = await pass(Date.parse("2031-06-02T00:00:00.000Z"));
    expect(p.skipped.get(id)).toBeUndefined();
    expect(p.sent.get(id) ?? "").toContain("token `arm_refused`");
  });

  it("[MUST-FAIL] (c) a wrapper whose parent carries a falsifier_spec with a resolvable symbol is anchored via the parent", async () => {
    const parent = T("gcs-ft-parent");
    await seed(parent, "the legibility scan judges type size only and cannot see content form", { falsifier: "none", falsifier_spec: "legibilityScore(10) returns 0 for a body set in a readable serif; it must return 1" });
    expect(await stored(parent)).toBeDefined(); // in the store read; it names no site or vessel, so no goal is built for it
    const id = T("gcs-ft-wrapper");
    await seed(id, `investigate and decompose gap ${parent}: the scan cannot tell content form apart, so every surface reads as legible.`, { edit_site: site("anchor-parent.ts"), falsifier: "none" });
    // a STRUCTURED parent field outranks the id in the summary prefix (which names no row here)
    const fielded = T("gcs-ft-wrapper-field");
    await seed(fielded, `investigate and decompose gap no-such-row-${RUN}: the scan cannot tell content form apart.`, { edit_site: site("anchor-parent.ts"), falsifier: "none", root_gap_id: parent });
    const p = await pass(Date.parse("2031-06-03T00:00:00.000Z"));
    for (const w of [id, fielded]) {
      expect(p.skipped.get(w)).toBeUndefined();
      expect(p.sent.get(w) ?? "").toContain("symbol `legibilityScore`");
    }
    expect(p.sent.has(parent)).toBe(false);
  });

  it("[CONTROL] a region literal occurring 0 or 2 times in its site anchors nothing", async () => {
    const zero = T("gcs-ft-region-zero");
    const two = T("gcs-ft-region-two");
    await seed(zero, RESTATED("anchor-region.ts", "absent words", "Make the route name the file it touched."), { edit_site: site("anchor-region.ts"), falsifier: "none" });
    await seed(two, RESTATED("anchor-twice.ts", "landing note", "Make the route name the file it touched."), { edit_site: site("anchor-twice.ts"), falsifier: "none" });
    const p = await pass(Date.parse("2031-06-04T00:00:00.000Z"));
    expectNoAnchor(p, zero);
    expectNoAnchor(p, two);
  });

  it("[CONTROL] a wrapper whose parent is not in the store read anchors nothing", async () => {
    const id = T("gcs-ft-orphan");
    await seed(id, `investigate and decompose gap no-such-parent-${RUN}: the scan cannot tell content form apart, so every surface reads as legible.`, { edit_site: site("anchor-parent.ts"), falsifier: "none" });
    const p = await pass(Date.parse("2031-06-05T00:00:00.000Z"));
    expectNoAnchor(p, id);
  });

  it("[CONTROL] a row the evidence already anchors gets exactly the goal of its own anchors", async () => {
    const id = T("gcs-ft-anchored");
    const summary = "routeOf returns landed for a row whose check never ran and records arm_refused; it must return parked";
    await seed(id, summary, { edit_site: site("anchor-token.ts"), falsifier: "none" });
    const p = await pass(Date.parse("2031-06-06T00:00:00.000Z"));
    const siteSrc = SITES["anchor-token.ts"]!;
    const own = supply_checkSupplyAdmission.falsifiableAnchors(summary, siteSrc, "", null);
    expect(own.length).toBeGreaterThan(0);
    const meta = ((await stored(id))?.["classification_metadata"] ?? {}) as Row;
    const reader = admission.srcReaderAt(join(CLONES, VESSEL));
    expect(p.sent.get(id)).toBe(supply.checkSupplyGoal(VESSEL, supply.checkSupplyTestFile(id), summary, site("anchor-token.ts"), reader, own, [], meta));
    expect(p.sent.get(id) ?? "").not.toContain("token `arm_refused`");
  });

  it("[CONTROL] a hollow-class recipe goal and a non-wrapper step with an anchored parent stay unanchored", async () => {
    const recipe = T("gcs-ft-recipe");
    await seed(recipe, RECIPE("deterministic_wrong_registry_count"), { edit_site: site("anchor-token.ts"), falsifier: "none", route_edit_persisted: true, suspected_real_location: "routeOf" });
    const parent = T("gcs-ft-step-parent");
    await seed(parent, "the legibility scan judges type size only", { falsifier: "none", falsifier_spec: "legibilityScore(10) returns 0 for a readable serif; it must return 1" });
    const step = T("gcs-ft-step");
    await seed(step, `[step 1 of ${parent}] Delete the file anchor-parent.ts from ${VESSEL}.`, { edit_site: site("anchor-parent.ts"), falsifier: "none", parent_gap_id: parent });
    const p = await pass(Date.parse("2031-06-07T00:00:00.000Z"));
    expectNoAnchor(p, recipe);
    expectNoAnchor(p, step);
  });
});
