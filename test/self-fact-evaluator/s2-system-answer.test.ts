// PREREG ADDENDUM 8 — S-2 RESOLVER ANSWERS (USER RULING 2026-10-22, "Autonomous if the system initiated it"; research's
// rule text, cited verbatim in operator-acts.ts classifyS2Answer). Every resolverAnswers[] entry on a dispatch record
// that names the closure is exactly one of SYSTEM, UNATTRIBUTABLE or OPERATOR. OPERATOR is an operator act (ASSISTED:
// not_counted, operator_act:s2-answer); UNATTRIBUTABLE makes link 5 unattributable (never counted); SYSTEM counts as the
// system's. One must-fail per clause (a)-(j), the two UNATTRIBUTABLE grounds, the read-path precondition (a dispatch
// record that names no provenance trace, e.g. a forged dispatch:<id> tag), and answered_by_tag never classifying.
// DRAFT: not committed.
import { describe, expect, it } from "bun:test";
import { classifyS2Answer, type ResolverRequestLike } from "../../src/resolvers/operator-acts.js";
import { judgeRepairClosure, repairControlInputs } from "../../src/resolvers/self-fact-reconcile.js";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const t = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const TRACE = "feature_compose:" + "f".repeat(40);
const prov = (over: Record<string, unknown> = {}) => ({ request_id: "rq-1", lease_id: "ls-1", attempt: 1, dispatch_id: "d-1", origin: "system", ...over });
const answer = (over: Record<string, unknown> = {}, p: Record<string, unknown> = {}) => ({ request_id: "rq-1", outcome: "resolved", at: t(60), answered_by_tag: "key:operator", lease_provenance: prov(p), answer_id: "ans-1", ...over });
const attempt = (over: Record<string, unknown> = {}) => ({ attempt: 1, lease_id: "ls-1", granted_at: t(61), expires_at: t(59), ended_at: t(59.5), answer_binding: { answer_id: "ans-1", accepted_at: t(60) }, ...over });
const request = (over: Record<string, unknown> = {}, att: Record<string, unknown> = {}): ResolverRequestLike => ({ request_id: "rq-1", origin: "system", dispatch_id: "d-1", attempts: [attempt(att)], ...over }) as ResolverRequestLike;
const reqs = (...r: ResolverRequestLike[]) => new Map(r.map((x) => [x.request_id, x]));
const cls = (entry: unknown, r: ReadonlyMap<string, ResolverRequestLike> | null = reqs(request())) => { const c = classifyS2Answer(entry, r); return c.cls === "OPERATOR" ? `OPERATOR(${c.clause})` : c.cls; };
/** A closure whose landing ran as TRACE, with one dispatch record of answers (naming `executionId`). */
function closure(answers: unknown[] | null, r: ReadonlyMap<string, ResolverRequestLike> | null = reqs(request()), executionId: string = TRACE) {
  const inp = repairControlInputs(NOW, false); // system-armed, otherwise clean: counts with no answer
  const dispatches = answers === null ? null : [{ dispatch_id: "d-1", execution_id: executionId, resolverAnswers: answers }];
  return judgeRepairClosure({ ...inp, landing: { ...inp.landing, authoring_execution_id: TRACE }, acts: { ...inp.acts, resolverDispatches: dispatches, resolverRequests: r } as never });
}
const v = (j: ReturnType<typeof closure>) => ({ verdict: j.verdict, failing_link: j.failing_link ?? null });

