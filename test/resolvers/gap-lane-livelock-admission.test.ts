// THE GAP-LANE ADMISSION LIVELOCK (node1, 24 h to 2026-10-10). An unarmed gap with route:dispatchable and a
// gap_to_feature remedy (db_performance_slow_queries_*) was rewritten by its detector every ~10 min. Each write
// made gap-drain-observer dispatch gap_to_feature with its gap_id, a TARGETED call that never passed admission.
// feature_compose then refused it ("undirected compose NOT started: ... ineligible (unarmed)"), and gap_to_feature
// graded that refusal as a failed attempt. The bump took the gap past the chronic threshold on every tick, and each
// tick re-emitted the existing -narrowed child and re-escalated with no step written (126 escalations in 24 h).
//
// Pinned here (the repeat suppression, (c) and (d), is gap-lane-livelock-repeats.test.ts):
//   (a) a targeted autonomous dispatch of an unarmed gap U, or of its unarmed narrowed child, is excluded before any
//       compose with reason compose_ineligible_unarmed and costs no failed attempt, over N ticks. The armed gap A
//       passes the same gate, and auto-pick admission over [U, U-narrowed, A] admits only A.
//   (b) the gate, auto-pick admission and feature_compose share one predicate (composeEligibilitySkipReason), and
//       compose's own "ineligible" refusal is a non-attempt.
//   (e) compose's own eligibility refusal, reached by a directed dispatch, does not increment failed_attempts.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const SCRATCH = mkdtempSync(join(tmpdir(), "gap-lane-livelock-"));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = join(SCRATCH, "ws");
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
// Every file this path can write is pointed at scratch, so no run touches /workspace, /vessels or a tracked store.
const SCRATCH_ENV: Record<string, string> = {
  ATTEMPT_LEDGER_DIR: join(SCRATCH, "ledger"),
  MITOSIS_RUNTIME_DIR: join(SCRATCH, "runtime"),
  VESSELS_CLONE_ROOT: join(SCRATCH, "clones"),
  VESSEL_CLONE_ROOT: join(SCRATCH, "clones"),
  MITOSIS_PUSH_CLONE_DIR: join(SCRATCH, "push"),
  PROPOSALS_DIR: join(SCRATCH, "proposals"),
  PARKED_LANDINGS_DIR: join(SCRATCH, "parked"),
  EXPECTATION_CALIB_PATH: join(SCRATCH, "expectation-calibration.json"),
  GAP_CLASS_POSTERIOR_PATH: join(SCRATCH, "gap-class-posteriors.json"),
  CLOSE_ORACLE_CALIB_PATH: join(SCRATCH, "close-oracle-calibration.json"),
  DETECTOR_CLOSURE_LEDGER_PATH: join(SCRATCH, "detector-closure-credit.json"),
};
const SAVED_ENV: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(SCRATCH_ENV)) { SAVED_ENV[k] = process.env[k]; process.env[k] = v; mkdirSync(k.endsWith("_PATH") ? SCRATCH : v, { recursive: true }); }

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js") as typeof import("../../src/resolvers/gap-to-feature.js") & Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const SITE = "repos/development-vessel/src/resolvers/gap-to-feature.ts";
mkdirSync(join(SCRATCH, "runtime", "development-vessel", "src", "resolvers"), { recursive: true });
writeFileSync(join(SCRATCH, "runtime", "development-vessel", "src", "resolvers", "gap-to-feature.ts"), "export const fixture = 1;\n");

