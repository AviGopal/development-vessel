import { describe, it, expect } from "bun:test";
import { resolveGoalSummary } from "../../src/resolvers/goal-summary.js";

describe("goal_summary resolver", () => {
  it("returns a well-formed result for the goal_summary shape", async () => {
    const r = await resolveGoalSummary({ type: "goal_summary" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
