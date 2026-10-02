/**
 * goal_reach_tick — the goal-reach SEAM (slice R: R1 observe, R4 wait, R5 re-dispatch, R6 stop,
 * R7 learn). Pure functions plus a tick driven through an injected I/O, so nothing here binds a
 * port, reads the live pool or the live gap store, or touches the network.
 *
 * The load-bearing contracts, each pinned below:
 *   - linkage is ONLY a structured `{source:"goal_reach", goal_hash, ...}` demand_goals entry;
 *   - a goal is re-dispatched only when EVERY linked gap is closed, at least one was linked, and a
 *     closure is newer than the last attempt;
 *   - futility (a repeated break signature) and budget (cycles, known cost) stop the loop;
 *   - operator_hands is three-valued and only "false" is success — a hand-closed gap, an
 *     operator-filed/armed prerequisite, or ANY re-dispatch R did not issue is hands;
 *   - a non-autonomous goal whose earlier attempt landed a write is asked of its human, never
 *     silently re-run;
 *   - R's own dispatch never carries `operator` (goal-host reads that as trigger "operator").
 */
import { describe, expect, it } from "bun:test";
import {
  goalHashOf,
  dispatchGoalHash,
  originOf,
  observe,
  linkGaps,
  nextAction,
  operatorHands,
  onReached,
  isRIssued,
  isWriteEffectShape,
  summarize,
  runGoalReachTick,
  mergeDemandGoal,
  DEFAULT_GOAL_REACH_POLICY,
  type GoalReachRecord,
  type DispatchObservation,
  type GapView,
  type LandingView,
  type GoalReachIO,
  type GoalReachPolicy,
} from "../../src/resolvers/goal-reach-tick.js";

const T0 = Date.parse("2026-10-02T10:00:00Z");
const min = (n: number): number => T0 + n * 60_000;
const GOAL = "Summarise today's top three technology headlines with sources";
const H = goalHashOf(GOAL);

function d(over: Partial<DispatchObservation> & { dispatchId: string }): DispatchObservation {
  return {
    goal: GOAL, status: "failed", reached: false, operator: null, trigger: "boredom",
    startedAt: min(0), endedAt: min(1), node: "http://node-a/resolve", goalReachReason: "judged_hollow: no sources cited",
    poolShapes: [], completionShapes: null, cost_usd: 0.1,
    ...over,
  };
}
const link = (dispatch_id: string, goal_hash = H) => ({ source: "goal_reach" as const, goal_hash, dispatch_id, origin: "autonomous" as const });
function gap(over: Partial<GapView> & { id: string }): GapView {
  return { status: "open", source: "substrate_detected", demand_goals: [link("d1")], ...over };
}
const policy: GoalReachPolicy = { ...DEFAULT_GOAL_REACH_POLICY, max_cycles: 3, max_cost_usd: 1 };

/** A record observed from one failed dispatch, then linked to `gaps`. */
function recordWith(gaps: GapView[], dispatches: DispatchObservation[] = [d({ dispatchId: "d1" })]): GoalReachRecord {
  const recs = observe({}, dispatches, min(5));
  const r = recs[H]!;
  linkGaps(r, gaps);
  return r;
}

describe("goal hash — mirrors goal-host goalHashOf exactly", () => {
  it("coalesces case, whitespace runs, line wraps and trailing punctuation", () => {
    const base = goalHashOf("Produce a vessel health report for the fleet");
    expect(goalHashOf("produce  a vessel\nhealth report for the fleet.")).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{8}$/);
  });
  it("matches a known FNV-1a value (pinned so a drift from goal-host is caught)", () => {
    // FNV-1a 32 of "" is the offset basis 0x811c9dc5; of "a" is 0xe40c292c.
    expect(goalHashOf("")).toBe("811c9dc5");
    expect(goalHashOf("A")).toBe("e40c292c");
  });
  it("prefers a goal_hash the record carries over recomputing", () => {
    expect(dispatchGoalHash(d({ dispatchId: "x", goal_hash: "deadbeef" }))).toBe("deadbeef");
  });
  it("refuses to hash a goal activeDispatches may have TRUNCATED at 200 chars", () => {
    const long = "x".repeat(200);
    expect(dispatchGoalHash(d({ dispatchId: "x", goal: long }))).toBeNull();
    expect(dispatchGoalHash(d({ dispatchId: "x", goal: long, goal_full: true }))).toBe(goalHashOf(long));
  });
});