const originalFetch = globalThis.fetch;
const savedStoreEndpoint = process.env["GAP_STORE_ENDPOINT"];
let runGoals = 0;
let storeFile = "";
let storeBefore: string | null = null;
beforeAll(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  storeFile = join(root, "gaps", "gaps.json");
  try { storeBefore = readFileSync(storeFile, "utf8"); } catch { storeBefore = null; }
  mkdirSync(join(root, "gaps"), { recursive: true });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    if (body?.pointer?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    if (url.endsWith("/run-goal")) { runGoals++; return Response.json({ ok: true }); }
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  g2f.__resetPolicyReadsForTests();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  if (savedStoreEndpoint !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStoreEndpoint;
  if (storeFile) { if (storeBefore === null) rmSync(storeFile, { force: true }); else writeFileSync(storeFile, storeBefore); }
  for (const [k, v] of Object.entries(SAVED_ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  g2f.__resetPolicyReadsForTests();
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* noop */ }
});

type Row = Record<string, unknown>;
const LESSON = { class: "verify", reason: "typecheck failed in the drafted change at the named site", at: "2026-10-09T00:00:00.000Z" };
async function put(id: string, meta: Row, extra: Row = {}): Promise<Row> {
  const gap = { id, category: "db_performance", source: "substrate_detected", status: "open", detected_at: "2026-10-01T06:00:00.000Z", summary: `livelock probe ${id}`, ...extra, classification_metadata: meta };
  await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never);
  return gap;
}
async function read(id: string): Promise<Row | null> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id } as never);
  return (((r as { body?: { gaps?: Row[] } }).body?.gaps) ?? []).find((g) => String(g.id) === id) ?? null;
}
const metaOf = (g: Row | null): Row => ((g?.classification_metadata ?? {}) as Row);
async function captureLog<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { return { result: await fn(), lines }; } finally { console.log = orig.log; console.warn = orig.warn; }
}
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("(a) the 125x shape: a targeted autonomous dispatch never spends the lane on a gap compose will refuse", () => {
  const U = `db_performance_slow_queries_livelock-${RUN}`;
  const UN = `${U}-narrowed`;
  const A = `livelock-armed-${RUN}`;
  beforeAll(async () => {
    await put(U, { slow_queries: 4242, failed_attempts: 3, failure_lessons: [LESSON] }, { route: "dispatchable", remedy: { vessel: "development-vessel", impulse_type: "gap_to_feature" } });
    await put(UN, { slow_queries: 4242, failed_attempts: 0, parent_gap_id: U, narrowed_at: "2026-10-02T00:00:00.000Z" });
  });

  for (const which of ["U", "U-narrowed"] as const) {
    it(`${which}: N drain ticks are each excluded as compose_ineligible_unarmed; no compose, no attempt, no narrowing, no escalation`, async () => {
      const id = which === "U" ? U : UN;
      const before = metaOf(await read(id));
      const childBefore = metaOf(await read(UN));
      const r0 = runGoals;
      for (let tick = 0; tick < 3; tick++) {
        const { result, lines } = await captureLog(() => g2f.resolveGapToFeature({ type: "gap_to_feature", gap_id: id, triggered_by: "gap-drain" } as never));
        await settle();
        const body = result.body as Row;
        expect(body.ok).toBe(false);
        expect(body.reason).toBe("compose_ineligible_unarmed");
        expect(lines.some((l) => l.includes("[feature-compose]"))).toBe(false);
        expect(lines.some((l) => l.includes("compose_ineligible_unarmed"))).toBe(true);
        expect(lines.some((l) => l.includes("narrowed child") || l.includes("escalating"))).toBe(false);
      }
      const after = metaOf(await read(id));
      expect(Number(after.failed_attempts ?? 0)).toBe(Number(before.failed_attempts ?? 0));
      expect(Array.isArray(after.approach_decisions) ? after.approach_decisions.length : 0).toBe(Array.isArray(before.approach_decisions) ? before.approach_decisions.length : 0);
      expect(metaOf(await read(UN)).narrowed_at).toBe(childBefore.narrowed_at);
      expect(runGoals - r0).toBe(0);
    });
  }

  it("the same gate passes the armed, sited gap A; auto-pick admission over [U, U-narrowed, A] admits only A", async () => {
    const rowA: Row = { id: A, category: "systematic_failure", status: "open", summary: "armed probe", classification_metadata: { falsifier: "class2", edit_site: SITE } };
    const gate = g2f["composeAdmissionExclusion"] as (g: Row) => { skip: string; reason: string } | null;
    expect(gate(rowA)).toBeNull();
    expect(gate((await read(U))!)?.skip).toBe("unarmed");
    expect(gate((await read(UN))!)?.skip).toBe("unarmed");
    const { admitted } = await g2f.admitActionableGaps([(await read(U))!, (await read(UN))!, rowA]);
    expect(admitted.map((g) => String(g.id))).toEqual([A]);
  });
});

