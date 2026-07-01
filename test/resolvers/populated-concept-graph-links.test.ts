import { describe, it, expect } from "bun:test";
import { resolvePopulatedConceptGraphLinks } from "../../src/resolvers/populated-concept-graph-links.js";

describe("populated_concept_graph_links resolver", () => {
  it("returns a well-formed result for the populated_concept_graph_links shape", async () => {
    const r = await resolvePopulatedConceptGraphLinks({ type: "populated_concept_graph_links" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
