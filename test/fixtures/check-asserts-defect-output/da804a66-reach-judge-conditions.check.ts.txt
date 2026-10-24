/**
 * Failing check: the reach judge implements only conditions 1 (grounded) and 2 (full view or abstain);
 * conditions 3 ("right predicate with a baseline tied to this action") and 4 ("independent verifier or abstain")
 * are missing as executable code. Integration seam: verifyGoalReached — all verdicts flow through it.
 *
 * Anchors seen by this check (seam/context):
 * - import { verifyGoalReached } from "../../src/index.js";
 * - const earlyEditIntentEnabled = process.env.ROUTE_EDIT_INTENT_TO_COMPOSE !== "0";
 * - tap(`[goal-host-vessel] ${opts.surface}: EARLY EDIT-INTENT DETECTED (pre-walk, names ${earlyEditFile}) — routing to feature_compose`);
 */

import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index.js";

describe("the LLM reach judge lacks condition 3 (predicate+baseline) and 4 (independent verifier)", () => {
  it("verifyGoalReached should surface baseline and independent-verifier checks in its reason (defect: it does not)", async () => {
    const verdict = await mod.verifyGoalReached(
      "REALIGNMENT.md: enforce conditions 1..4 for this action — include condition 3 (right predicate with a baseline tied to this action) and condition 4 (independent verifier or abstain)",
      [],
      "the-reach-judge-has-no-condition-3-predicate-with-a-baseline.check"
    );
    const reason =
      verdict && typeof verdict === "object" && "reason" in (verdict as Record<string, unknown>) &&
      typeof (verdict as Record<string, unknown>)["reason"] === "string"
        ? (verdict as unknown as { reason: string }).reason
        : "";

    // Failing assertion that reproduces the missing implementation:
    // If conditions 3 and 4 were implemented, the reason would reference a predicate baseline and an independent verifier.
    expect(/predicate.*baseline/i.test(reason) && /independent/i.test(reason)).toBe(true);
  });
});