describe("origin", () => {
  it("no operator is autonomous; a note-triggered dispatch is surface; an operator id is operator", () => {
    expect(originOf(d({ dispatchId: "a" }))).toBe("autonomous");
    expect(originOf(d({ dispatchId: "a", trigger: "note" }))).toBe("surface");
    expect(originOf(d({ dispatchId: "a", operator: "obsidian:avi-vault", trigger: "operator" }))).toBe("surface");
    expect(originOf(d({ dispatchId: "a", operator: "operator:claude-code", trigger: "operator" }))).toBe("operator");
  });
});

describe("observe (R1)", () => {
  it("opens a record for a non-reached terminal dispatch and ignores a goal that reached first time", () => {
    const recs = observe({}, [d({ dispatchId: "d1" }), d({ dispatchId: "ok", goal: "a different goal", reached: true, status: "completed" })], min(5));
    expect(Object.keys(recs)).toEqual([H]);
    expect(recs[H]!.status).toBe("open");
    expect(recs[H]!.break_signatures).toHaveLength(1);
    expect(recs[H]!.cost_usd).toBeCloseTo(0.1);
  });
  it("an ungraded terminal dispatch (reached:null) opens the record but contributes NO break signature", () => {
    const recs = observe({}, [d({ dispatchId: "d1", reached: null, status: "completed" })], min(5));
    expect(recs[H]!.status).toBe("open");
    expect(recs[H]!.break_signatures).toEqual([]);
  });
  it("a later reached dispatch marks the record reached and records its node", () => {
    let recs = observe({}, [d({ dispatchId: "d1" })], min(5));
    recs[H]!.r_issued.push("d2");
    recs = observe(recs, [d({ dispatchId: "d2", trigger: "goal_reach", status: "completed", reached: true, startedAt: min(10), endedAt: min(12), node: "http://node-b/resolve" })], min(13));
    expect(recs[H]!.status).toBe("reached");
    expect(recs[H]!.reached_nodes).toEqual(["http://node-b/resolve"]);
    expect(recs[H]!.reached_dispatch_id).toBe("d2");
  });
  it("is idempotent: observing the same dispatch twice does not double-count cost or signatures", () => {
    let recs = observe({}, [d({ dispatchId: "d1" })], min(5));
    recs = observe(recs, [d({ dispatchId: "d1" })], min(6));
    expect(recs[H]!.dispatches).toHaveLength(1);
    expect(recs[H]!.break_signatures).toHaveLength(1);
    expect(recs[H]!.cost_usd).toBeCloseTo(0.1);
  });
  it("cost is known only when every terminal dispatch carried one", () => {
    const recs = observe({}, [d({ dispatchId: "d1", cost_usd: null })], min(5));
    expect(recs[H]!.cost_known).toBe(false);
  });
});

describe("linkGaps — linkage only via structured goal_reach demand_goals", () => {
  it("a legacy string entry holding the goal text is NOT linkage", () => {
    const r = recordWith([gap({ id: "g-legacy", demand_goals: [GOAL, H] })]);
    expect(r.linked).toEqual([]);
    expect(r.waiting_on).toEqual([]);
    expect(r.status).toBe("open");
  });
  it("an object entry without source:goal_reach is NOT linkage", () => {
    const r = recordWith([gap({ id: "g-foreign", demand_goals: [{ goal_hash: H, dispatch_id: "d1" }] })]);
    expect(r.linked).toEqual([]);
  });
  it("a goal_reach entry for ANOTHER goal_hash is not linkage", () => {
    const r = recordWith([gap({ id: "g-other", demand_goals: [link("d9", "0badc0de")] })]);
    expect(r.linked).toEqual([]);
  });
  it("a goal_reach entry links; an open linked gap parks the goal as waiting", () => {
    const r = recordWith([gap({ id: "g1" }), gap({ id: "g2", status: "closed", closed_reason: "landed_verified", closed_at: new Date(min(3)).toISOString() })]);
    expect(r.linked.sort()).toEqual(["g1", "g2"]);
    expect(r.waiting_on).toEqual(["g1"]);
    expect(r.status).toBe("waiting");
  });
});

