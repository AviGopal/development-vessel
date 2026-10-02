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
  attributeReach,
  extractionStep,
  matchExtractedTemplate,
  needsExtractionCheck,
  appendEvidenceEntry,
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

/** The smallest I/O that replays `dispatches`/`gaps` into `store` (used outside the tick describe). */
function minimalIO(store: Record<string, GoalReachRecord>, dispatches: DispatchObservation[], gaps: GapView[]): GoalReachIO {
  return {
    listDispatches: async () => ({ ok: true, dispatches }),
    readGaps: async () => ({ ok: true, gaps }),
    readLandings: async () => ({ ok: true, landings: [] }),
    scopeExcludes: async () => () => null,
    loadRecords: async () => JSON.parse(JSON.stringify(store)),
    saveRecord: async (r) => { store[r.goal_hash] = JSON.parse(JSON.stringify(r)); },
    dispatchGoal: async () => ({ ok: true, dispatch_id: "r-x", coalesced: false }),
    readTemplatesSince: async () => ({ ok: true, templates: [] }),
    attachExtractionEvidence: async () => ({ ok: true }),
    fileLimitProposal: async () => ({ ok: true }),
  };
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

describe("write-effect guard — ask the goal's ORIGIN before re-running a goal that landed writes", () => {
  const closed = gap({ id: "g1", status: "closed", closed_reason: "landed_verified", closed_at: new Date(min(3)).toISOString() });
  it("mirrors goal-host's write classification (isWriteShape ∪ FS_WRITE_SHAPES)", () => {
    for (const s of ["obsidian:write_note", "poolImpulse_write", "fs_edit", "gitCommitResult", "code_replace_lines"]) expect(isWriteEffectShape(s)).toBe(true);
    for (const s of ["webSearchResult", "llm_completion", "writer_notes"]) expect(isWriteEffectShape(s)).toBe(false);
  });
  it("surface-origin goal with a landed write → ask the surface human, named in the action", () => {
    const r = recordWith([closed], [d({ dispatchId: "d1", operator: "obsidian:avi-vault", trigger: "operator", poolShapes: ["obsidian:write_note"] })]);
    expect(r.origin).toBe("surface");
    const a = nextAction(r, [closed], policy);
    expect(a.kind).toBe("ask_human");
    expect((a as { addressee: string }).addressee).toBe("surface:obsidian:avi-vault");
    expect((a as { write_shapes: string[] }).write_shapes).toEqual(["obsidian:write_note"]);
  });
  it("operator-session goal with a landed write → ask THAT operator id", () => {
    const r = recordWith([closed], [d({ dispatchId: "d1", operator: "operator:claude-code", trigger: "operator", poolShapes: ["fs_edit"] })]);
    expect((nextAction(r, [closed], policy) as { addressee: string }).addressee).toBe("operator:operator:claude-code");
  });
  it("a write that is idempotent by key (upsert by caller id) needs no ask", () => {
    const r = recordWith([closed], [d({ dispatchId: "d1", operator: "operator:claude-code", trigger: "operator", poolShapes: ["memoryNote_write", "poolImpulse_write"] })]);
    expect(nextAction(r, [closed], policy).kind).toBe("redispatch");
  });
  it("the same landed write on an autonomous goal is re-dispatched (no one to ask)", () => {
    const r = recordWith([closed], [d({ dispatchId: "d1", poolShapes: ["obsidian:write_note"] })]);
    expect(nextAction(r, [closed], policy).kind).toBe("redispatch");
  });
  it("the stop reason names the intended addressee (no ask channel yet)", async () => {
    const r = recordWith([closed], [d({ dispatchId: "d1", operator: "operator:claude-code", trigger: "operator", poolShapes: ["fs_edit"] })]);
    const store: Record<string, GoalReachRecord> = { [H]: r };
    const io = minimalIO(store, [d({ dispatchId: "d1", operator: "operator:claude-code", trigger: "operator", poolShapes: ["fs_edit"] })], [closed]);
    await runGoalReachTick(io, policy, min(5));
    expect(store[H]!.status).toBe("stopped");
    expect(store[H]!.stop_reason).toBe("needs_human:ask=operator:operator:claude-code:write_effects:fs_edit");
  });
});

describe("attribution — hands | possible | autonomous_other | r", () => {
  const closedOk = (id: string) => gap({ id, status: "closed", closed_reason: "landed_verified", closed_at: new Date(min(3)).toISOString(), edit_site: "repos/development-vessel/src/resolvers/web-resource.ts" });
  /** Reached on dispatch `by` (default an R-issued re-dispatch) after the first failure d1. */
  const reachedRecord = (gaps: GapView[], extra: DispatchObservation[] = [], by: Partial<DispatchObservation> = { trigger: "goal_reach" }): GoalReachRecord => {
    const r = recordWith(gaps, [d({ dispatchId: "d1" }), ...extra]);
    if (by.trigger === "goal_reach") r.r_issued.push("d2");
    const recs = observe({ [H]: r }, [d({ dispatchId: "d2", status: "completed", reached: true, startedAt: min(20), endedAt: min(22), ...by })], min(23));
    return recs[H]!;
  };
  it("r: R's own re-dispatch reached it, no hands anywhere", () => {
    const gaps = [closedOk("g1")];
    expect(attributeReach(reachedRecord(gaps), gaps, []).attribution).toBe("r");
  });
  it("MUST-FAIL: a boredom re-run reaching it is NOT hands — it is autonomous_other (not credited to R)", () => {
    const gaps = [closedOk("g1")];
    const a = attributeReach(reachedRecord(gaps, [], { trigger: "boredom" }), gaps, []);
    expect(a.attribution).toBe("autonomous_other");
  });
  it("a boredom attempt that failed before R reached it leaves the credit with R", () => {
    const gaps = [closedOk("g1")];
    const r = reachedRecord(gaps, [d({ dispatchId: "db", trigger: "boredom", startedAt: min(10), endedAt: min(11), goalReachReason: "other" })]);
    expect(attributeReach(r, gaps, []).attribution).toBe("r");
  });
  it("MUST-FAIL: an operator replay = hands, even when R's dispatch is the one that reached", () => {
    const gaps = [closedOk("g1")];
    const r = reachedRecord(gaps, [d({ dispatchId: "dx", operator: "operator:claude-code", trigger: "operator", startedAt: min(10), endedAt: min(11), goalReachReason: "other" })]);
    const a = attributeReach(r, gaps, []);
    expect(a.attribution).toBe("hands");
    expect(a.reasons.join(" ")).toMatch(/operator_dispatch:dx/);
  });
  it("MUST-FAIL: an operator dispatch that itself reached = hands", () => {
    const gaps = [closedOk("g1")];
    expect(attributeReach(reachedRecord(gaps, [], { trigger: "operator", operator: "operator:claude-code" }), gaps, []).attribution).toBe("hands");
  });
  it("MUST-FAIL: a surface-human re-dispatch = hands", () => {
    const gaps = [closedOk("g1")];
    expect(attributeReach(reachedRecord(gaps, [], { trigger: "note" }), gaps, []).attribution).toBe("hands");
  });
  it("MUST-FAIL: a hand-closed gap (no autonomous close reason) = hands", () => {
    const gaps = [gap({ id: "g1", status: "closed", closed_at: new Date(min(3)).toISOString() })];
    const a = attributeReach(reachedRecord(gaps), gaps, []);
    expect(a.attribution).toBe("hands");
    expect(a.reasons.join(" ")).toMatch(/hand_closed:g1/);
  });
  it("MUST-FAIL: human_dropped is a hand close", () => {
    const gaps = [gap({ id: "g1", status: "closed", closed_reason: "human_dropped", closed_at: new Date(min(3)).toISOString() })];
    expect(attributeReach(reachedRecord(gaps), gaps, []).attribution).toBe("hands");
  });
  it("MUST-FAIL: an operator-source write / test arming on a linked prerequisite = hands", () => {
    for (const source of ["human_reported", "operator_narration"]) {
      const gaps = [{ ...closedOk("g1"), source }];
      const a = attributeReach(reachedRecord(gaps), gaps, []);
      expect(a.attribution).toBe("hands");
      expect(a.reasons.join(" ")).toMatch(/operator_route_gap:g1/);
    }
  });
  it("MUST-FAIL: an operator-route landing on a prerequisite's edit site in the window = hands", () => {
    const gaps = [closedOk("g1")];
    const landings: LandingView[] = [{ sha: "abc", at: min(15), route: "operator", files: ["repos/development-vessel/src/resolvers/web-resource.ts"] }];
    expect(attributeReach(reachedRecord(gaps), gaps, landings).attribution).toBe("hands");
  });
  it("possible: an UNKNOWN-route landing on an edit site in the window", () => {
    const gaps = [closedOk("g1")];
    const landings: LandingView[] = [{ sha: "abc", at: min(15), route: "unknown", files: ["repos/development-vessel/src/resolvers/web-resource.ts"] }];
    expect(attributeReach(reachedRecord(gaps), gaps, landings).attribution).toBe("possible");
  });
  it("landings outside the window, on another file, or by the substrate route change nothing", () => {
    const gaps = [closedOk("g1")];
    const landings: LandingView[] = [
      { sha: "a", at: min(-30), route: "operator", files: ["repos/development-vessel/src/resolvers/web-resource.ts"] },
      { sha: "b", at: min(15), route: "operator", files: ["repos/development-vessel/src/other.ts"] },
      { sha: "c", at: min(15), route: "substrate", files: ["repos/development-vessel/src/resolvers/web-resource.ts"] },
    ];
    expect(attributeReach(reachedRecord(gaps), gaps, landings).attribution).toBe("r");
  });
  it("R-issued is by id or by trigger goal_reach, never by goal text", () => {
    const r = recordWith([]);
    r.r_issued.push("mine");
    expect(isRIssued(r, d({ dispatchId: "mine", trigger: "run-goal" }))).toBe(true);
    expect(isRIssued(r, d({ dispatchId: "other", trigger: "goal_reach" }))).toBe(true);
    expect(isRIssued(r, d({ dispatchId: "other", trigger: "operator", operator: "x" }))).toBe(false);
  });
});

describe("R7 as a MEASUREMENT — did the reach become a template?", () => {
  const W = DEFAULT_GOAL_REACH_POLICY.extraction_window_ms;
  const base = (attribution: GoalReachRecord["attribution"] = "r"): GoalReachRecord => {
    const r = recordWith([]);
    r.status = "reached"; r.reached_execution_id = "exec-1"; r.reached_at = min(10);
    r.attribution = attribution; r.attribution_final = true;
    return r;
  };
  const tpl = (id: string, meta: Record<string, unknown>, updatedAt = min(12)) => ({ id, updated_at: new Date(updatedAt).toISOString(), ...meta });
  it("provenance matches on extracted_from, metadata.extracted_from or metadata.sourceExecutionId", () => {
    expect(matchExtractedTemplate([tpl("learned-a", { extracted_from: "exec-1" })], "exec-1")).toBe("learned-a");
    expect(matchExtractedTemplate([tpl("learned-b", { metadata: { extracted_from: "exec-1" } })], "exec-1")).toBe("learned-b");
    expect(matchExtractedTemplate([tpl("learned-c", { metadata: { sourceExecutionId: "exec-1" } })], "exec-1")).toBe("learned-c");
    expect(matchExtractedTemplate([tpl("learned-d", { metadata: { extracted_from: "exec-2" } })], "exec-1")).toBeNull();
  });
  it("found → extraction found with the template id", () => {
    const step = extractionStep(base(), { ok: true, templates: [tpl("learned-a", { extracted_from: "exec-1" })] }, min(12), DEFAULT_GOAL_REACH_POLICY);
    expect(step.extraction).toMatchObject({ status: "found" });
    expect(step.extracted_template_id).toBe("learned-a");
    expect(step.file_evidence).toBe(false);
  });
  it("not found inside the window → pending, no verdict yet", () => {
    const step = extractionStep(base(), { ok: true, templates: [] }, min(12), DEFAULT_GOAL_REACH_POLICY);
    expect(step.extraction.status).toBe("pending");
    expect(step.file_evidence).toBe(false);
  });
  it("not found once the window has passed → absent, and evidence is filed", () => {
    const step = extractionStep(base(), { ok: true, templates: [] }, min(10) + W + 1, DEFAULT_GOAL_REACH_POLICY);
    expect(step.extraction.status).toBe("absent");
    expect(step.file_evidence).toBe(true);
  });
  it("MUST-FAIL: an unreadable template store is unknown, NEVER absent (even after the window)", () => {
    const step = extractionStep(base(), { ok: false, why: "activity-api 503" }, min(10) + W + 1, DEFAULT_GOAL_REACH_POLICY);
    expect(step.extraction.status).toBe("unknown");
    expect(step.extraction.reason).toMatch(/503/);
    expect(step.file_evidence).toBe(false);
  });
  it("a template updated outside the window does not count", () => {
    const step = extractionStep(base(), { ok: true, templates: [tpl("learned-a", { extracted_from: "exec-1" }, min(10) + W + 60_000)] }, min(10) + W + 120_000, DEFAULT_GOAL_REACH_POLICY);
    expect(step.extraction.status).toBe("absent");
  });
  it("only a reach without hands is measured; hands / possible / ungraded are not", () => {
    expect(needsExtractionCheck(base("r"))).toBe(true);
    expect(needsExtractionCheck(base("autonomous_other"))).toBe(true);
    expect(needsExtractionCheck(base("hands"))).toBe(false);
    expect(needsExtractionCheck(base("possible"))).toBe(false);
    const u = base("r"); u.attribution_final = false; expect(needsExtractionCheck(u)).toBe(false);
    const f = base("r"); f.extraction = { status: "found" }; expect(needsExtractionCheck(f)).toBe(false);
  });
  it("the evidence entry append is idempotent per goal_hash and keeps other entries", () => {
    const e1 = { goal_hash: "aaaa0000", execution_id: "x" }, e2 = { goal_hash: "bbbb1111", execution_id: "y" };
    const once = appendEvidenceEntry(["legacy note"], e1);
    expect(once).toEqual(["legacy note", e1]);
    expect(appendEvidenceEntry(once, { ...e1, execution_id: "x2" })).toEqual(once);
    expect(appendEvidenceEntry(once, e2)).toEqual(["legacy note", e1, e2]);
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
      readTemplatesSince: async (from) => { calls.push({ op: "templates", args: from }); return { ok: true, templates: [] }; },
      attachExtractionEvidence: async (e) => { calls.push({ op: "evidence", args: e }); return { ok: true }; },
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
  it("on a reach without hands, R MEASURES extraction (reads the template store); it never dispatches an extraction", async () => {
    const io = fakeIO({ dispatches: [d({ dispatchId: "d1" })], gaps: [closedGap] });
    await runGoalReachTick(io, policy, min(5));
    const reachedD = d({ dispatchId: "r-1", trigger: "goal_reach", status: "completed", reached: true, startedAt: min(6), endedAt: min(8), executionId: "exec-9", selectedTemplateId: "activity:digest" });
    const io2 = fakeIO({ dispatches: [d({ dispatchId: "d1" }), reachedD], gaps: [closedGap],
      readTemplatesSince: async () => ({ ok: true, templates: [{ id: "learned-digest", updated_at: new Date(min(9)).toISOString(), metadata: { sourceExecutionId: "exec-9" } }] }) });
    Object.assign(io2.store, io.store);
    const out = await runGoalReachTick(io2, policy, min(9));
    const r = io2.store[H]!;
    expect(r.status).toBe("reached");
    expect(r.attribution).toBe("r");
    expect(r.extraction.status).toBe("found");
    expect(r.extracted_template_id).toBe("learned-digest");
    expect(io2.calls.filter((c) => c.op === "dispatch")).toHaveLength(0);
    expect(out.summary).toMatchObject({ reached_without_hands: 1, reached_by_r: 1, extraction_found: 1 });
  });
  it("absent after the window files evidence ONCE; an unreadable store files nothing", async () => {
    const reachedD = d({ dispatchId: "r-1", trigger: "boredom", status: "completed", reached: true, startedAt: min(6), endedAt: min(8), executionId: "exec-9" });
    const io = fakeIO({ dispatches: [d({ dispatchId: "d1" }), reachedD], gaps: [closedGap] });
    const late = min(8) + policy.extraction_window_ms + 1;
    await runGoalReachTick(io, policy, late);
    await runGoalReachTick(io, policy, late + 60_000);
    expect(io.store[H]!.attribution).toBe("autonomous_other");
    expect(io.store[H]!.extraction.status).toBe("absent");
    expect(io.calls.filter((c) => c.op === "evidence")).toHaveLength(1);
    const ioU = fakeIO({ dispatches: [d({ dispatchId: "d1" }), reachedD], gaps: [closedGap], readTemplatesSince: async () => ({ ok: false, why: "activity-api 503" }) });
    const out = await runGoalReachTick(ioU, policy, late);
    expect(ioU.store[H]!.extraction.status).toBe("unknown");
    expect(ioU.calls.filter((c) => c.op === "evidence")).toHaveLength(0);
    expect(out.summary).toMatchObject({ reached_without_hands: 1, reached_by_r: 0 });
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
    expect(out.summary).toMatchObject({ goals: 1, open_unlinked: 1, waiting: 0, redispatching: 0, reached_without_hands: 0, reached_by_r: 0 });
    expect(summarize(Object.values(io.store)).open_unlinked).toBe(1);
  });
});
