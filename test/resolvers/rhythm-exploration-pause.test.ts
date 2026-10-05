// NO UNPAUSED FAMILY IS PERMANENTLY UNDUE; NO PAUSED FAMILY EVER COMES DUE (rhythm conductor, 10-05).
//
// Live 10-05: staleness saturated at 1, so a family with credit_mean / max(budget, 0.05) < 1 could never come due.
// Node 1 had 7 of 14 such families: five sunk by penalties (gap-check-supply, federation-verification,
// concept-management, validation, capability-census: credit as low as 1/11 at budget <= 1, most of it beta from
// no_goal_mapping skips) and two paused on purpose (self-maintenance: budget 2 with body.hold; project-intake: budget
// 1.5 with body.operator_pause). These tests pin:
//   (a) a configuration skip (no_goal_mapping) settles neither alpha nor beta (an unavailable observation is not a
//       negative outcome, REALIGNMENT §2.2);
//   (b) exploration: staleness keeps growing past 1 and credit_mean is floored (explore_credit_floor, shaped, default
//       0.1), so an unpaused family comes due within 24 h * (threshold * max(budget, .05) / max(credit, floor));
//   (c) the pause guard: budget > 1, or hold / operator_pause / quarantine in the body, means never due and never
//       selected, however stale (a hold is never lifted by outgrowing it, §7 step 9).
// Control: a healthy family crosses the threshold at exactly the moment it did before.
//
// Hermetic: discovery through the vessel's own seam, every other call through a fetch stub; no network.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "rhythm-explore-"));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
const conductor = await import("../../src/resolvers/rhythm-conductor-tick.js");
const { __setDiscoveryForTests, __resetDiscoveryForTests } = await import("../../src/config.js");
const { rhythmDueScore } = conductor;

