import { describe, it, expect } from "bun:test";
import { resolveSourceCode } from "../../src/resolvers/source-code.js";

describe("source_code resolver", () => {
  it("returns a well-formed result for the sourceCode shape", async () => {
    const r = await resolveSourceCode({ type: "source_code" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
