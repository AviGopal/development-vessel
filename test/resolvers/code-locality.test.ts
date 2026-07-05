import { describe, it, expect } from "bun:test";
import { resolveCodeLocality } from "../../src/resolvers/code-locality.js";

describe("code_locality resolver", () => {
  it("returns a well-formed result for the code_locality_result shape", async () => {
    const r = await resolveCodeLocality({ type: "code_locality" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
