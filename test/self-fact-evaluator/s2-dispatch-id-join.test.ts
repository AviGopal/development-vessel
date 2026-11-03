// THE S-2 DISPATCH-ID JOIN. A goal-host dispatch record's resolverAnswers are in link 5's scope only when the record is
// trusted to be this closure's: it names a provenance trace (execution_id / trace_ids), OR its own dispatch_id equals
// the dispatch id the landing's attempt intent registered. The compose stores the dispatch id on the intent while the
// record names a synthetic executionId ("feature_compose:<sha>"), so without the join the landing's own dispatch never
// matched and its answers were never read.
//
// MUST-FAIL: a record that matches ONLY by dispatch_id is now read and its answers attributed. Controls: a record with a
// different dispatch_id is still untrusted (UNATTRIBUTABLE); the execution_id and trace_ids matches are unchanged.
import { describe, expect, it } from "bun:test";
import { operatorActsOf, type GapRow, type ResolverDispatchLike } from "../../src/resolvers/operator-acts.js";
import { judgeRepairClosure, ledgerLandings, repairControlInputs } from "../../src/resolvers/self-fact-reconcile.js";

const NOW = Date.parse("2030-01-10T00:00:00Z");
const h = (n: number) => new Date(NOW - n * 3600_000).toISOString();
const GID = "g-s2";
const row: GapRow = { id: GID, source: "substrate_detected", status: "closed", closed_at: h(20), first_detected_at: h(100), classification_metadata: { edit_site: "repos/v/src/x.ts" } };
// An answer with no lease_provenance: OPERATOR under clause (b) once the record is read.
const opAnswer = { request_id: "req-1", outcome: "answered", at: h(60), answered_by_tag: "someone" };
const rec = (over: Partial<ResolverDispatchLike>): ResolverDispatchLike => ({ dispatch_id: "disp-own", execution_id: "feature_compose:" + "a".repeat(40), trace_ids: [], resolverAnswers: [opAnswer], ...over });
const read = (recs: ResolverDispatchLike[], own: string[]) => {
  const ctx = { byId: new Map([[GID, row]]), filedAt: h(100), untilAt: h(0), scopeActs: [], siteCommits: [], events: [], eventsFromFiling: true, labels: [], labelContext: null,
    traceIds: ["exec-authoring"], resolverDispatches: recs, resolverRequests: new Map(), landingDispatchIds: own };
  const r = operatorActsOf(row, ctx as never);
  return { s2: r.acts.filter((a) => a.addendum === "s2-answer"), untrusted: r.unattributable.filter((u) => u.includes("names no provenance trace")) };
};

describe("S-2: the landing's own dispatch is joined by its dispatch_id", () => {
  it("MUST-FAIL: a record matching only by dispatch_id is read, and its operator answer is an act", () => {
    const r = read([rec({})], ["disp-own"]);
    expect([r.s2.length, r.untrusted.length]).toEqual([1, 0]);
  });
  it("control: a record with a different dispatch_id is still untrusted", () => {
    const r = read([rec({ dispatch_id: "disp-other" })], ["disp-own"]);
    expect([r.s2.length, r.untrusted.length]).toEqual([0, 1]);
  });
  it("control: with no intent dispatch id, the record is untrusted as before", () => {
    expect(read([rec({})], []).untrusted.length).toBe(1);
  });
  it("control: an execution_id match and a trace_ids match are trusted as before", () => {
    expect(read([rec({ dispatch_id: "x1", execution_id: "exec-authoring" })], []).s2.length).toBe(1);
    expect(read([rec({ dispatch_id: "x2", execution_id: null, trace_ids: ["exec-authoring"] })], []).s2.length).toBe(1);
  });
  it("MUST-FAIL: ledgerLandings carries the intent's dispatch_id onto the landing", () => {
    const deps = {
      ledger: (k: string) => k === "attemptIntent" ? [{ key: "att-1", at: h(50), record: { attempt_id: "att-1", gap_id: GID, directed: false, dispatch_id: "disp-own", authoring_execution_id: "disp-own" } }]
        : k === "landingEvent" ? [{ key: "spool:att-1", at: h(50), record: { event: "commit", repo: "/x/v", sha: "b".repeat(40), at: h(50), attempt_id: "att-1" } }] : [],
      spool: () => [],
    };
    expect((ledgerLandings(deps as never, NOW - 168 * 3600_000).landings[0] as { dispatch_id?: unknown }).dispatch_id).toBe("disp-own");
  });
  it("MUST-FAIL: judgeRepairClosure joins the landing's dispatch_id (an operator answer on it fails link 5 as s2-answer)", () => {
    const inp = repairControlInputs(NOW, false);
    const j = judgeRepairClosure({ ...inp, landing: { ...inp.landing, dispatch_id: "disp-own" } as never, acts: { ...inp.acts, resolverDispatches: [rec({})], resolverRequests: new Map() } });
    expect(j.failing_links).toContain("operator_act:s2-answer");
  });
  it("control: the same closure with a different dispatch on the record stays unjoined (unattributable, not an act)", () => {
    const inp = repairControlInputs(NOW, false);
    const j = judgeRepairClosure({ ...inp, landing: { ...inp.landing, dispatch_id: "disp-own" } as never, acts: { ...inp.acts, resolverDispatches: [rec({ dispatch_id: "disp-other" })], resolverRequests: new Map() } });
    expect(j.failing_links).not.toContain("operator_act:s2-answer");
    expect(j.verdict).toBe("unjudged");
  });
});
