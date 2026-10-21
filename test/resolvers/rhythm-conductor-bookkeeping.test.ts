// THE CONDUCTOR ASKS AN UNDUE FAMILY FOR ITS BOOKKEEPING ON EVERY PASS, AND NEVER DISPATCHES IT (2026-10-21).
//
// The conductor called a resolver-backed family only when it was due and affordable (rhythm-conductor-tick.ts, the
// candidates filter), so gap-check-supply's outcome read-back, arm and un-arm waited as long as its rhythm stayed
// undue. FAMILY_BOOKKEEPING names a family's cheap phase: on every pass that does not fire the family, whatever its
// due-ness, the conductor sends that pointer (gap_check_supply_tick with bookkeeping_only), scores and settles nothing
// from it, does not await it (the timer's caller gives a whole pass 30 s), and logs a failed call when it settles. A paused family is not asked. CONTROL: a due family is fired through
// FAMILY_RESOLVERS exactly as before, and is not asked again for its bookkeeping in that pass.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as conductor from "../../src/resolvers/rhythm-conductor-tick.js";
import { __resetPolicyReadsForTests } from "../../src/judge/gap-policy.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

type Row = Record<string, unknown>;
const H = 3_600_000;
const originalFetch = globalThis.fetch;
const origLog = console.log;
let pointers: Row[] = [];
let rhythmWrites: Row[] = [];
let lines: string[] = [];
let bookkeepingAnswer: "ok" | "fail" | "reject" | "slow" = "ok";

/** The live node's gap-check-supply rhythm (due 0.586 when written 7.3 h ago), and a due gap-closing family. */
const supplyRhythm = (ageH: number, extra: Row = {}): Row => ({
  id: "rhythm-gap-check-supply", shape: "timeShapedRhythm", updated_at: new Date(Date.now() - ageH * H).toISOString(),
  body: { axis: "freshness", axis_code: 2, family: "gap-check-supply", budget: 0.3, alpha: 21, beta: 55, staleness: 0.3315043440464263, transient: false, ...extra },
});
const gapClosing: Row = { id: "rhythm-gap-closing", shape: "timeShapedRhythm", body: { axis: "gap", axis_code: 3, family: "gap-closing", budget: 0.1, alpha: 6, beta: 1, staleness: 0.9 } };
let registry: Row[] = [];
let familyGoals: Row[] = [];

beforeEach(() => {
  __resetPolicyReadsForTests();
  pointers = []; rhythmWrites = []; lines = []; bookkeepingAnswer = "ok"; familyGoals = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    // the spend envelope reads through discovery (fails closed without a record): one producer, an open record
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse" && body.impulse.shape === "spendEnvelope") return openPolicyAnswer(body.impulse.shape);
    if (!url.includes("/v2/impulses/resolve")) return new Response("not found", { status: 404 });
    const imp = body?.impulse ?? {};
    if (imp?.pointer) {
      pointers.push(imp.pointer);
      if (imp.pointer.bookkeeping_only === true && bookkeepingAnswer === "fail") return new Response("boom", { status: 500 });
      if (imp.pointer.bookkeeping_only === true && bookkeepingAnswer === "reject") throw new TypeError("Unable to connect. Is the computer able to access the url?");
      if (imp.pointer.bookkeeping_only === true && bookkeepingAnswer === "slow") await Bun.sleep(2_000); // a long arm judge
      return Response.json({ shape: "gapCheckSupplyReport", body: { fired: false } });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: registry, count: registry.length } });
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: familyGoals, count: familyGoals.length } });
    // A write is STORED as the pool stores it (by id, the body as given, the clock reset).
    if (imp?.type === "poolImpulse_write") {
      rhythmWrites.push(imp);
      const apply = (rows: Row[]): Row[] => rows.map((r) => (r["id"] === imp.id ? { ...r, body: imp.body, updated_at: new Date().toISOString() } : r));
      registry = apply(registry); familyGoals = apply(familyGoals);
      return Response.json({ body: { ok: true, id: imp.id } });
    }
    if (imp?.type === "substrateGap_write") return Response.json({ body: { ok: true } });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = origLog;
  __resetPolicyReadsForTests();
});

async function pass(): Promise<Row> {
  const queue = join(mkdtempSync(join(tmpdir(), "rcb-")), "queue.json");
  writeFileSync(queue, JSON.stringify({ tasks: [], lastUpdated: 0 }));
  const r = await conductor.resolveRhythmConductorTick({ type: "rhythm_conductor_tick", bucket_load: 0, registry_endpoint: "http://test/v2/impulses/resolve", queue_path: queue });
  return r.body as Row;
}
const bookkeepingCalls = (): Row[] => pointers.filter((p) => p["type"] === "gap_check_supply_tick" && p["bookkeeping_only"] === true);
const dispatchCalls = (): Row[] => pointers.filter((p) => p["type"] === "gap_check_supply_tick" && p["bookkeeping_only"] !== true);

