import { describe, it, expect } from "bun:test";
import { resolveLearningPolicy } from "../../src/resolvers/learning-policy.js";

describe("learning_policy resolver", () => {
  it("returns a well-formed result for the learningPolicy shape", async () => {
    const r = await resolveLearningPolicy({ type: "learning_policy" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