type Row = Record<string, unknown>;
const NOW = Date.parse("2026-10-05T18:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
/** The pre-10-05 formula, for the control. */
const oldDue = (b: Row, ageH: number) => {
  const a = Number(b["alpha"] ?? 1), be = Number(b["beta"] ?? 1);
  return (a / (a + be)) * Math.min(1, Number(b["staleness"] ?? 0) + ageH / 24) / Math.max(Number(b["budget"] ?? 1), 0.05);
};

describe("exploration: an unpaused penalty-dead family comes due in bounded time (must-fail at base)", () => {
  it("credit 1/11 at budget 0.2 comes due by 24 h * 0.2 / max(1/11, 0.1) = 48 h, and not before", () => {
    const b = { family: "validation", budget: 0.2, alpha: 1, beta: 10, staleness: 0 };
    expect(rhythmDueScore(b as never, hoursAgo(47.9), NOW).due_score).toBeLessThan(1);
    expect(rhythmDueScore(b as never, hoursAgo(48.1), NOW).due_score).toBeGreaterThanOrEqual(1);
  });

  it("a credit below the floor is floored (shaped: explore_credit_floor in the body, default 0.1)", () => {
    const b = { family: "concept-management", budget: 0.5, alpha: 1, beta: 99, staleness: 0 };
    // credit 0.01 < floor 0.1: due at 24 h * 0.5 / 0.1 = 120 h.
    expect(rhythmDueScore(b as never, hoursAgo(119), NOW).due_score).toBeLessThan(1);
    expect(rhythmDueScore(b as never, hoursAgo(121), NOW).due_score).toBeGreaterThanOrEqual(1);
    // The row's own floor is read at use time.
    expect(rhythmDueScore({ ...b, explore_credit_floor: 0.5 } as never, hoursAgo(25), NOW).due_score).toBeGreaterThanOrEqual(1);
  });
});

describe("the pause guard: a paused family never comes due, however stale (must-fail at base)", () => {
  const ancient = hoursAgo(24 * 365);
  it("budget 2 (with body.hold, node 1's self-maintenance) and budget 1.5 (operator_pause, project-intake) score 0", () => {
    const sm = rhythmDueScore({ family: "self-maintenance", budget: 2, alpha: 9, beta: 1, staleness: 0, hold: { held_by: "operator:claude-avi (user-approved 2026-09-28)" } } as never, ancient, NOW);
    expect(sm.due_score).toBe(0);
    expect((sm as Row)["paused_by"]).toBe("hold");
    const pi = rhythmDueScore({ family: "project-intake", budget: 1.5, alpha: 9, beta: 1, staleness: 0, operator_pause: { by: "operator", at: "2026-09-27" } } as never, ancient, NOW);
    expect(pi.due_score).toBe(0);
  });

  it("budget 2 with no hold field is paused; budget 0.3 with body.hold is paused; quarantine pauses too", () => {
    expect(rhythmDueScore({ family: "x", budget: 2, alpha: 9, beta: 1 } as never, ancient, NOW).due_score).toBe(0);
    expect(rhythmDueScore({ family: "y", budget: 0.3, alpha: 9, beta: 1, hold: { held_by: "operator" } } as never, ancient, NOW).due_score).toBe(0);
    expect(rhythmDueScore({ family: "z", budget: 0.3, alpha: 9, beta: 1, quarantine: { until: "x" } } as never, ancient, NOW).due_score).toBe(0);
  });
});

describe("control: a healthy family's cadence is unchanged (green at base)", () => {
  it("credit 0.75 at budget 0.2 crosses the threshold at 6.4 h exactly as before, and the score matches below 1", () => {
    const b = { family: "gap-organizing", budget: 0.2, alpha: 3, beta: 1, staleness: 0 };
    for (const h of [0, 1, 3, 6, 6.39, 6.41, 12, 23]) {
      expect(Math.abs(rhythmDueScore(b as never, hoursAgo(h), NOW).due_score - oldDue(b, h))).toBeLessThan(1e-9);
    }
    expect(rhythmDueScore(b as never, hoursAgo(6.39), NOW).due_score).toBeLessThan(1);
    expect(rhythmDueScore(b as never, hoursAgo(6.41), NOW).due_score).toBeGreaterThanOrEqual(1);
  });
});

// The conductor itself, over a stubbed registry.
let rhythms: Row[] = [];
let writes: Row[] = [];
let directCalls: Row[] = [];
const originalFetch = globalThis.fetch;
beforeEach(() => {
  rhythms = []; writes = []; directCalls = [];
  __setDiscoveryForTests({
    lookup: async (shape: string) => ({ ok: true, shape, cached: false, producers: [{ id: "pool-fixture", resolveEndpoint: "http://pool.fixture/v2/impulses/resolve", origin: "local" }] }),
    describe: (r: { shape?: string }) => `${String(r.shape)} fixture producer`,
    failureBackoffMs: 2_000,
  } as never);
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: rhythms, count: rhythms.length } });
    if (imp?.type === "poolImpulse" && imp?.shape === "spendEnvelope") return Response.json({ body: { impulses: [{ shape: "spendEnvelope", updated_at: "2026-01-01T00:00:00Z", body: { uncapped: true, paused: false } }] } });
    if (imp?.type === "poolImpulse") return Response.json({ body: { impulses: [] } });
    if (imp?.type === "poolImpulse_write") { writes.push(imp); return Response.json({ body: { ok: true } }); }
    if (imp?.pointer?.type) { directCalls.push(imp.pointer); return Response.json({ shape: "x", body: {} }); }
    return Response.json({});
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; __resetDiscoveryForTests(); });
async function conduct(): Promise<Row> {
  const queue = join(ROOT, `queue-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(queue, JSON.stringify({ tasks: [] }));
  const r = await conductor.resolveRhythmConductorTick({ type: "rhythm_conductor_tick", bucket_load: 0, registry_endpoint: "http://test/v2/impulses/resolve", queue_path: queue });
  return r.body as Row;
}

describe("the conductor: configuration skips are neutral, paused families never fire (must-fail at base)", () => {
  it("a due family with no goal mapping is skipped and settles NEITHER alpha nor beta", async () => {
    rhythms = [{ id: "rhythm-unmapped-fixture", shape: "timeShapedRhythm", updated_at: hoursAgo(48), body: { axis: "load", family: "unmapped-fixture-family", budget: 0.2, alpha: 3, beta: 1, staleness: 1 } }];
    const body = await conduct();
    expect((body["skipped"] as Row[]).map((s) => s["reason"])).toContain("no_goal_mapping");
    const w = writes.filter((x) => x["id"] === "rhythm-unmapped-fixture");
    expect(w.map((x) => [(x["body"] as Row)["alpha"], (x["body"] as Row)["beta"]]).filter(([a, b]) => a !== 3 || b !== 1)).toEqual([]);
  });

  it("a held resolver-backed family (budget 0.15, body.hold) is never fired however stale; its unheld twin is", async () => {
    rhythms = [{ id: "rhythm-gap-organizing", shape: "timeShapedRhythm", updated_at: hoursAgo(24 * 365), body: { axis: "load", family: "gap-organizing", budget: 0.15, alpha: 9, beta: 1, staleness: 5, hold: { held_by: "operator" } } }];
    await conduct();
    expect(directCalls.filter((c) => c["type"] === "gap_lifecycle_scan")).toEqual([]);
    rhythms = [{ id: "rhythm-gap-organizing", shape: "timeShapedRhythm", updated_at: hoursAgo(24 * 365), body: { axis: "load", family: "gap-organizing", budget: 0.15, alpha: 9, beta: 1, staleness: 5 } }];
    await conduct();
    expect(directCalls.filter((c) => c["type"] === "gap_lifecycle_scan").length).toBe(1);
  });
});
