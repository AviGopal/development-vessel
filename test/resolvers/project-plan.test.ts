import { describe, it, expect } from "bun:test";
import { resolveProjectPlan } from "../../src/resolvers/project-plan.js";

describe("project_plan resolver", () => {
  it("returns a well-formed result for the projectPlanReport shape", async () => {
    const r = await resolveProjectPlan({ type: "project_plan" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
