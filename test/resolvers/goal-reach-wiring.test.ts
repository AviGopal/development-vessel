/**
 * goal_reach_tick WIRING — the caller condition, the effect grade, dry-run, and the template contract.
 *
 * The tick is graded on its EFFECT, one tick late: tick N+1 observes the state tick N acted on and
 * grades N's actions (or would-actions, in dry-run) against it. success = it took a correct action;
 * neutral = nothing was eligible (no posterior); failure = an action the next tick contradicts, a
 * missed eligible goal, or an error. Pure functions over injected state: no port, no live pool.
 */
import { describe, expect, it } from "bun:test";
import {
  goalHashOf,
  observe,
  linkGaps,
  attributeReach,
  originOf,
  isHumanOperatorId,
  tickEligibility,
  gradeTick,
  runGoalReachTick,
  carryGrade,
  DEFAULT_GOAL_REACH_POLICY,
  type GoalReachRecord,
  type DispatchObservation,
  type GapView,
  type GoalReachIO,
  type GoalReachPolicy,
  type TickLedger,
} from "../../src/resolvers/goal-reach-tick.js";

const T0 = Date.parse("2026-10-02T10:00:00Z");
const min = (n: number): number => T0 + n * 60_000;
const GOAL = "Summarise today's top three technology headlines with sources";
const H = goalHashOf(GOAL);
const d = (over: Partial<DispatchObservation> & { dispatchId: string }): DispatchObservation => ({
  goal: GOAL, status: "failed", reached: false, operator: null, trigger: "boredom",
  startedAt: min(0), endedAt: min(1), node: "n", goalReachReason: "judged_hollow", poolShapes: [], completionShapes: null, cost_usd: 0.1, ...over,
});
const link = (dispatch_id: string, goal_hash = H) => ({ source: "goal_reach" as const, goal_hash, dispatch_id, origin: "autonomous" as const });
const gap = (over: Partial<GapView> & { id: string }): GapView => ({ status: "open", source: "substrate_detected", demand_goals: [link("d1")], ...over });
const closed = (id: string, at = min(3)): GapView => gap({ id, status: "closed", closed_reason: "landed_verified", closed_at: new Date(at).toISOString(), reopen_count: 0 });
const policy: GoalReachPolicy = { ...DEFAULT_GOAL_REACH_POLICY, max_cycles: 3, dry_run: false };
const recordsFrom = (ds: DispatchObservation[], gaps: GapView[], now = min(5)): GoalReachRecord[] => {
  const recs = Object.values(observe({}, ds, now));
  for (const r of recs) linkGaps(r, gaps);
  return recs;
};

describe("machine dispatchers are not hands", () => {
  it("the rhythm conductor's drain, the liveness probe and substrate-status are machine ids", () => {
    for (const op of ["rhythm-conductor-drain", "learning-liveness-probe", "substrate-status"]) expect(isHumanOperatorId(op)).toBe(false);
    for (const op of ["human-surface", "claude-code-operator", "codex-operator", "obsidian:avi-vault"]) expect(isHumanOperatorId(op)).toBe(true);
    expect(originOf({ operator: "rhythm-conductor-drain", trigger: "operator" })).toBe("autonomous");
    expect(originOf({ operator: "human-surface", trigger: "operator" })).toBe("surface");
  });
  it("MUST-FAIL: a rhythm-conductor-drain re-run reaching the goal is autonomous_other, not hands", () => {
    const gaps = [closed("g1")];
    const recs = observe({}, [d({ dispatchId: "d1" })], min(5));
    linkGaps(recs[H]!, gaps);
    const after = observe(recs, [d({ dispatchId: "d2", operator: "rhythm-conductor-drain", trigger: "operator", status: "completed", reached: true, startedAt: min(20), endedAt: min(21) })], min(22));
    expect(attributeReach(after[H]!, gaps, []).attribution).toBe("autonomous_other");
  });
});

