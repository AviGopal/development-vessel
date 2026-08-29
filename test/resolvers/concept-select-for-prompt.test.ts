import { describe, it, expect, afterEach } from "bun:test";
import { resolveConceptSelectForPrompt } from "../../src/resolvers/concept-select-for-prompt.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeFetch(corpus: Array<Record<string, unknown>>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ concepts: corpus }), { status: 200 })) as unknown as typeof fetch;
}

describe("concept_select_for_prompt", () => {
  it("ranks by combined_score and fills token budget greedily", async () => {
    globalThis.fetch = makeFetch([
      // best: high similarity (position 0) + high success rate + small tokens
      {
        id: "c_best",
        source_type: "vessel_construction_pattern",
        name: "best",
        content: "small content",
        token_estimate: 100,
        times_succeeded: 10,
        times_failed: 1,
        priority: 0.8,
      },
      // middle: position 1 + medium success
      {
        id: "c_mid",
        source_type: "vessel_construction_pattern",
        name: "mid",
        content: "medium content",
        token_estimate: 800,
        times_succeeded: 3,
        times_failed: 1,
        priority: 0.5,
      },
      // worst: position 2 + zero success + very large tokens
      {
        id: "c_worst",
        source_type: "vessel_construction_pattern",
        name: "worst",
        content: "huge content",
        token_estimate: 9000,
        times_succeeded: 0,
        times_failed: 5,
        priority: 0.2,
      },
    ]);

    const r = await resolveConceptSelectForPrompt({
      type: "concept_select_for_prompt",
      query: "scaffold",
      prior_source_types: ["vessel_construction_pattern"],
      budget_tokens: 1500,
    });
    expect(r.shape).toBe("conceptPromptPriors");
    const body = r.body as any;
    expect(body.candidates_considered).toBe(3);
    expect(body.selected_count).toBe(2); // best (100) + mid (800) fit, worst (9000) doesn't
    expect(body.selected[0].id).toBe("c_best");
    expect(body.tokens_used).toBe(900);
  });

  it("filters strictly by prior_source_types — multi-type selection works", async () => {
    globalThis.fetch = makeFetch([
      { id: "vc1", source_type: "vessel_construction_pattern", content: "vc one", token_estimate: 50 },
      { id: "ia1", source_type: "impulse_activity_pattern", content: "ia one", token_estimate: 50 },
      { id: "memo1", source_type: "memo", content: "memo one", token_estimate: 50 },
    ]);
    const r = await resolveConceptSelectForPrompt({
      type: "concept_select_for_prompt",
      query: "x",
      prior_source_types: ["vessel_construction_pattern", "impulse_activity_pattern"],
      budget_tokens: 5000,
    });
    const body = r.body as any;
    expect(body.selected_count).toBe(2);
    const types = new Set(body.selected.map((s: any) => s.source_type));
    expect(types.has("vessel_construction_pattern")).toBe(true);
    expect(types.has("impulse_activity_pattern")).toBe(true);
    expect(types.has("memo")).toBe(false);
  });

  it("falls back to DEFAULT_SOURCE_TYPES when prior_source_types is empty or absent", async () => {
    // POLICY REVERSAL, deliberate. `prior_source_types` used to be REQUIRED and an empty list
    // was a structuredError. bff8313 made it optional with a documented default — the interface
    // now reads "Defaults to [human_input, vessel_construction_pattern,
    // impulse_activity_pattern] if not provided", and DEFAULT_SOURCE_TYPES was added alongside.
    // The resolver treats empty and absent identically (see the `.length > 0 ? ... : DEFAULT`
    // ternary), so demanding an error here would re-impose a requirement the API deliberately
    // dropped. Assert the fallback instead — and assert it in BOTH forms, since "empty" and
    // "absent" taking the same path is the actual contract.
    // Mock the corpus: the fallback path actually QUERIES concept-db, whereas the old
    // structuredError path returned before any network call. Without this the case hangs on a
    // real request and times out at 20s — the assertion never runs.
    globalThis.fetch = makeFetch([
      {
        id: "c_default",
        source_type: "human_input",
        name: "default-eligible",
        content: "c",
        token_estimate: 10,
        times_succeeded: 1,
        times_failed: 0,
        priority: 0.5,
      },
    ]);
    const fromEmpty = await resolveConceptSelectForPrompt({
      type: "concept_select_for_prompt",
      query: "x",
      prior_source_types: [],
    });
    const fromAbsent = await resolveConceptSelectForPrompt({
      type: "concept_select_for_prompt",
      query: "x",
    });
    expect(fromEmpty.shape).toBe("conceptPromptPriors");
    expect(fromAbsent.shape).toBe("conceptPromptPriors");
    const a = fromEmpty.body as { prior_source_types?: string[] };
    expect(a.prior_source_types).toEqual([
      "human_input",
      "vessel_construction_pattern",
      "impulse_activity_pattern",
    ]);
  });

  it("graceful empty result on network failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("net down");
    }) as unknown as typeof fetch;
    const r = await resolveConceptSelectForPrompt({
      type: "concept_select_for_prompt",
      query: "x",
      prior_source_types: ["vessel_construction_pattern"],
    });
    expect(r.shape).toBe("conceptPromptPriors");
    const body = r.body as any;
    expect(body.selected_count).toBe(0);
    expect(body.candidates_considered).toBe(0);
  });
});