describe("nextAction — waiting → redispatch only when ALL linked gaps are closed", () => {
  const closed = (id: string, at = min(3), reason = "landed_verified") => gap({ id, status: "closed", closed_reason: reason, closed_at: new Date(at).toISOString() });
  it("waits while any linked gap is open", () => {
    const gaps = [gap({ id: "g1" }), closed("g2")];
    const r = recordWith(gaps);
    expect(nextAction(r, gaps, policy).kind).toBe("wait");
  });
  it("redispatches once every linked gap is closed after the last attempt", () => {
    const gaps = [closed("g1"), closed("g2")];
    const r = recordWith(gaps);
    const a = nextAction(r, gaps, policy);
    expect(a.kind).toBe("redispatch");
  });
  it("never redispatches with ZERO linked gaps (unlinked failure is R2's, not a blind retry)", () => {
    const r = recordWith([]);
    const a = nextAction(r, [], policy);
    expect(a.kind).toBe("none");
    expect((a as { reason: string }).reason).toBe("unlinked");
  });
  it("does not redispatch again when no linked gap closed since the last attempt", () => {
    const gaps = [closed("g1", min(-5))];
    const r = recordWith(gaps);
    const a = nextAction(r, gaps, policy);
    expect(a.kind).toBe("none");
    expect((a as { reason: string }).reason).toBe("no_new_closure");
  });
  it("does nothing while a dispatch for the goal is still running", () => {
    const gaps = [closed("g1")];
    const r = recordWith(gaps, [d({ dispatchId: "d1" }), d({ dispatchId: "d2", status: "running", reached: null, startedAt: min(4), endedAt: null })]);
    expect(nextAction(r, gaps, policy).kind).toBe("none");
  });
});

describe("nextAction — stops (R6)", () => {
  const closed = (id: string) => gap({ id, status: "closed", closed_reason: "landed_verified", closed_at: new Date(min(30)).toISOString() });
  it("futility: an R cycle that hits the same break signature again stops the goal", () => {
    const gaps = [closed("g1")];
    const r = recordWith(gaps, [d({ dispatchId: "d1" }), d({ dispatchId: "d2", trigger: "goal_reach", startedAt: min(10), endedAt: min(11) })]);
    const a = nextAction(r, gaps, policy);
    expect(a.kind).toBe("stop");
    expect((a as { reason: string }).reason).toMatch(/^futile:/);
  });
  it("the same break twice BEFORE any R cycle is not futility (no prerequisite was tried yet)", () => {
    const gaps = [closed("g1")];
    const r = recordWith(gaps, [d({ dispatchId: "d1" }), d({ dispatchId: "d2", startedAt: min(1), endedAt: min(2) })]);
    expect(nextAction(r, gaps, policy).kind).toBe("redispatch");
  });
  it("volatile ids in the reason do not make two identical breaks look distinct", () => {
    const gaps = [closed("g1")];
    const r = recordWith(gaps, [
      d({ dispatchId: "d1", goalReachReason: "hollow via exec 3f2a9c1e-0b1d-4c55-9a77-0123456789ab" }),
      d({ dispatchId: "d2", trigger: "goal_reach", startedAt: min(10), endedAt: min(11), goalReachReason: "hollow via exec 9d0e1f2a-0b1d-4c55-9a77-ba9876543210" }),
    ]);
    expect(nextAction(r, gaps, policy).kind).toBe("stop");
  });
  it("two DIFFERENT breaks are progress, not futility", () => {
    const gaps = [closed("g1")];
    const r = recordWith(gaps, [d({ dispatchId: "d1" }), d({ dispatchId: "d2", trigger: "goal_reach", startedAt: min(10), endedAt: min(11), goalReachReason: "no producer for shape headlineList" })]);
    expect(nextAction(r, gaps, policy).kind).toBe("redispatch");
  });
  it("cycles: R's own re-dispatches are capped", () => {
    const gaps = [closed("g1")];
    const ds = [0, 1, 2, 3].map((i) => d({ dispatchId: `d${i}`, startedAt: min(i * 5), endedAt: min(i * 5 + 1), goalReachReason: `break ${i}`, trigger: i === 0 ? "boredom" : "goal_reach" }));
    const r = recordWith(gaps, ds);
    expect(r.cycles).toBe(3);
    const a = nextAction(r, gaps, policy);
    expect(a.kind).toBe("stop");
    expect((a as { reason: string }).reason).toBe("budget:cycles");
  });
  it("cost: a known total at or over the cap stops", () => {
    const gaps = [closed("g1")];
    const r = recordWith(gaps, [d({ dispatchId: "d1", cost_usd: 1.5 })]);
    expect((nextAction(r, gaps, policy) as { reason: string }).reason).toBe("budget:cost");
  });
  it("blocked_by_scope: an open prerequisite whose edit_site the lane may not land stops with a limit proposal", () => {
    const gaps = [gap({ id: "g1", edit_site: "repos/goal-host-vessel/src/index.ts" })];
    const r = recordWith(gaps);
    const a = nextAction(r, gaps, policy, { scopeExcludes: (p) => (p.endsWith("goal-host-vessel/src/index.ts") ? "goal-host-vessel/src/index.ts" : null) });
    expect(a.kind).toBe("stop");
    expect((a as { reason: string }).reason).toBe("blocked_by_scope:repos/goal-host-vessel/src/index.ts");
    expect((a as { limit_proposal?: { paths: string[] } }).limit_proposal?.paths).toEqual(["repos/goal-host-vessel/src/index.ts"]);
  });
});