describe("tickEligibility — the caller condition (selects / doesn't select)", () => {
  const P = { ...policy, min_interval_s: 300 };
  it("selects when a non-reached terminal dispatch is in no goalReach record", () => {
    const e = tickEligibility({ records: {}, peek: [{ dispatchId: "d1", status: "failed", reached: false }], last_run_at: null }, min(10), P);
    expect(e.run).toBe(true);
    expect(e.reason).toMatch(/untracked_failures=1/);
  });
  it("does not select when every failure is already tracked and no record needs work", () => {
    const recs = observe({}, [d({ dispatchId: "d1" })], min(5)); // status open, unlinked
    const e = tickEligibility({ records: recs, peek: [{ dispatchId: "d1", status: "failed", reached: false }], last_run_at: null }, min(10), P);
    expect(e.run).toBe(false);
  });
  it("selects for a record that is waiting, redispatching, or a reach whose extraction is still undecided", () => {
    for (const mut of [(r: GoalReachRecord) => { r.status = "waiting"; }, (r: GoalReachRecord) => { r.status = "redispatching"; },
      (r: GoalReachRecord) => { r.status = "reached"; r.attribution_final = true; r.attribution = "r"; r.reached_execution_id = "x"; r.extraction = { status: "pending" }; }]) {
      const recs = observe({}, [d({ dispatchId: "d1" })], min(5));
      mut(recs[H]!);
      expect(tickEligibility({ records: recs, peek: [], last_run_at: null }, min(10), P).run).toBe(true);
    }
  });
  it("ignores running and reached dispatches", () => {
    const e = tickEligibility({ records: {}, peek: [{ dispatchId: "a", status: "running", reached: null }, { dispatchId: "b", status: "completed", reached: true }], last_run_at: null }, min(10), P);
    expect(e.run).toBe(false);
  });
  it("does not select inside min_interval_s even when eligible", () => {
    const e = tickEligibility({ records: {}, peek: [{ dispatchId: "d1", status: "failed", reached: false }], last_run_at: min(10) - 299_000 }, min(10), P);
    expect(e.run).toBe(false);
    expect(e.reason).toMatch(/min_interval/);
    expect(tickEligibility({ records: {}, peek: [{ dispatchId: "d1", status: "failed", reached: false }], last_run_at: min(10) - 301_000 }, min(10), P).run).toBe(true);
  });
});

describe("gradeTick — the effect grade over (this tick's actions, next tick's observed state)", () => {
  const ledger = (over: Partial<TickLedger>): TickLedger => ({ at: min(5), dry_run: false, actions: [], eligible: [], errors: [], ...over });
  it("MUST-FAIL: an idle tick (nothing eligible, nothing done) is NEUTRAL — it earns no alpha", () => {
    expect(gradeTick(ledger({}), { records: [], gaps: [] }).verdict).toBe("neutral");
  });
  it("no previous tick is neutral", () => {
    expect(gradeTick(null, { records: [], gaps: [] }).verdict).toBe("neutral");
  });
  it("success: a re-dispatch made when every linked gap was closed, uncontradicted next tick", () => {
    const g = closed("g1");
    const prev = ledger({ eligible: [H], actions: [{ kind: "redispatch", goal_hash: H, would: false, linked: [{ id: "g1", status: "closed", reopen_count: 0 }] }] });
    expect(gradeTick(prev, { records: recordsFrom([d({ dispatchId: "d1" })], [g]), gaps: [g] }).verdict).toBe("success");
  });
  it("success: a stop with a recorded reason", () => {
    const prev = ledger({ eligible: [H], actions: [{ kind: "stop", goal_hash: H, would: false, reason: "budget:cycles", linked: [] }] });
    expect(gradeTick(prev, { records: [], gaps: [] }).verdict).toBe("success");
  });
  it("MUST-FAIL: a re-dispatch with a linked gap open at action time is failure", () => {
    const prev = ledger({ eligible: [H], actions: [{ kind: "redispatch", goal_hash: H, would: false, linked: [{ id: "g1", status: "closed", reopen_count: 0 }, { id: "g2", status: "open", reopen_count: 0 }] }] });
    const g = grade(prev);
    expect(g.verdict).toBe("failure");
    expect(g.reasons.join(" ")).toMatch(/redispatch_with_open_gap:.*g2/);
  });
  it("MUST-FAIL: a re-dispatch the next tick contradicts (the gap it read as closed is open, not reopened) is failure", () => {
    const prev = ledger({ eligible: [H], actions: [{ kind: "redispatch", goal_hash: H, would: false, linked: [{ id: "g1", status: "closed", reopen_count: 0 }] }] });
    const g1 = gap({ id: "g1", reopen_count: 0 });
    expect(gradeTick(prev, { records: [], gaps: [g1] }).verdict).toBe("failure");
    // a genuine REOPEN after the action is new information, not a contradiction of it
    const reopened = gap({ id: "g1", reopen_count: 1 });
    expect(gradeTick(prev, { records: [], gaps: [reopened] }).verdict).toBe("success");
  });
  it("MUST-FAIL: a tick that missed an eligible re-dispatch is failure (eligible but no action)", () => {
    const prev = ledger({ eligible: [H], actions: [] });
    const g = grade(prev);
    expect(g.verdict).toBe("failure");
    expect(g.reasons.join(" ")).toMatch(/missed_eligible:/);
  });
  it("MUST-FAIL: a goal that WAS eligible at the previous tick per the next tick's state, but the tick did not see it, is failure", () => {
    // every linked gap closed before the previous tick, after the goal's last attempt; the tick did nothing
    const g = closed("g1", min(3));
    const recs = recordsFrom([d({ dispatchId: "d1" })], [g]);
    const prev = ledger({ at: min(5), eligible: [], actions: [] });
    const v = gradeTick(prev, { records: recs, gaps: [g] });
    expect(v.verdict).toBe("failure");
    expect(v.reasons.join(" ")).toMatch(/missed_eligible:/);
  });
  it("MUST-FAIL: a duplicate action on one goal in one tick is failure", () => {
    const a = { kind: "redispatch" as const, goal_hash: H, would: false, linked: [{ id: "g1", status: "closed", reopen_count: 0 }] };
    expect(grade(ledger({ eligible: [H], actions: [a, a] })).verdict).toBe("failure");
  });
  it("MUST-FAIL: a duplicate link on a gap is failure", () => {
    const g = gap({ id: "g1", demand_goals: [link("d1"), link("d1")] });
    expect(gradeTick(ledger({}), { records: [], gaps: [g] }).verdict).toBe("failure");
  });
  it("an error in the previous tick is failure", () => {
    expect(grade(ledger({ errors: ["redispatch x failed: HTTP 500"] })).verdict).toBe("failure");
  });
  it("dry-run would-actions are graded the same way", () => {
    const prev = ledger({ dry_run: true, eligible: [H], actions: [{ kind: "redispatch", goal_hash: H, would: true, linked: [{ id: "g2", status: "open", reopen_count: 0 }] }] });
    expect(grade(prev).verdict).toBe("failure");
  });
  function grade(prev: TickLedger) { return gradeTick(prev, { records: [], gaps: [] }); }
});

