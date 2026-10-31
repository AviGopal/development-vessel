// Admission walks its candidates by landability, not store order. The edit-site cap (2 per file per pass) hands its
// slots to the first rows that reach it: in store order a 0.90 row lost its file's slots to 0.50 rows filed earlier,
// and a row under the pick's landability floor (0.15) could take a slot the floor then threw away, leaving the pick
// with less than the file had to offer. Only the order changes: no predicate, threshold or cap.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPolicyAnswer } from "../resolvers/explicit-open-policy.fixture.js";

const ROOT = join(tmpdir(), `admit-lord-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const priorEnv = { MITOSIS_RUNTIME_DIR: process.env.MITOSIS_RUNTIME_DIR, PROPOSALS_DIR: process.env.PROPOSALS_DIR, VESSELS_CLONE_ROOT: process.env.VESSELS_CLONE_ROOT };
process.env.MITOSIS_RUNTIME_DIR = ROOT;
process.env.PROPOSALS_DIR = join(ROOT, "proposals");
process.env.VESSELS_CLONE_ROOT = join(ROOT, "clones");
const LITERAL = "http://landability-order-literal.invalid";
mkdirSync(join(ROOT, "goal-host-vessel", "src"), { recursive: true });
mkdirSync(join(ROOT, "clones"), { recursive: true });
for (const f of ["shared.ts", "other.ts", "third.ts"]) writeFileSync(join(ROOT, "goal-host-vessel", "src", f), `export const u = "${LITERAL}";\n`);
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

const runner = (_v: string) => ({ ran: true, clean: false });
const SITE = "repos/goal-host-vessel/src/shared.ts";
// failing_test is in neither the hard nor the surgical category list: a string edit_site scores 0.5 + 0.3 + 0.1 = 0.90,
// four failed attempts on it cost 0.4 (0.50). performance_inefficiency (hard, -0.4) with five costs 0.4 more (0.10).
function gap(id: string, opts: { cat?: string; fa?: number; site?: string } = {}): Row {
  return {
    id, category: opts.cat ?? "failing_test", source: "substrate_detected", summary: "fix the thing", status: "open",
    classification_metadata: { edit_site: opts.site ?? SITE, falsifier: "class1", hardcoded_url: LITERAL, failed_attempts: opts.fa ?? 0 },
  };
}
const L90 = (id: string, site?: string) => gap(id, { site });
const L50 = (id: string, site?: string) => gap(id, { fa: 4, site });
const L10 = (id: string, site?: string) => gap(id, { cat: "performance_inefficiency", fa: 5, site });
async function admit(gs: Row[]) {
  const r = await admitActionableGaps(gs, { typecheckRunner: runner });
  return { admittedIds: r.admitted.map((g) => String(g.id)), admitted: r.admitted, reasonOf: (id: string) => r.excluded.find((e) => e.id === id)?.reason };
}
/** The closed pick over the admitted rows, ranked by landability alone (no class rerank). */
function pick(admitted: Row[]): { picked: string | null; lines: string[] } {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const chosen = pickCandidate(admitted, { lineageIndex: new Map(admitted.map((g) => [String(g.id), g])), score: (g: Row) => landabilityScore(g), rerank: () => {}, onPicked: () => {}, ask: async () => null });
    return { picked: chosen ? String(chosen.id) : null, lines };
  } finally { console.log = log; }
}

describe("admission orders candidates by landability before the edit-site cap", () => {
  it("the fixtures score as stated", () => {
    expect(landabilityScore(L90("lord-score-a"))).toBeCloseTo(0.9, 6);
    expect(landabilityScore(L50("lord-score-b"))).toBeCloseTo(0.5, 6);
    expect(landabilityScore(L10("lord-score-c"))).toBeCloseTo(0.1, 6);
  });

  it("[MUST-FAIL] a 0.90 row gets an edit-site slot over two 0.50 rows on the same file that precede it in store order", async () => {
    const p1 = L50("lord-a-first"), p2 = L50("lord-a-second"), c = L90("lord-a-late");
    const { admittedIds, reasonOf } = await admit([p1, p2, c]);
    expect(admittedIds).toContain("lord-a-late");
    expect(admittedIds).toContain("lord-a-first"); // ties keep store order: the earlier 0.50 row keeps the second slot
    expect(reasonOf("lord-a-second")).toBe(`edit_site_saturated(${SITE})`);
    expect(reasonOf("lord-a-late")).toBeUndefined();
  });

  it("[MUST-FAIL] a 0.10 row first in store order does not take a slot from two later 0.90 rows; the pick is a 0.90 row and the floor excludes none", async () => {
    const low = L10("lord-b-low"), hi1 = L90("lord-b-high"), hi2 = L90("lord-b-higher");
    const { admittedIds, admitted, reasonOf } = await admit([low, hi1, hi2]);
    expect(admittedIds).toEqual(["lord-b-high", "lord-b-higher"]);
    expect(reasonOf("lord-b-low")).toBe(`edit_site_saturated(${SITE})`);
    expect(admitted.every((g) => landabilityScore(g) >= 0.15)).toBe(true);
    const { picked, lines } = pick(admitted);
    expect(picked).toBe("lord-b-high");
    expect(lines.some((l) => l.includes("landability_floor excluded"))).toBe(false);
  });

  it("[CONTROL] only below-floor rows: admission admits them as before and the floor still excludes them all", async () => {
    const a = L10("lord-c-one", "repos/goal-host-vessel/src/other.ts"), b = L10("lord-c-two", "repos/goal-host-vessel/src/third.ts");
    const { admittedIds, admitted } = await admit([a, b]);
    expect(admittedIds).toEqual(["lord-c-one", "lord-c-two"]);
    const { picked, lines } = pick(admitted);
    expect(picked).toBeNull();
    expect(lines).toContain("[gap-to-feature] landability_floor excluded 2 of 2 candidates (floor=0.15)");
  });

  it("[CONTROL] equal landability keeps store order (the sort is stable), and the cap still admits two per file", async () => {
    const rows = [L50("lord-d-1"), L50("lord-d-2"), L50("lord-d-3")];
    const { admittedIds, reasonOf } = await admit(rows);
    expect(admittedIds).toEqual(["lord-d-1", "lord-d-2"]);
    expect(reasonOf("lord-d-3")).toBe(`edit_site_saturated(${SITE})`);
  });
});