describe("write-effect guard — ask the human before re-running a goal that landed writes", () => {
  const closed = gap({ id: "g1", status: "closed", closed_reason: "landed_verified", closed_at: new Date(min(3)).toISOString() });
  it("mirrors goal-host's write classification (isWriteShape ∪ FS_WRITE_SHAPES)", () => {
    for (const s of ["obsidian:write_note", "poolImpulse_write", "fs_edit", "gitCommitResult", "code_replace_lines"]) expect(isWriteEffectShape(s)).toBe(true);
    for (const s of ["webSearchResult", "llm_completion", "writer_notes"]) expect(isWriteEffectShape(s)).toBe(false);
  });
  it("surface-origin goal whose earlier attempt landed a write → ask_human, not redispatch", () => {
    const r = recordWith([closed], [d({ dispatchId: "d1", trigger: "note", poolShapes: ["obsidian:write_note"] })]);
    expect(r.origin).toBe("surface");
    const a = nextAction(r, [closed], policy);
    expect(a.kind).toBe("ask_human");
    expect((a as { write_shapes: string[] }).write_shapes).toEqual(["obsidian:write_note"]);
  });
  it("the same landed write on an autonomous goal is re-dispatched (no human to ask)", () => {
    const r = recordWith([closed], [d({ dispatchId: "d1", poolShapes: ["obsidian:write_note"] })]);
    expect(nextAction(r, [closed], policy).kind).toBe("redispatch");
  });
});