describe("carryGrade — the verdict rides on the next execution in the forms the existing grading reads", () => {
  it("failure fails the task (structuredError ⇒ the executor's failed task ⇒ reach:false ⇒ beta)", () => {
    const r = carryGrade({ verdict: "failure", reasons: ["missed_eligible:abc"] }, { summary: {}, actions: [] });
    expect(r.shape).toBe("structuredError");
    expect(JSON.stringify(r.body)).toMatch(/missed_eligible:abc/);
  });
  it("neutral and idle carry information_yield idle and no findings", () => {
    const r = carryGrade({ verdict: "neutral", reasons: [] }, { summary: {}, actions: [] });
    expect(r.shape).toBe("goalReachTickResult");
    expect((r.body as Record<string, unknown>)["information_yield"]).toBe("idle");
    expect((r.body as Record<string, unknown>)["findings"]).toEqual([]);
  });
  it("success carries this tick's actions as findings (light-dispatch's yield reads `findings`)", () => {
    const r = carryGrade({ verdict: "success", reasons: [] }, { summary: {}, actions: [{ kind: "stop", goal_hash: H, would: false, linked: [] }] });
    expect((r.body as Record<string, unknown>)["information_yield"]).toBe("productive");
  });
});

describe("dry-run — the first activation only logs what it WOULD do", () => {
  it("policy defaults: dry_run true, min_interval_s 300", () => {
    expect(DEFAULT_GOAL_REACH_POLICY.dry_run).toBe(true);
    expect(DEFAULT_GOAL_REACH_POLICY.min_interval_s).toBe(300);
  });
  it("a dry-run tick logs DRY-RUN would redispatch and records the would-action in the ledger", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      const g = closed("g1");
      const io: GoalReachIO = {
        listDispatches: async () => ({ ok: true, dispatches: [d({ dispatchId: "d1" })] }),
        readGaps: async () => ({ ok: true, gaps: [g] }),
        readLandings: async () => ({ ok: true, landings: [] }),
        scopeExcludes: async () => () => null,
        loadRecords: async () => ({}),
        saveRecord: async () => {},
        dispatchGoal: async (req) => ({ ok: true, dispatch_id: `dry-run:${req.goal_hash}`, coalesced: false }),
        readTemplatesSince: async () => ({ ok: true, templates: [] }),
        attachExtractionEvidence: async () => ({ ok: true }),
        fileLimitProposal: async () => ({ ok: true }),
      };
      const out = await runGoalReachTick(io, { ...policy, dry_run: true }, min(5));
      expect(lines.some((l) => l.startsWith(`[goal-reach] DRY-RUN would redispatch goal_hash=${H}`))).toBe(true);
      expect(out.ledger.dry_run).toBe(true);
      expect(out.ledger.actions).toEqual([{ kind: "redispatch", goal_hash: H, would: true, linked: [{ id: "g1", status: "closed", reopen_count: 0 }] }]);
      expect(out.ledger.eligible).toEqual([H]);
    } finally { console.log = orig; }
  });
});