describe("the conductor's bookkeeping entry (FAMILY_BOOKKEEPING)", () => {
  it("[CONTROL] the fixture rhythm is undue by the conductor's own formula", () => {
    const r = supplyRhythm(7.3);
    expect(conductor.rhythmDueScore(r["body"] as never, r["updated_at"]).due_score).toBeLessThan(1);
  });

  it("[MUST-FAIL] the map declares gap-check-supply's cheap phase as its own resolver asked for the bookkeeping only", () => {
    const map = (conductor as Record<string, unknown>)["FAMILY_BOOKKEEPING"] as Record<string, Row> | undefined;
    expect(map?.["gap-check-supply"]).toEqual({ type: "gap_check_supply_tick", bookkeeping_only: true });
  });

  it("[MUST-FAIL] check-supply undue: each pass asks for its bookkeeping once, never dispatches it, and scores or settles nothing for it", async () => {
    registry = [supplyRhythm(7.3), gapClosing];
    const first = await pass();
    expect(bookkeepingCalls().length).toBe(1);
    const second = await pass();
    expect(bookkeepingCalls().length).toBe(2); // once per pass
    expect(dispatchCalls().length).toBe(0);
    expect(rhythmWrites.filter((w) => w["id"] === "rhythm-gap-check-supply").length).toBe(0);
    for (const b of [first, second]) {
      expect(((b["enqueued"] ?? []) as Row[]).some((e) => e["family"] === "gap-check-supply")).toBe(false);
      expect(b["bookkeeping"]).toEqual([{ family: "gap-check-supply", asked: true }]);
    }
    // the due family in the same registry is enqueued and fired as before
    expect(((first["enqueued"] ?? []) as Row[]).map((e) => e["family"])).toEqual(["gap-closing"]);
  });

  for (const how of ["fail", "reject"] as const) {
    it(`[MUST-FAIL] a bookkeeping call that ${how === "fail" ? "answers HTTP 500" : "rejects (no connection)"} logs exactly ONE line naming the family, and the pass returns normally`, async () => {
      registry = [supplyRhythm(7.3), gapClosing];
      bookkeepingAnswer = how;
      const b = await pass();
      expect(bookkeepingCalls().length).toBe(1);
      // the report says the family was ASKED, never that anything settled: success evidence is the resolver's own marker
      expect(b["bookkeeping"]).toEqual([{ family: "gap-check-supply", asked: true }]);
      expect(JSON.stringify(b["bookkeeping"])).not.toContain("settled");
      expect(((b["enqueued"] ?? []) as Row[]).map((e) => e["family"])).toEqual(["gap-closing"]);
      expect(rhythmWrites.filter((w) => w["id"] === "rhythm-gap-check-supply").length).toBe(0);
      // not awaited: the pass returned first, and the failure is logged once when the call settles
      const failLine = "[rhythm-conductor] bookkeeping for gap-check-supply failed or did not answer within 60 s; the pass goes on";
      for (let i = 0; i < 100 && !lines.includes(failLine); i++) await Bun.sleep(10);
      await Bun.sleep(50);
      expect(lines.filter((l) => l.startsWith("[rhythm-conductor] bookkeeping for"))).toEqual([failLine]);
    });
  }

  it("[MUST-FAIL] a bookkeeping-only pass is made and leaves the family's rhythm record and its family-goal record byte-identical", async () => {
    registry = [supplyRhythm(7.3), gapClosing];
    familyGoals = [{ id: "rhythm-family-goal-gap-check-supply", shape: "rhythmFamilyGoal", updated_at: "2026-10-01T00:00:00.000Z", body: { family: "gap-check-supply", goal: "supply checks for gaps that have none" } }];
    const rhythmBefore = JSON.stringify(registry.find((r) => r["id"] === "rhythm-gap-check-supply"));
    const familyBefore = JSON.stringify(familyGoals);
    await pass();
    expect(bookkeepingCalls().length).toBe(1);
    expect(dispatchCalls().length).toBe(0);
    expect(JSON.stringify(registry.find((r) => r["id"] === "rhythm-gap-check-supply"))).toBe(rhythmBefore);
    expect(JSON.stringify(familyGoals)).toBe(familyBefore);
    expect(rhythmWrites.filter((w) => w["id"] === "rhythm-gap-check-supply" || w["shape"] === "rhythmFamilyGoal")).toEqual([]);
  });

  it("[MUST-FAIL] the pass does not wait for the bookkeeping: a call still running returns the pass at once (the timer's caller gives a pass 30 s)", async () => {
    registry = [supplyRhythm(7.3), gapClosing];
    bookkeepingAnswer = "slow";
    const t0 = Date.now();
    const b = await pass();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(bookkeepingCalls().length).toBe(1);
    expect(b["bookkeeping"]).toEqual([{ family: "gap-check-supply", asked: true }]);
  });

  it("[CONTROL] check-supply due: fired once through FAMILY_RESOLVERS as before (pending, unsettled), and not asked for its bookkeeping again", async () => {
    registry = [supplyRhythm(40)];
    expect(conductor.rhythmDueScore((registry[0]!["body"]) as never, registry[0]!["updated_at"]).due_score).toBeGreaterThan(1);
    const b = await pass();
    expect(dispatchCalls()).toEqual([{ type: "gap_check_supply_tick", settled_by: "report" }]);
    expect(bookkeepingCalls().length).toBe(0);
    expect(((b["enqueued"] ?? []) as Row[]).some((e) => e["family"] === "gap-check-supply" && e["settlement"] === "pending")).toBe(true);
    expect(rhythmWrites.filter((w) => w["id"] === "rhythm-gap-check-supply").length).toBe(0);
  });

  it("[CONTROL] a paused family is not asked at all", async () => {
    registry = [supplyRhythm(7.3, { operator_pause: { by: "operator", reason: "hold" } })];
    await pass();
    expect(pointers.filter((p) => p["type"] === "gap_check_supply_tick").length).toBe(0);
  });
});