describe("operator_hands — three-valued; only false is success", () => {
  const closedOk = (id: string) => gap({ id, status: "closed", closed_reason: "landed_verified", closed_at: new Date(min(3)).toISOString(), edit_site: "repos/development-vessel/src/resolvers/web-resource.ts" });
  const reachedRecord = (gaps: GapView[], extra: DispatchObservation[] = []): GoalReachRecord => {
    const r = recordWith(gaps, [d({ dispatchId: "d1" }), ...extra]);
    r.r_issued.push("d2");
    const recs = observe({ [H]: r }, [d({ dispatchId: "d2", trigger: "goal_reach", status: "completed", reached: true, startedAt: min(20), endedAt: min(22) })], min(23));
    return recs[H]!;
  };
  it("false: autonomous closes, R-issued re-dispatch, no operator landing on the edit sites", () => {
    const gaps = [closedOk("g1")];
    const r = reachedRecord(gaps);
    expect(operatorHands(r, gaps, []).verdict).toBe("false");
  });
  it("MUST-FAIL: a hand-closed gap does not count as hands-free", () => {
    const gaps = [gap({ id: "g1", status: "closed", closed_at: new Date(min(3)).toISOString() })]; // no closed_reason
    const r = reachedRecord(gaps);
    const h = operatorHands(r, gaps, []);
    expect(h.verdict).toBe("true");
    expect(h.reasons.join(" ")).toMatch(/hand_closed:g1/);
  });
  it("MUST-FAIL: human_dropped is a hand close", () => {
    const gaps = [gap({ id: "g1", status: "closed", closed_reason: "human_dropped", closed_at: new Date(min(3)).toISOString() })];
    expect(operatorHands(reachedRecord(gaps), gaps, []).verdict).toBe("true");
  });
  it("MUST-FAIL: an operator-filed / operator-armed prerequisite does not count as hands-free", () => {
    for (const source of ["human_reported", "operator_narration"]) {
      const gaps = [{ ...closedOk("g1"), source }];
      const h = operatorHands(reachedRecord(gaps), gaps, []);
      expect(h.verdict).toBe("true");
      expect(h.reasons.join(" ")).toMatch(/operator_route_gap:g1/);
    }
  });
  it("MUST-FAIL: a re-dispatch not issued by R = hands (operator replay)", () => {
    const gaps = [closedOk("g1")];
    const r = reachedRecord(gaps, [d({ dispatchId: "dx", operator: "operator:claude-code", trigger: "operator", startedAt: min(10), endedAt: min(11), goalReachReason: "other" })]);
    const h = operatorHands(r, gaps, []);
    expect(h.verdict).toBe("true");
    expect(h.reasons.join(" ")).toMatch(/non_r_dispatch:dx/);
  });
  it("MUST-FAIL: a re-dispatch by another autonomous dispatcher is also not R's (qa: any non-R re-dispatch)", () => {
    const gaps = [closedOk("g1")];
    const r = reachedRecord(gaps, [d({ dispatchId: "db", trigger: "boredom", startedAt: min(10), endedAt: min(11), goalReachReason: "other" })]);
    expect(operatorHands(r, gaps, []).verdict).toBe("true");
  });
  it("possible: an operator-route landing touched a prerequisite's edit site between first failure and reach", () => {
    const gaps = [closedOk("g1")];
    const landings: LandingView[] = [{ sha: "abc", at: min(15), route: "operator", files: ["repos/development-vessel/src/resolvers/web-resource.ts"] }];
    const h = operatorHands(reachedRecord(gaps), gaps, landings);
    expect(h.verdict).toBe("possible");
  });
  it("an operator landing OUTSIDE the window or on another file does not make it possible", () => {
    const gaps = [closedOk("g1")];
    const landings: LandingView[] = [
      { sha: "a", at: min(-30), route: "operator", files: ["repos/development-vessel/src/resolvers/web-resource.ts"] },
      { sha: "b", at: min(15), route: "operator", files: ["repos/development-vessel/src/other.ts"] },
      { sha: "c", at: min(15), route: "substrate", files: ["repos/development-vessel/src/resolvers/web-resource.ts"] },
    ];
    expect(operatorHands(reachedRecord(gaps), gaps, landings).verdict).toBe("false");
  });
  it("R-issued is by id or by trigger goal_reach, never by goal text", () => {
    const r = recordWith([]);
    r.r_issued.push("mine");
    expect(isRIssued(r, d({ dispatchId: "mine", trigger: "run-goal" }))).toBe(true);
    expect(isRIssued(r, d({ dispatchId: "other", trigger: "goal_reach" }))).toBe(true);
    expect(isRIssued(r, d({ dispatchId: "other", trigger: "operator", operator: "x" }))).toBe(false);
  });
});

