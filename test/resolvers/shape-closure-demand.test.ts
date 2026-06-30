import { describe, it, expect } from "bun:test";
import { resolveShapeClosureDemand } from "../../src/resolvers/shape-closure-demand.js";

describe("shape_closure_demand resolver", () => {
  it("returns a well-formed result for the shapeClosureDemand shape", async () => {
    const r = await resolveShapeClosureDemand({ type: "shape_closure_demand" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
