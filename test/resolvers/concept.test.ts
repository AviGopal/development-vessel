import { describe, it, expect } from "bun:test";
import { resolveConceptFromTraces } from "../../src/resolvers/concept.js";

describe("resolveConceptFromTraces", () => {
  it("returns shape=concept with required body fields", async () => {
    const result = await resolveConceptFromTraces({ type: "concept" });
    expect(result.shape).toBe("concept");
    const body = result.body as Record<string, unknown>;
    expect(typeof body["name"]).toBe("string");
    expect(typeof body["description"]).toBe("string");
    expect(Array.isArray(body["activities"])).toBe(true);
    expect(Array.isArray(body["resolverSteps"])).toBe(true);
    expect(Array.isArray(body["shapeFlow"])).toBe(true);
    expect(typeof body["tracesSampled"]).toBe("number");
    expect(typeof body["patternCount"]).toBe("number");
  });

  it("body.name is a non-empty string", async () => {
    const result = await resolveConceptFromTraces({ type: "concept" });
    const body = result.body as Record<string, unknown>;
    expect((body["name"] as string).length).toBeGreaterThan(0);
  });

  it("body.description is a non-empty string", async () => {
    const result = await resolveConceptFromTraces({ type: "concept" });
    const body = result.body as Record<string, unknown>;
    expect((body["description"] as string).length).toBeGreaterThan(0);
  });
});
