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

  // concept-db's GET /concepts/search reads `query` (concept-db src/routes/concepts.ts, c.req.query('query')); a `q`
  // parameter is ignored, so every recall through this resolver searched with no query at all.
  it("[MUST-FAIL] the request names the text as `query`, the parameter concept-db reads, not `q`", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (u: string) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ concepts: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await resolveConceptSearchBySource({
      type: "concept_search_by_source",
      source_type: "vessel_construction_pattern",
      query: "vessel scaffold",
      limit: 4,
      conceptDbUrl: "http://test/concepts/search",
    });
    expect(urls.length).toBe(1);
    const sp = new URL(urls[0]!).searchParams;
    expect(sp.get("query")).toBe("vessel scaffold");
    expect(sp.has("q")).toBe(false);
    expect(sp.get("limit")).toBe("12");
  });
});
