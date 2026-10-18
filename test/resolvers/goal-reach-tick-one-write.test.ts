/**
 * goal_reach_tick writes its records ONCE per tick, through the real I/O seam over a real pool file.
 *
 * WHY. Each record write used to be its own synchronous load+rewrite of the WHOLE pool file. With a pool of ~21k
 * impulses (~22 MB) and ~240 tracked goals, one tick blocked the vessel's event loop for 48-131 s, so /health missed
 * the self-recovery probe's window and the vessel was restarted about hourly. Pinned here, on a pool of the same size:
 *   - [MUST-FAIL] N changed records are persisted in ONE pool write, each stamped with the tick's updated_at;
 *   - [MUST-FAIL] an unchanged record is not rewritten (a bare updated_at / last_action.at bump is not a change);
 *   - [MUST-FAIL] a 100 ms heartbeat never stalls more than 2 s during a tick;
 *   - [GUARD] a tick cut by a throw right after a REACHED transition still persists it, so the next tick does not
 *     decide (and log) the same REACHED again;
 *   - [CONTROL] a record that did change is still persisted; a dry run writes nothing.
 * Only the network-facing I/O methods are faked; loadRecords/saveRecord(s) are the default I/O's own.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setPoolFileForTests, resolvePoolImpulse } from "../../src/resolvers/pool-impulse.js";
import * as grt from "../../src/resolvers/goal-reach-tick.js";
import {
  DEFAULT_GOAL_REACH_POLICY,
  defaultGoalReachIO,
  goalHashOf,
  runGoalReachTick,
  type DispatchObservation,
  type GapView,
  type GoalReachIO,
  type GoalReachPolicy,
  type GoalReachRecord,
} from "../../src/resolvers/goal-reach-tick.js";

const FILLER = 20_000;
const N = 150;
const T0 = Date.parse("2026-10-18T00:00:00Z");
const min = (n: number): number => T0 + n * 60_000;
const policy: GoalReachPolicy = { ...DEFAULT_GOAL_REACH_POLICY, dry_run: false, max_cycles: 3, max_cost_usd: 1 };
const goal = (i: number): string => `Report the state of fixture subsystem number ${i} with evidence`;

let base = "";
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "grt-one-write-"));
  mkdirSync(join(base, "pool"), { recursive: true });
  const file = join(base, "pool", "standing.json");
  const at = new Date(T0 - 86_400_000).toISOString();
  const rows = Array.from({ length: FILLER }, (_, i) => ({
    id: `filler:${i}`, shape: "fixtureFiller", body: { i, note: "x".repeat(900) }, source: "test", status: "open", injected_at: at, updated_at: at,
  }));
  writeFileSync(file, JSON.stringify(rows, null, 2));
  __setPoolFileForTests(file);
});
afterEach(() => {
  __setPoolFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

function failed(i: number, over: Partial<DispatchObservation> = {}): DispatchObservation {
  return {
    dispatchId: `d-${i}`, goal: goal(i), goal_full: true, status: "failed", reached: false, operator: null, trigger: "boredom",
    startedAt: min(0), endedAt: min(1), node: "http://goal-host/resolve", goalReachReason: "judged_hollow: no evidence",
    poolShapes: [], completionShapes: null, cost_usd: 0, ...over,
  };
}

/** The default I/O's own record load/save (counted), with every network-facing method faked. */
function seamIO(dispatches: DispatchObservation[], gaps: GapView[], over: Partial<GoalReachIO> = {}): { io: GoalReachIO; writes: () => number } {
  const real = defaultGoalReachIO(policy) as GoalReachIO & { saveRecords?: (recs: GoalReachRecord[]) => Promise<unknown> };
  let writes = 0;
  const io: Record<string, unknown> = {
    listDispatches: async () => ({ ok: true, dispatches }),
    readGaps: async () => ({ ok: true, gaps }),
    readLandings: async () => ({ ok: true, landings: [] }),
    scopeExcludes: async () => () => null,
    loadRecords: () => real.loadRecords(),
    saveRecord: async (r: GoalReachRecord) => { writes++; return real.saveRecord(r); },
    dispatchGoal: async () => ({ ok: false, why: "test: no goal-host" }),
    readTemplatesSince: async () => ({ ok: true, templates: [] }),
    attachExtractionEvidence: async () => ({ ok: true }),
    fileLimitProposal: async () => ({ ok: true }),
    ...over,
  };
  if (typeof real.saveRecords === "function") io["saveRecords"] = async (recs: GoalReachRecord[]) => { writes++; return real.saveRecords!(recs); };
  return { io: io as unknown as GoalReachIO, writes: () => writes };
}

const stored = (): Map<string, GoalReachRecord> =>
  new Map(resolvePoolImpulse({ type: "poolImpulse", shape: "goalReach", status: "open" }).body.impulses.map((imp) => {
    const r = imp.body as GoalReachRecord;
    return [r.goal_hash, r] as const;
  }));

