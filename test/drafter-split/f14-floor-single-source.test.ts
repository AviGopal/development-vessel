import { describe, expect, it } from "bun:test";
import { assembleDrafterContext } from "../../src/drafter/index.js";
import type { DrafterContext, DrafterFacts } from "../../src/drafter/types.js";

describe("the shipped drafter uses the core's sole floor assembly", () => {
  it("returns the exact floor context supplied by the closed core", () => {
    const floorContext: DrafterContext = {
      grounding: "closed-core grounding",
      targetWindows: { "repos/example/src/target.ts": "the raw window" },
      priorFeedback: "closed-core feedback",
      principles: "closed-core principles",
      composeLessons: "closed-core lessons",
      netNewTargets: ["repos/example/src/new.ts"],
      opBudgetHint: 3,
      journal: ["closed-core journal"],
      version: "drafter-v1",
    };
    const facts = { floorContext } as unknown as DrafterFacts;

    expect(assembleDrafterContext(facts)).toBe(floorContext);
  });
});