describe("(b) one predicate, and compose's eligibility refusal is a non-attempt", () => {
  const SRC_DIR = join(import.meta.dir, "..", "..", "src");
  const g2fSrc = readFileSync(join(SRC_DIR, "resolvers", "gap-to-feature.ts"), "utf8");
  const fcSrc = readFileSync(join(SRC_DIR, "resolvers", "feature-compose.ts"), "utf8");

  it("the admission exclusion IS composeEligibilitySkipReason on every non-exempt row (same function, same verdicts)", () => {
    const gate = g2f["composeAdmissionExclusion"] as (g: Row) => { skip: string } | null;
    const rows: Row[] = [
      { id: "p1", status: "open", classification_metadata: { falsifier: "none", edit_site: SITE } },
      { id: "p2", status: "open", classification_metadata: { falsifier: "class2" } },
      { id: "p3", status: "closed", classification_metadata: { falsifier: "class2", edit_site: SITE } },
      { id: "p4", status: "open", classification_metadata: { falsifier: "class1", edit_site: SITE, operator_hold: true } },
      { id: "p5", status: "open", classification_metadata: { falsifier: { class: "class2" }, edit_site: SITE } },
    ];
    for (const r of rows) expect(gate(r)?.skip ?? null).toBe(g2f.composeEligibilitySkipReason(r));
  });

  it("compose imports the predicate from gap-to-feature, and src defines it exactly once", () => {
    expect(fcSrc).toMatch(/const \{ composeEligibilitySkipReason \} = await import\("\.\/gap-to-feature\.js"\)/);
    expect(g2fSrc.match(/export function composeEligibilitySkipReason\(/g)?.length).toBe(1);
    expect(fcSrc).not.toMatch(/function composeEligibilitySkipReason\(/);
    const admission = g2fSrc.slice(g2fSrc.indexOf("export async function admitActionableGaps("), g2fSrc.indexOf("// CLOSE-ON-LAND (2026-06-29)"));
    expect(admission).toContain("composeAdmissionExclusion(g)");
    const gateFn = g2fSrc.slice(g2fSrc.indexOf("export function composeAdmissionExclusion("));
    expect(gateFn.slice(0, gateFn.indexOf("\n}\n"))).toContain("composeEligibilitySkipReason(g)");
  });

  it("the targeted branch runs the gate before the approach decision is recorded", () => {
    const once = g2fSrc.slice(g2fSrc.indexOf("async function resolveGapToFeatureOnce("));
    const gateAt = once.indexOf("targetedComposeExclusion(");
    expect(gateAt).toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(once.indexOf("await recordApproachDecision(gap)"));
  });

  it("every category the resolver routes away from feature_compose is in the gate's exempt set (no drift)", () => {
    const once = g2fSrc.slice(g2fSrc.indexOf("async function resolveGapToFeatureOnce("));
    const routed = [...once.matchAll(/String\(gap\.category \?\? ""\) === "([a-z_]+)"/g)].map((m) => m[1]).filter((c) => c !== "missing_capability");
    const exempt = g2f["NON_COMPOSE_ROUTE_CATEGORIES"] as ReadonlySet<string>;
    expect(routed.length).toBeGreaterThan(0);
    for (const c of routed) expect(exempt.has(c!)).toBe(true);
  });

  it("feature_compose's REFUSED/ineligible (not compose work) is a non-attempt; other REFUSED stages are not", () => {
    expect(g2f.isNonAttemptComposeResult({ ok: false, verdict: "REFUSED", stage: "ineligible", error: "gap x is not compose work: unarmed" })).toBe(true);
    expect(g2f.isNonAttemptComposeResult({ ok: false, verdict: "REFUSED", stage: "scope" })).toBe(false);
    expect(g2f.isNonAttemptComposeResult({ ok: false, verdict: "UNFAVORABLE", stage: "ineligible" })).toBe(false);
  });
});

describe("(e) the edge that fed the escalation: a REFUSED ineligible compose does not increment failed_attempts", () => {
  it("a directed dispatch reaching compose's eligibility refusal leaves failed_attempts, the child and the escalation untouched", async () => {
    const D = `livelock-directed-${RUN}`;
    await put(D, { failed_attempts: 3, failure_lessons: [LESSON] });
    const r0 = runGoals;
    const { result, lines } = await captureLog(() => g2f.resolveGapToFeature({ type: "gap_to_feature", gap_id: D, directed: true } as never));
    await settle();
    // The directed route is not gated at selection; compose's own refusal is what this pins.
    expect(lines.some((l) => l.includes(`gap ${D} is ineligible (unarmed)`))).toBe(true);
    expect(String(((result.body as Row).compose as Row | undefined)?.stage ?? "")).toBe("ineligible");
    expect(Number(metaOf(await read(D)).failed_attempts)).toBe(3);
    expect(await read(`${D}-narrowed`)).toBeNull();
    expect(lines.some((l) => l.includes("escalating"))).toBe(false);
    expect(runGoals - r0).toBe(0);
  });
});