describe("goal_reach_tick persists its records in one pool write per tick", () => {
  it("[MUST-FAIL] N new records land in ONE pool write, every one stamped with the tick's updated_at", async () => {
    const dispatches = Array.from({ length: N }, (_, i) => failed(i));
    const { io, writes } = seamIO(dispatches, []);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    let out;
    try { out = await runGoalReachTick(io, policy, min(5)); } finally { console.log = orig; }
    expect(out.errors).toEqual([]);
    expect(writes()).toBe(1);
    // The one rewrite is attributable from the log: one line, naming the writer and the count.
    expect(lines.filter((l) => l.startsWith("[pool-impulse] batch write:"))).toEqual([`[pool-impulse] batch write: ${N} impulse(s) from goal_reach_tick`]);
    const s = stored();
    expect(s.size).toBe(N);
    for (let i = 0; i < N; i++) expect(s.get(goalHashOf(goal(i)))?.updated_at).toBe(min(5));
    expect(resolvePoolImpulse({ type: "poolImpulse", shape: "fixtureFiller", status: "open" }).body.count).toBe(FILLER); // nothing else lost
  }, 120_000);

  it("[MUST-FAIL] a tick that changes nothing rewrites nothing; a changed record is still persisted (control)", async () => {
    const dispatches = Array.from({ length: N }, (_, i) => failed(i));
    await runGoalReachTick(seamIO(dispatches, []).io, policy, min(5));
    // Same observations, a later tick: every record re-decides the same action. A bare stamp bump is no change.
    const again = seamIO(dispatches, []);
    await runGoalReachTick(again.io, policy, min(6));
    expect(again.writes()).toBe(0);
    for (const r of stored().values()) expect(r.updated_at).toBe(min(5));
    // CONTROL: one goal gets a new attempt; exactly that record changes, and it is persisted.
    const more = seamIO([...dispatches, failed(0, { dispatchId: "d-0b", startedAt: min(7), endedAt: min(8), goalReachReason: "judged_hollow: other" })], []);
    await runGoalReachTick(more.io, policy, min(9));
    expect(more.writes()).toBe(1);
    const s = stored();
    expect(s.get(goalHashOf(goal(0)))?.dispatches.map((e) => e.dispatchId)).toEqual(["d-0", "d-0b"]);
    expect(s.get(goalHashOf(goal(0)))?.updated_at).toBe(min(9));
    expect(s.get(goalHashOf(goal(1)))?.updated_at).toBe(min(5));
  }, 180_000);

  it("[MUST-FAIL] a 100 ms heartbeat never stalls more than 2 s while a tick writes N records into a ~20k-impulse pool", async () => {
    const dispatches = Array.from({ length: N }, (_, i) => failed(i));
    const { io } = seamIO(dispatches, []);
    let last = Date.now();
    let maxGap = 0;
    const beat = setInterval(() => { const t = Date.now(); maxGap = Math.max(maxGap, t - last); last = t; }, 100);
    try {
      await runGoalReachTick(io, policy, min(5));
    } finally { clearInterval(beat); }
    maxGap = Math.max(maxGap, Date.now() - last);
    console.log(`[test] heartbeat max gap during the tick: ${maxGap} ms`);
    expect(stored().size).toBe(N);
    expect(maxGap).toBeLessThan(2_000);
  }, 120_000);

  it("[GUARD] a tick cut by a throw right after a REACHED transition persists it, so the next tick does not REACH again", async () => {
    const g1 = goal(1), g2 = goal(2);
    const first = [failed(1), failed(2)];
    // Seed both records with goal 1's row the newer, so the store lists (and the tick walks) goal 1 first.
    const recs = grt.observe({}, first, min(5), policy);
    const file = join(base, "pool", "standing.json");
    const rows = JSON.parse(readFileSync(file, "utf8")) as unknown[];
    for (const [g, at] of [[g2, min(5)], [g1, min(5) + 1000]] as const) {
      const h = goalHashOf(g);
      rows.push({ id: `goalReach:${h}`, shape: "goalReach", body: recs[h], source: "goal_reach_tick", status: "open", injected_at: new Date(at).toISOString(), updated_at: new Date(at).toISOString() });
    }
    writeFileSync(file, JSON.stringify(rows, null, 2));
    expect(Object.keys(await defaultGoalReachIO(policy).loadRecords())).toEqual([goalHashOf(g1), goalHashOf(g2)]);
    const reached = failed(1, { dispatchId: "r-1", status: "completed", reached: true, startedAt: min(6), endedAt: min(7), goalReachReason: null, executionId: "exec-1" });
    const openGap: GapView = { id: "gap-2", status: "open", source: "substrate_detected", edit_site: "repos/fixture-vessel/src/x.ts", demand_goals: [{ source: "goal_reach", goal_hash: goalHashOf(g2), dispatch_id: "d-2", origin: "autonomous" }] };
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      // The scope check throws on goal 2, AFTER goal 1 (first in the records) made its REACHED transition.
      const cut = seamIO([...first, reached], [openGap], { scopeExcludes: async () => () => { throw new Error("simulated cut"); } });
      await expect(runGoalReachTick(cut.io, policy, min(8))).rejects.toThrow("simulated cut");
      const after = stored().get(goalHashOf(g1));
      expect(after?.status).toBe("reached");
      expect(after?.attribution_final).toBe(true);
      await runGoalReachTick(seamIO([...first, reached], [openGap]).io, policy, min(9));
    } finally { console.log = orig; }
    expect(lines.filter((l) => l.includes(`[goal-reach] REACHED goal_hash=${goalHashOf(g1)}`))).toHaveLength(1);
  }, 120_000);

  it("[CONTROL] a dry run writes nothing through the batch path either", async () => {
    const dispatches = Array.from({ length: 3 }, (_, i) => failed(i));
    const { io } = seamIO(dispatches, []);
    await runGoalReachTick(grt.dryRunIO(io), policy, min(5));
    expect(stored().size).toBe(0);
  }, 60_000);
});
