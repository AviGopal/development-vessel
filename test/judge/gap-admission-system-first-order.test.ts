// Inside a landability band, system-born rows come before operator-filed ones. The edit-site cap (2 per file per pass)
// hands its slots to the first rows that reach it, and the auto-pick keeps admission's order, so with landability alone
// an operator row at 0.90 took a file's slots from a system-born row at 0.85. Only the order changes: no predicate,
// threshold or cap, and an operator row is still admitted and picked when nothing system-born competes for it.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPolicyAnswer } from "../resolvers/explicit-open-policy.fixture.js";

const ROOT = join(tmpdir(), `admit-sysfirst-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const priorEnv = { MITOSIS_RUNTIME_DIR: process.env.MITOSIS_RUNTIME_DIR, PROPOSALS_DIR: process.env.PROPOSALS_DIR, VESSELS_CLONE_ROOT: process.env.VESSELS_CLONE_ROOT };
process.env.MITOSIS_RUNTIME_DIR = ROOT;
process.env.PROPOSALS_DIR = join(ROOT, "proposals");
process.env.VESSELS_CLONE_ROOT = join(ROOT, "clones");
const LITERAL = "http://system-first-order-literal.invalid";
mkdirSync(join(ROOT, "goal-host-vessel", "src"), { recursive: true });
mkdirSync(join(ROOT, "clones"), { recursive: true });
for (const f of ["shared.ts", "other.ts"]) writeFileSync(join(ROOT, "goal-host-vessel", "src", f), `export const u = "${LITERAL}";\n`);
writeFileSync(join(ROOT, "goal-host-vessel", "package.json"), JSON.stringify({ name: "goal-host-vessel" }));
mkdirSync(join(ROOT, "proposals"), { recursive: true });

const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  (modPolicy as { __resetPolicyReadsForTests: () => void }).__resetPolicyReadsForTests();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(priorEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const modAdmission = await import("../../src/judge/gap-admission.js") as Record<string, unknown>;
const modPolicy = await import("../../src/judge/gap-policy.js") as Record<string, unknown>;
const { landabilityScore } = await import("../../src/judge/gap-attempt-credit.js");
type Row = Record<string, unknown>;
const admitActionableGaps = modAdmission.admitActionableGaps as (g: Row[], o?: unknown) => Promise<{ admitted: Row[]; excluded: Array<{ id: string; reason: string }> }>;
const pickCandidate = modAdmission.pickCandidate as (g: Row[], hooks: unknown) => Row | null;
// The expression the auto-pick hands pickCandidate (gap-to-feature: pickPoolForCapacity(orderByLandability(admitted)),
// whose unreserved branch returns the rows unchanged).
const orderByLandability = modAdmission.orderByLandability as (rows: Row[]) => Row[];

const runner = (_v: string) => ({ ran: true, clean: false });
const SITE = "repos/goal-host-vessel/src/shared.ts";
// failing_test is in neither the hard nor the surgical category list: a string edit_site scores 0.5 + 0.3 + 0.1 = 0.90.
// One failed attempt costs 0.1 and per-gap lessons give 0.05 back (0.85); four failed attempts cost 0.4 (0.50).
function gap(id: string, opts: { source?: string; filedBy?: string; fa?: number; lessons?: boolean; site?: string } = {}): Row {
  const m: Row = { edit_site: opts.site ?? SITE, falsifier: "class1", hardcoded_url: LITERAL, failed_attempts: opts.fa ?? 0 };
  if (opts.lessons) m.per_gap_failure_lessons = ["a prior draft missed the literal"];
  if (opts.filedBy) m.filed_by = opts.filedBy;
  return { id, category: "failing_test", source: opts.source ?? "substrate_detected", summary: "fix the thing", status: "open", classification_metadata: m };
}
const OP = "operator:qa";
const sys90 = (id: string, site?: string) => gap(id, { site });
const sys85 = (id: string, site?: string) => gap(id, { fa: 1, lessons: true, site });
const sys50 = (id: string, site?: string) => gap(id, { fa: 4, site });
const op90 = (id: string, site?: string) => gap(id, { source: OP, site });
const op85 = (id: string, site?: string) => gap(id, { source: OP, fa: 1, lessons: true, site });
const op50 = (id: string, site?: string) => gap(id, { source: OP, fa: 4, site });
const ids = (rows: Row[]) => rows.map((g) => String(g.id));
async function admit(gs: Row[]) {
  const r = await admitActionableGaps(gs, { typecheckRunner: runner });
  return { admittedIds: ids(r.admitted), admitted: r.admitted, reasonOf: (id: string) => r.excluded.find((e) => e.id === id)?.reason };
}
/** The closed pick over rows in the auto-pick's order, ranked by landability alone (no class rerank). */
function pick(rows: Row[]): string | null {
  const log = console.log;
  console.log = () => {};
  try {
    const chosen = pickCandidate(orderByLandability(rows), { lineageIndex: new Map(rows.map((g) => [String(g.id), g])), score: (g: Row) => landabilityScore(g), rerank: () => {}, onPicked: () => {}, ask: async () => null });
    return chosen ? String(chosen.id) : null;
  } finally { console.log = log; }
}
/** BASE's order: landabilityScore descending, stable. */
const byScoreOnly = (rows: Row[]) => [...rows].sort((a, b) => landabilityScore(b) - landabilityScore(a));

describe("inside a landability band, system-born rows rank before operator-filed ones", () => {
  it("the fixtures score as stated", () => {
    expect(landabilityScore(sys90("sf-score-a"))).toBeCloseTo(0.9, 6);
    expect(landabilityScore(sys85("sf-score-b"))).toBeCloseTo(0.85, 6);
    expect(landabilityScore(sys50("sf-score-c"))).toBeCloseTo(0.5, 6);
    expect(landabilityScore(op90("sf-score-d"))).toBeCloseTo(0.9, 6);
    expect(landabilityScore(op85("sf-score-e"))).toBeCloseTo(0.85, 6);
    expect(landabilityScore(op50("sf-score-f"))).toBeCloseTo(0.5, 6);
  });

  it("[MUST-FAIL] admission: a system-born 0.85 row wins an edit-site slot over two operator 0.90 rows that precede it in store order", async () => {
    const a = op90("sf-a-op-first"), b = op90("sf-a-op-second"), c = sys85("sf-a-sys");
    const { admittedIds, reasonOf } = await admit([a, b, c]);
    expect(admittedIds).toEqual(["sf-a-sys", "sf-a-op-first"]);
    expect(reasonOf("sf-a-op-second")).toBe(`edit_site_saturated(${SITE})`);
    expect(reasonOf("sf-a-sys")).toBeUndefined();
  });

  it("[MUST-FAIL] the auto-pick's pool order: a system-born 0.85 row comes before an operator 0.90 row", () => {
    const o = op90("sf-b-op", "repos/goal-host-vessel/src/other.ts"), s = sys85("sf-b-sys");
    expect(ids(orderByLandability([o, s]))).toEqual(["sf-b-sys", "sf-b-op"]);
  });

  it("[MUST-FAIL] the pick: at equal landability the system-born row is picked over an operator row ahead of it in store order", () => {
    const o = op90("sf-c-op", "repos/goal-host-vessel/src/other.ts"), s = sys90("sf-c-sys");
    expect(pick([o, s])).toBe("sf-c-sys");
  });

  it("[CONTROL] an operator row that is the only candidate is still admitted and picked", async () => {
    const o = op90("sf-d-only");
    const { admittedIds, admitted } = await admit([o]);
    expect(admittedIds).toEqual(["sf-d-only"]);
    expect(pick(admitted)).toBe("sf-d-only");
  });

  it("[CONTROL] a pool with no system-born rows keeps landabilityScore order and the same pick", async () => {
    const rows = [
      op50("sf-e-1", "repos/goal-host-vessel/src/other.ts"), gap("sf-e-2", { source: "human_reported", fa: 1, lessons: true }),
      op90("sf-e-3", "repos/goal-host-vessel/src/other.ts"), gap("sf-e-4", { filedBy: OP }), op85("sf-e-5", "repos/goal-host-vessel/src/other.ts"),
      gap("sf-e-6", { source: "human_reported", fa: 4 }),
    ];
    expect(ids(orderByLandability(rows))).toEqual(ids(byScoreOnly(rows)));
    expect(ids(orderByLandability(rows))).toEqual(["sf-e-3", "sf-e-4", "sf-e-2", "sf-e-5", "sf-e-1", "sf-e-6"]);
    expect(pick(rows)).toBe("sf-e-3");
    const { admittedIds } = await admit(rows);
    expect(admittedIds).toEqual(["sf-e-3", "sf-e-4", "sf-e-2", "sf-e-5", "sf-e-6"]);
  });

  it("[CONTROL] the band is respected: a system-born 0.50 row does not move above an operator 0.90 row", async () => {
    const s = sys50("sf-f-sys", "repos/goal-host-vessel/src/other.ts"), o = op90("sf-f-op");
    expect(ids(orderByLandability([s, o]))).toEqual(["sf-f-op", "sf-f-sys"]);
    const s1 = sys50("sf-f-sys1"), s2 = sys50("sf-f-sys2"), o2 = op90("sf-f-op2");
    const { admittedIds, reasonOf } = await admit([s1, s2, o2]);
    expect(admittedIds).toEqual(["sf-f-op2", "sf-f-sys1"]);
    expect(reasonOf("sf-f-sys2")).toBe(`edit_site_saturated(${SITE})`);
  });

  it("[CONTROL] the ranker is unchanged: with both admitted, pickCandidate's own score sort still picks the operator 0.90 over the system-born 0.85", () => {
    const o = op90("sf-g-op", "repos/goal-host-vessel/src/other.ts"), s = sys85("sf-g-sys");
    expect(pick([s, o])).toBe("sf-g-op");
  });

  it("origin follows the autonomy judge's operator-filed test (source operator:* or human_reported, or filed_by operator:*)", async () => {
    const { operatorActsOf } = await import("../../src/resolvers/operator-acts.js");
    const operatorFiled = modAdmission.operatorFiled as (r: Row) => boolean;
    const rows: Row[] = [
      sys90("sf-h-sys"), op90("sf-h-op"), gap("sf-h-human", { source: "human_reported" }), gap("sf-h-filedby", { filedBy: OP }),
      gap("sf-h-route", { source: "route-edit" }), { id: "recommit-route-edit-sf-h", source: "gap_to_feature", classification_metadata: {} },
      { id: "sf-h-metaonly", source: "substrate_detected", metadata: { filed_by: OP } }, { id: "sf-h-nosource" },
    ];
    for (const r of rows) {
      const judge = operatorActsOf(r as never, { byId: new Map(), filedAt: null, untilAt: null }).acts.some((a: { addendum: string }) => a.addendum === "operator-filed");
      expect({ id: r.id, operatorFiled: operatorFiled(r) }).toEqual({ id: r.id, operatorFiled: judge });
    }
    expect(rows.filter((r) => operatorFiled(r)).map((r) => r.id)).toEqual(["sf-h-op", "sf-h-human", "sf-h-filedby"]);
  });
});
