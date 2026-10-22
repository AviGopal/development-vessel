// USER RULING 2026-10-22 (docs stamp 04:44:38Z), verbatim: "Never: concepts are shared memory". A draft that consulted
// operator- or agent-written concepts NEVER makes a closure assisted: only acts on the row or the landing count.
//
// The act reader (operator-acts.ts operatorActsOf) and repair_autonomy's links take no concept, prior or lesson data,
// so the evaluator already complies; this PINS it.
//
// WHO WROTE A CONCEPT IS NOT RECORDED. concept-db's concept table (sql/core/001-concept-tables.surql; ConceptSchema in
// src/models/schemas.ts) carries source_type, scope, public, org_id, project_id and a caller-chosen pointer, and no
// writer field; concept_create (src/resolvers/concept.ts) sets org_id from the caller's credential and takes the rest
// from the request. So the authorship that really exists is the SOURCE TYPE: "memo" is what concept_create writes for
// an operator surface (its synthesized pointer is {type: "memo"}), "compose_lesson" is the lane's own writer
// (feature-compose.ts). The consultation is represented the way feature-compose records it: applied_concept_ids and
// concept_credits (the featureComposeReport body and the authoring trace's metadata), with each consulted prior as the
// drafter saw it (ConceptPrior: id, source_type, name, content). It is placed on the closure's ROW, the input the act
// reader reads most, so a reader that took it for an act would see it.
//   CONTROL  a closure whose draft consulted a "memo" concept (operator surface) AND a "compose_lesson" concept (the
//            lane), its other inputs clean, stays COUNTED, with no act and no failing link;
//   CONTROL  the same closure without the consultation also counts (the twin: the concepts change nothing).
// Mutant it must go red under: operatorActsOf pushes an operator act for a consulted prior whose source_type is "memo"
// (an operator-surface concept).
import { describe, expect, it } from "bun:test";
import { judgeRepairClosure, repairControlInputs } from "../../src/resolvers/self-fact-reconcile.js";
import type { GapRow } from "../../src/resolvers/operator-acts.js";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const consulted = {
  applied_concept_ids: ["concept_memoOperator1", "concept_laneLesson001"],
  concept_credits: [
    { concept_id: "concept_memoOperator1", outcome: "success", recorded: true, detail: "concept_usage_record ok" },
    { concept_id: "concept_laneLesson001", outcome: "success", recorded: true, detail: "concept_usage_record ok" },
  ],
  concept_priors: [
    { id: "concept_memoOperator1", source_type: "memo", name: null, content: "an operator's note on this edit site" },
    { id: "concept_laneLesson001", source_type: "compose_lesson", name: "anchor on the exported symbol", content: "a lesson the lane wrote" },
  ],
};
function closure(withConcepts: boolean) {
  const inp = repairControlInputs(NOW, false);
  const meta = { ...(inp.row!["classification_metadata"] as Record<string, unknown>), ...(withConcepts ? consulted : {}) };
  const row: GapRow = { ...inp.row!, classification_metadata: meta };
  return judgeRepairClosure({ ...inp, row, byId: new Map([[String(row["id"]), row]]), landing: { ...inp.landing, authoring_execution_id: "exec-authoring-with-priors" } });
}

describe("repair_autonomy: consulted concepts are shared memory, never an operator act (USER RULING 2026-10-22)", () => {
  it("CONTROL: a closure whose draft consulted a memo (operator surface) and a compose_lesson (lane) concept stays counted", () => {
    const j = closure(true);
    expect({ verdict: j.verdict, failing_links: j.failing_links, acts: (j.operator_acts?.acts ?? []).map((a) => a.addendum) }, j.reason).toEqual({ verdict: "counted", failing_links: [], acts: [] });
  });
  it("CONTROL: its twin without the consultation counts the same way (the concepts change nothing)", () => {
    expect([closure(false).verdict, closure(true).verdict]).toEqual(["counted", "counted"]);
  });
});
