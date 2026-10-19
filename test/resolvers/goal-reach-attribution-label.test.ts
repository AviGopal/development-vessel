// HANDS ARE READ FROM THE CLAIMED OPERATOR LABEL, NOT FROM AUTHORITY (row reach-attribution-reads-operator-authority-
// so-after-the-auth-door-a-cockpit-assisted-reach-counts-as-autonomous).
//
// goal-host's inbound door made a dispatch record's `operator` AUTHORITY: set only for a credential carrying
// operator:direct or admin. A person driving the cockpit with an ordinary key claims operator:<id>; goal-host keeps it as
// `operator_label` (and the principal it ran as) and `operator` is null. isHumanDispatch read `operator` alone, so that
// person's reach would have been credited to the system as reached without hands.
//
//   [MUST-FAIL] operator null + operator_label "operator:<human id>" on the reaching dispatch → hands.
//   [MUST-FAIL] the activeDispatches and goalWalkState reads carry operator_label and principal into the observation.
//   [CONTROL]   neither label nor operator → not hands (r / autonomous_other); an operator:direct dispatch (operator
//               set, principal.operator) → hands; a record from before the door (operator only) → hands; a machine
//               dispatcher's label → not hands.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  goalHashOf,
  observe,
  linkGaps,
  attributeReach,
  originOf,
  handsOperatorId,
  isHumanDispatch,
  type DispatchObservation,
  type GapView,
  type GoalReachRecord,
} from "../../src/resolvers/goal-reach-tick.js";

const T0 = Date.parse("2026-10-19T10:00:00Z");
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
const gaps: GapView[] = [{ id: "g1", status: "closed", source: "substrate_detected", closed_reason: "landed_verified", closed_at: new Date(min(3)).toISOString(), demand_goals: [{ source: "goal_reach", goal_hash: H, dispatch_id: "d1", origin: "autonomous" }] } as GapView];
/** Failed first on d1, then reached on d2 with `by`. */
function reached(by: Partial<DispatchObservation>): GoalReachRecord {
  const r = observe({}, [d({ dispatchId: "d1" })], min(5))[H]!;
  linkGaps(r, gaps);
  return observe({ [H]: r }, [d({ dispatchId: "d2", status: "completed", reached: true, startedAt: min(20), endedAt: min(22), ...by })], min(23))[H]!;
}
const keyPrincipal = { kind: "key", label: "key:cockpit", operator: false };

describe("hands read the claimed operator label", () => {
  it("[MUST-FAIL] operator null + a human operator_label on the reaching dispatch is hands", () => {
    const a = attributeReach(reached({ trigger: "run-goal", operator: null, operator_label: "operator:claude-code", principal: keyPrincipal }), gaps, []);
    expect(a.attribution).toBe("hands");
    expect(a.reasons.join(" ")).toMatch(/operator_dispatch:d2/);
  });
  it("[MUST-FAIL] the label is also the goal's origin and its ask addressee", () => {
    expect(originOf({ operator: null, operator_label: "operator:claude-code", trigger: "run-goal" })).toBe("operator");
    expect(handsOperatorId({ operator: null, operator_label: "operator:claude-code" })).toBe("operator:claude-code");
    const r = observe({}, [d({ dispatchId: "d1", operator_label: "operator:claude-code", principal: keyPrincipal })], min(5))[H]!;
    expect(r.origin).toBe("operator");
    expect(r.origin_operator).toBe("operator:claude-code");
    expect(r.dispatches[0]!.operator_label).toBe("operator:claude-code");
  });
  it("[CONTROL] neither label nor operator is not hands", () => {
    expect(attributeReach(reached({ trigger: "boredom", operator: null, operator_label: null, principal: { kind: "node_self", label: "node-self", operator: false } }), gaps, []).attribution).toBe("autonomous_other");
  });
  it("[CONTROL] an operator:direct dispatch is hands (operator set by authority, principal.operator)", () => {
    expect(attributeReach(reached({ trigger: "operator", operator: "operator:claude-code", operator_label: "operator:claude-code", principal: { kind: "key", label: "key:op", operator: true } }), gaps, []).attribution).toBe("hands");
    expect(isHumanDispatch({ trigger: "run-goal", operator: null, operator_label: null, principal: { kind: "key", label: "key:op", operator: true } })).toBe(true);
  });
  it("[CONTROL] a record from before the door (operator only) is still read, and a machine label is not hands", () => {
    expect(attributeReach(reached({ trigger: "operator", operator: "operator:claude-code" }), gaps, []).attribution).toBe("hands");
    expect(isHumanDispatch({ trigger: "run-goal", operator: null, operator_label: "rhythm-conductor-drain", principal: keyPrincipal })).toBe(false);
  });
  it("[CONTROL] a thinner later observation keeps the label", () => {
    const r = observe({}, [d({ dispatchId: "d1", operator_label: "operator:claude-code" })], min(5));
    const again = observe(r, [d({ dispatchId: "d1" })], min(6))[H]!;
    expect(again.dispatches[0]!.operator_label).toBe("operator:claude-code");
  });
});

describe("the dispatch reads carry the label and the principal (source pins: the I/O reads goal-host over HTTP)", () => {
  const SRC = readFileSync(join(import.meta.dir, "../../src/resolvers/goal-reach-tick.ts"), "utf8");
  it("[MUST-FAIL] activeDispatches rows and goalWalkState bodies are read for operator_label and principal", () => {
    expect(SRC).toContain(`operator_label: typeof row["operator_label"] === "string" ? row["operator_label"] : null, principal: asPrincipal(row["principal"]),`);
    expect(SRC).toContain(`if (typeof b["operator_label"] === "string") obs.operator_label = b["operator_label"];`);
    expect(SRC).toContain(`obs.principal = asPrincipal(b["principal"]) ?? obs.principal ?? null;`);
  });
});