describe("onReached (R7) — learn only from a hands-free reach", () => {
  const base = (): GoalReachRecord => {
    const r = recordWith([]);
    r.status = "reached";
    r.reached_execution_id = "exec-1";
    r.reached_template_id = "activity:news-digest";
    r.hands_final = true;
    return r;
  };
  it("reached + hands false → extract(execution_id)", () => {
    const r = base(); r.operator_hands = "false";
    expect(onReached(r)).toEqual({ kind: "extract", execution_id: "exec-1" });
  });
  it("an UNGRADED reach (hands verdict not taken) → no extract, even though the field reads false", () => {
    const r = base(); r.operator_hands = "false"; r.hands_final = false;
    expect(onReached(r)).toBeNull();
  });
  it("hands possible or true → no extract", () => {
    for (const h of ["possible", "true"] as const) { const r = base(); r.operator_hands = h; expect(onReached(r)).toBeNull(); }
  });
  it("already handed off, or a ribosome-family template → no extract", () => {
    const r = base(); r.operator_hands = "false"; r.extraction = { status: "handed_off" };
    expect(onReached(r)).toBeNull();
    const r2 = base(); r2.operator_hands = "false"; r2.reached_template_id = "learned-news-digest";
    expect(onReached(r2)).toBeNull();
  });
});

describe("mergeDemandGoal — idempotent array-merge append that keeps legacy entries", () => {
  it("appends, is idempotent, and keeps legacy strings in place", () => {
    const once = mergeDemandGoal(["goal text A"], link("d1"));
    expect(once).toEqual(["goal text A", link("d1")]);
    expect(mergeDemandGoal(once, link("d1"))).toEqual(once);
  });
  it("two concurrent-style merges onto the same base keep both when applied in sequence under a lock", () => {
    const base = ["goal text A"];
    const a = link("d1"); const b = { ...link("d2"), goal_hash: "0badc0de" };
    const merged = mergeDemandGoal(mergeDemandGoal(base, a), b);
    expect(merged).toEqual(["goal text A", a, b]);
    expect(mergeDemandGoal(mergeDemandGoal(base, b), a)).toHaveLength(3);
  });
  it("the existing consumer's view is unchanged by a goal_reach append (goal-host fileCapabilityGap reader, mirrored)", () => {
    // goal-host-vessel src/index.ts fileCapabilityGap (origin/dev acf4922), verbatim:
    //   priorGoals = Array.isArray(dg) ? dg.filter((x): x is string => typeof x === "string") : ...
    const reader = (dg: unknown[]): string[] => dg.filter((x): x is string => typeof x === "string");
    const legacy = ["goal one", "goal two"];
    const after = mergeDemandGoal(legacy, link("d1"));
    expect(reader(after)).toEqual(reader(legacy));
    expect(reader(after).length >= 2).toBe(reader(legacy).length >= 2); // the 2-goal minting floor
  });
});

