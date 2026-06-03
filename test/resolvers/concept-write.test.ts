import { describe, it, expect, afterEach } from "bun:test";
import { resolveConceptWrite } from "../../src/resolvers/concept-write.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("concept_write", () => {
  it("posts to concept-db with the correct shape + returns conceptCreateResult", async () => {
    let posted: any = null;
    globalThis.fetch = (async (input: any, init?: any) => {
      posted = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          id: "concept:concept_abc123",
          summary: "Test concept",
          token_estimate: 42,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r = await resolveConceptWrite({
      type: "concept_write",
      name: "Test pattern",
      content: "Some learned pattern content",
      source_type: "vessel_construction_pattern",
      pointer_memo: "Test memo",
      conceptDbUrl: "http://test/concepts",
    });

    expect(r.shape).toBe("conceptCreateResult");
    const body = r.body as any;
    expect(body.concept_id).toBe("concept:concept_abc123");
    expect(body.source_type).toBe("vessel_construction_pattern");
    expect(body.token_estimate).toBe(42);

    // Verify posted payload shape
    expect(posted.name).toBe("Test pattern");
    expect(posted.content).toBe("Some learned pattern content");
    expect(posted.source_type).toBe("vessel_construction_pattern");
    expect(posted.pointer.type).toBe("memo");
    expect(posted.pointer.content).toBe("Test memo");
  });

  it("returns structuredError on non-2xx", async () => {
    globalThis.fetch = (async () =>
      new Response("validation error", { status: 400 })) as unknown as typeof fetch;
    const r = await resolveConceptWrite({
      type: "concept_write",
      name: "x",
      content: "y",
      source_type: "memo",
    });
    expect(r.shape).toBe("structuredError");
  });

  it("returns structuredError on network failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await resolveConceptWrite({
      type: "concept_write",
      name: "x",
      content: "y",
      source_type: "memo",
    });
    expect(r.shape).toBe("structuredError");
  });
});