describe("PREREG ADDENDUM 8: each S-2 resolver answer is SYSTEM, UNATTRIBUTABLE or OPERATOR", () => {
  it("MUST-FAIL (a)-(j): each clause unmet makes the entry OPERATOR", () => {
    expect({
      a_entry: cls(answer({ operator_marker: true })),
      a_provenance: cls(answer({}, { operator_marker: true })),
      b_no_provenance: cls(answer({ lease_provenance: null }), reqs(request())),
      b_no_answer_id: cls(answer({ answer_id: "" })),
      c_request_differs: cls(answer({ request_id: "rq-OTHER" })),
      d_provenance_operator: cls(answer({}, { origin: "operator" })),
      e_request_operator: cls(answer(), reqs(request({ origin: "operator" }))),
      e_dispatch_differs: cls(answer(), reqs(request({ dispatch_id: "d-OTHER" }))),
      f_lease_mismatch: cls(answer(), reqs(request({}, { lease_id: "ls-OTHER" }))),
      f_attempt_mismatch: cls(answer({}, { attempt: 2 })),
      g_other_answer: cls(answer(), reqs(request({}, { answer_binding: { answer_id: "ans-OTHER", accepted_at: t(60) } }))),
      g_no_accepted_at: cls(answer(), reqs(request({}, { answer_binding: { answer_id: "ans-1", accepted_at: null } }))),
      h_at_unparsable: cls(answer({ at: "not a time" })),
      i_no_granted_at: cls(answer(), reqs(request({}, { granted_at: null }))),
      i_no_end: cls(answer(), reqs(request({}, { ended_at: null, expires_at: null }))),
      j_outside: cls(answer({ at: t(58) })),
    }).toEqual({
      a_entry: "OPERATOR(a)", a_provenance: "OPERATOR(a)", b_no_provenance: "OPERATOR(b)", b_no_answer_id: "OPERATOR(b)", c_request_differs: "OPERATOR(c)",
      d_provenance_operator: "OPERATOR(d)", e_request_operator: "OPERATOR(e)", e_dispatch_differs: "OPERATOR(e)", f_lease_mismatch: "OPERATOR(f)",
      f_attempt_mismatch: "OPERATOR(f)", g_other_answer: "OPERATOR(g)", g_no_accepted_at: "OPERATOR(g)", h_at_unparsable: "OPERATOR(h)",
      i_no_granted_at: "OPERATOR(i)", i_no_end: "OPERATOR(i)", j_outside: "OPERATOR(j)",
    });
  });
  it("MUST-FAIL: an entry that is not a readable record, or whose request record cannot be read, is UNATTRIBUTABLE", () => {
    expect({ not_a_record: cls("x"), null_entry: cls(null), request_unread: cls(answer(), null), request_missing: cls(answer(), reqs()) })
      .toEqual({ not_a_record: "UNATTRIBUTABLE", null_entry: "UNATTRIBUTABLE", request_unread: "UNATTRIBUTABLE", request_missing: "UNATTRIBUTABLE" });
  });
  it("MUST-FAIL: an unreadable request takes precedence over a marker (UNATTRIBUTABLE, not OPERATOR(a)); an absent lease_provenance names no request, so it is OPERATOR(b)", () => {
    expect({ marked_unread: cls(answer({ operator_marker: true }), reqs()), marked_unread_map: cls(answer({ operator_marker: true }), null), no_provenance_unread_map: cls(answer({ lease_provenance: null }), null) })
      .toEqual({ marked_unread: "UNATTRIBUTABLE", marked_unread_map: "UNATTRIBUTABLE", no_provenance_unread_map: "OPERATOR(b)" });
    expect(classifyS2Answer(answer({}, { origin: "operator" }), reqs(request())).why).toStartWith("S-2 clause (d) unmet: ");
  });
  it("MUST-FAIL (research, 1): a v1 answer by solicitationId (no lease_provenance, no answer_id) is OPERATOR(b); with a marker, OPERATOR(a); a non-object lease_provenance names no request either", () => {
    const v1 = classifyS2Answer(answer({ lease_provenance: null, answer_id: null }), null);
    expect({ cls: v1.cls, clause: v1.clause, why: v1.why }).toEqual({ cls: "OPERATOR", clause: "b", why: "S-2 clause (b) unmet: no lease_provenance or no answer_id" });
    expect({ marked: cls(answer({ lease_provenance: null, answer_id: null, operator_marker: true }), null), not_object: cls(answer({ lease_provenance: "ls-1" }), null) }).toEqual({ marked: "OPERATOR(a)", not_object: "OPERATOR(b)" });
  });
  it("MUST-FAIL (research, 2): lease_provenance present and answer_id empty is OPERATOR(b) when the request is readable, UNATTRIBUTABLE when it is not", () => {
    expect({ readable: cls(answer({ answer_id: "" }), reqs(request())), unreadable: cls(answer({ answer_id: "" }), reqs()) }).toEqual({ readable: "OPERATOR(b)", unreadable: "UNATTRIBUTABLE" });
  });
  it("MUST-FAIL (research, 3): a marked answer with an unreadable request is UNATTRIBUTABLE", () => {
    expect(cls(answer({ operator_marker: true }), reqs())).toBe("UNATTRIBUTABLE");
  });
  it("MUST-FAIL: answered_by_tag never classifies: a node-self tag alone does not make SYSTEM", () => {
    expect(cls(answer({ answered_by_tag: "node-self", lease_provenance: null, answer_id: null }))).toBe("OPERATOR(b)");
  });
  it("MUST-FAIL: in the closure, an OPERATOR answer is an operator act (ASSISTED)", () => {
    expect(v(closure([answer({}, { origin: "operator" })]))).toEqual({ verdict: "not_counted", failing_link: "operator_act:s2-answer" });
  });
  it("MUST-FAIL: in the closure, an UNATTRIBUTABLE answer, unread dispatch records, or a dispatch record that names no provenance trace (a forged dispatch tag) make link 5 unattributable, never counted", () => {
    const u = (j: ReturnType<typeof closure>) => ({ verdict: j.verdict, unattributable: j.reason.includes("link 5 UNATTRIBUTABLE") });
    expect({
      answer: u(closure([answer()], reqs())),
      dispatches_unread: u(closure(null)),
      forged_tag: u(closure([answer()], reqs(request()), "feature_compose:" + "0".repeat(40))),
    }).toEqual({ answer: { verdict: "unjudged", unattributable: true }, dispatches_unread: { verdict: "unjudged", unattributable: true }, forged_tag: { verdict: "unjudged", unattributable: true } });
  });
  it("CONTROL: an entry meeting every clause is SYSTEM, and the closure counts with the SYSTEM entry named", () => {
    expect(cls(answer())).toBe("SYSTEM");
    const j = closure([answer()]);
    expect({ ...v(j), system: (j.operator_acts as { s2_system_answers?: string[] }).s2_system_answers?.length ?? 0 }, j.reason).toEqual({ verdict: "counted", failing_link: null, system: 1 });
  });
});