describe("runGoalReachTick — the seam end to end over an injected I/O", () => {
  function fakeIO(over: Partial<GoalReachIO> & { dispatches: DispatchObservation[]; gaps: GapView[] }): GoalReachIO & { calls: Array<{ op: string; args: unknown }>; store: Record<string, GoalReachRecord> } {
    const calls: Array<{ op: string; args: unknown }> = [];
    const store: Record<string, GoalReachRecord> = {};
    return {
      calls, store,
      listDispatches: async () => ({ ok: true, dispatches: over.dispatches }),
      readGaps: async () => ({ ok: true, gaps: over.gaps }),
      readLandings: async () => ({ ok: true, landings: [] }),
      scopeExcludes: async () => () => null,
      loadRecords: async () => ({ ...store }),
      saveRecord: async (r) => { store[r.goal_hash] = JSON.parse(JSON.stringify(r)); calls.push({ op: "save", args: r.goal_hash }); },
      dispatchGoal: async (req) => { calls.push({ op: "dispatch", args: req }); return { ok: true, dispatch_id: "r-1", coalesced: false }; },
      handOffExtraction: async (req) => { calls.push({ op: "extract", args: req }); return { ok: true, dispatch_id: "x-1" }; },
      fileLimitProposal: async (p) => { calls.push({ op: "limit", args: p }); return { ok: true }; },
      ...over,
    };
  }
  const closedGap = gap({ id: "g1", status: "closed", closed_reason: "landed_verified", closed_at: new Date(min(3)).toISOString() });

  it("re-dispatches through goalDispatchAsync tagged dispatcher_reason:goal_reach — and NEVER sets operator", async () => {
    const io = fakeIO({ dispatches: [d({ dispatchId: "d1" })], gaps: [closedGap] });
    const out = await runGoalReachTick(io, policy, min(5));
    const disp = io.calls.find((c) => c.op === "dispatch")!.args as { goal: string; tags: string[]; operator?: unknown };
    expect(disp.goal).toBe(GOAL);
    expect(disp.tags).toContain("dispatcher_reason:goal_reach");
    expect(disp.tags).toContain(`goal_reach:${H}`);
    expect("operator" in disp).toBe(false);
    expect(io.store[H]!.r_issued).toEqual(["r-1"]);
    expect(io.store[H]!.status).toBe("redispatching");
    expect(out.redispatched).toEqual([{ goal_hash: H, dispatch_id: "r-1" }]);
  });
  it("a coalesced answer (goal-host returned an already-running dispatch) is NOT recorded as R's", async () => {
    const io = fakeIO({ dispatches: [d({ dispatchId: "d1" })], gaps: [closedGap], dispatchGoal: async () => ({ ok: true, dispatch_id: "someone-elses", coalesced: true }) });
    const out = await runGoalReachTick(io, policy, min(5));
    expect(io.store[H]!.r_issued).toEqual([]);
    expect(out.redispatched).toEqual([]);
  });
  it("a failed dispatch call is recorded honestly and does not throw", async () => {
    const io = fakeIO({ dispatches: [d({ dispatchId: "d1" })], gaps: [closedGap], dispatchGoal: async () => ({ ok: false, why: "no own goalDispatchAsync producer" }) });
    const out = await runGoalReachTick(io, policy, min(5));
    expect(out.errors.join(" ")).toMatch(/no own goalDispatchAsync producer/);
    expect(io.store[H]!.r_issued).toEqual([]);
  });
  it("on a hands-free reach, hands off extraction once; a failed hand-off is recorded, not thrown", async () => {
    const io = fakeIO({ dispatches: [d({ dispatchId: "d1" })], gaps: [closedGap] });
    await runGoalReachTick(io, policy, min(5));
    const reachedD = d({ dispatchId: "r-1", trigger: "goal_reach", status: "completed", reached: true, startedAt: min(6), endedAt: min(8), executionId: "exec-9", selectedTemplateId: "activity:digest" });
    const io2 = fakeIO({ dispatches: [d({ dispatchId: "d1" }), reachedD], gaps: [closedGap], handOffExtraction: async () => { throw new Error("goal-host 503"); } });
    Object.assign(io2.store, io.store);
    const out = await runGoalReachTick(io2, policy, min(9));
    const r = io2.store[H]!;
    expect(r.status).toBe("reached");
    expect(r.operator_hands).toBe("false");
    expect(r.extraction.status).toBe("failed");
    expect(r.extraction.reason).toMatch(/goal-host 503/);
    expect(out.summary.reached_hands_free).toBe(1);
  });
  it("blocked_by_scope stop files a limit proposal once", async () => {
    const g = gap({ id: "g1", edit_site: "repos/goal-host-vessel/src/index.ts" });
    const io = fakeIO({ dispatches: [d({ dispatchId: "d1" })], gaps: [g], scopeExcludes: async () => (p: string) => (p.includes("goal-host-vessel/src/index.ts") ? "goal-host-vessel/src/index.ts" : null) });
    await runGoalReachTick(io, policy, min(5));
    await runGoalReachTick(io, policy, min(6));
    expect(io.store[H]!.status).toBe("stopped");
    expect(io.calls.filter((c) => c.op === "limit")).toHaveLength(1);
  });
  it("an unreadable dispatch list is a failed tick, not an empty one", async () => {
    const io = fakeIO({ dispatches: [], gaps: [], listDispatches: async () => ({ ok: false, why: "activeDispatches unreadable" }) });
    const out = await runGoalReachTick(io, policy, min(5));
    expect(out.ok).toBe(false);
  });
  it("summary carries the counts the caller condition selects on", async () => {
    const io = fakeIO({ dispatches: [d({ dispatchId: "d1" })], gaps: [] });
    const out = await runGoalReachTick(io, policy, min(5));
    expect(out.summary).toMatchObject({ goals: 1, open_unlinked: 1, waiting: 0, redispatching: 0, reached_hands_free: 0 });
    expect(summarize(Object.values(io.store)).open_unlinked).toBe(1);
  });
});
