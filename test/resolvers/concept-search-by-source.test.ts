import { describe, it, expect, afterEach } from "bun:test";
import { resolveConceptSearchBySource } from "../../src/resolvers/concept-search-by-source.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("concept_search_by_source", () => {
  it("filters concepts by source_type after concept-db returns mixed types", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          concepts: [
            { id: "c1", source_type: "vessel_construction_pattern", name: "anatomy" },
            { id: "c2", source_type: "memo", name: "unrelated memo" },
            { id: "c3", source_type: "vessel_construction_pattern", name: "scaffold composition" },
            { id: "c4", source_type: "impulse_activity_pattern", name: "different pattern" },
            { id: "c5", source_type: "vessel_construction_pattern", name: "three-place rule" },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const r = await resolveConceptSearchBySource({
      type: "concept_search_by_source",
      source_type: "vessel_construction_pattern",
      query: "vessel",
      limit: 10,
      conceptDbUrl: "http://test/search",
    });

    expect(r.shape).toBe("conceptSearchResult");
    const body = r.body as any;
    expect(body.total_returned_by_db).toBe(5);
    expect(body.matched_by_source).toBe(3);
    expect(body.concepts.map((c: any) => c.id)).toEqual(["c1", "c3", "c5"]);
  });

  it("respects limit after filtering", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          concepts: Array.from({ length: 8 }, (_, i) => ({
            id: `c${i}`,
            source_type: "vessel_construction_pattern",
            name: `vc ${i}`,
          })),
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const r = await resolveConceptSearchBySource({
      type: "concept_search_by_source",
      source_type: "vessel_construction_pattern",
      limit: 3,
    });
    const body = r.body as any;
    expect(body.matched_by_source).toBe(8);
    expect(body.limit_applied).toBe(3);
  });

  it("returns structuredError on network failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const r = await resolveConceptSearchBySource({
      type: "concept_search_by_source",
      source_type: "vessel_construction_pattern",
    });
    expect(r.shape).toBe("structuredError");
  });
});
