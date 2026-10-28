// THE SHIPPED DRAFTER ARM (OPEN): drafter-v1 is the core's floor, surfaced through the module contract.
//
// feature_compose owns the sole floor assembly. It gathers and renders the closed facts, then supplies that exact
// context here. Keeping this module as an identity arm preserves selection and attempt attribution without a second
// renderer that could drift from the control. Future variants can request bounded facts and render their own context.
import type { DrafterContext, DrafterFacts, DrafterReadPlan } from "./types.js";

export function planDrafterReads(_facts: DrafterFacts): DrafterReadPlan {
  return { reads: [], lessonQueries: [], ancestorDepth: 0 };
}

export function assembleDrafterContext(facts: DrafterFacts): DrafterContext {
  return facts.floorContext;
}
