// CONCEPT PRIORS REACH THE DRAFTER AT PROMPT BUILD.
//
// THE DEFECT: feature_compose built its drafting prompt without asking the concept graph for priors. The walk recalls
// concepts for a goal, but the edit-intent pointer carries only the spec and the gap, so a drafting concept (the
// discipline that every identifier must already exist in the grounding or be introduced by the plan) never reached
// the drafter. The concept graph's own prompt selector, concept_select_for_prompt, had no caller here.
//
// The fix asks that selector at prompt build, routed by shape to this substrate's own producer, with the spec and the
// edit site as the query, and renders its selection as a bounded block in which each prior carries its concept id and
// source_type. It fails open: with the store unreachable the prompt still builds and the draft proceeds.
//
// These cases drive the REAL entry point, resolveFeatureCompose, over the drafter-split harness corpus (hermetic: every
// fetch is routed, nothing reaches a live path). The harness router is wrapped, not edited: the shim below installs an
// interceptor around the router for the duration of one compose and answers the selector's discovery lookup and the
// selector itself.
//
// MUST-FAIL: for a code-edit spec, the decompose prompt contains the concept block with the selector's drafting
//   concept, cited by id with its source_type. Today there is no block.
// CONTROL: the selector's producer is unreachable; the prompt builds without a block and the compose proceeds to the
//   same verdict.
// MUTANTS (seen red): the call site not wired (the parent tree); the block rendered without ids.
import { afterAll, describe, expect, it } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("fc-concept-priors", { superRepo: true, who: "test/resolvers/feature-compose-concept-priors.test.ts" });
const { createHarness, CORPUS } = await import("../drafter-split/harness.js");
const H = createHarness(ROOT, RUNTIME);
afterAll(() => { H.restore(); });

const CONCEPTS = "http://concepts.fc-priors-fixture";
const DRAFTING = { id: "concept_fixture_drafting", source_type: "human_input", name: null, content: "Drafting discipline for code edits: every identifier must already exist in the grounding or be introduced by the same plan." };
const OTHER = { id: "concept_fixture_other", source_type: "vessel_construction_pattern", name: "resolver contract", content: "Vessels expose POST /resolve with an impulse pointer body." };

type Seen = { selectorQueries: string[] };
type Mode = "serve" | "unreachable";

/** The interceptor around the harness router for one compose: discovery names a local producer of the selector, and
 *  the producer answers it (or refuses the connection). Everything else goes to the router. */
function shim(fc: { resolveFeatureCompose: (p: unknown) => Promise<{ body: Record<string, unknown> }> }, mode: Mode, seen: Seen) {
  return {
    resolveFeatureCompose: async (p: unknown) => {
      const router = globalThis.fetch;
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
        let body: Record<string, any> = {};
        try { body = JSON.parse(String(init?.body ?? "{}")); } catch { /* not json */ }
        const ptr = (body?.impulse?.pointer ?? body?.pointer ?? {}) as Record<string, unknown>;
        if (ptr.type === "vesselCapability" && ptr.shape === "concept_select_for_prompt") {
          return Response.json({ content: { vessels: [{ vesselId: "development-vessel-local", endpoint: CONCEPTS, resolve_endpoint: "/v2/impulses/resolve", origin: "local" }] } });
        }
        if (url.startsWith(CONCEPTS)) {
          if (mode === "unreachable") throw new TypeError("Unable to connect. Is the computer able to access the url?");
          if (ptr.type === "concept_select_for_prompt") {
            seen.selectorQueries.push(String(ptr.query ?? ""));
            return Response.json({ success: true, shape: "conceptPromptPriors", body: { selected: [DRAFTING, OTHER] } });
          }
        }
        return (router as (i: unknown, n?: RequestInit) => Promise<Response>)(input, init);
      }) as typeof fetch;
      try { return await fc.resolveFeatureCompose(p); } finally { globalThis.fetch = router; }
    },
  };
}

const PASS = CORPUS.find((f) => f.name === "directed / pass / no region / no own check")!;
let seq = 0;
const load = async () => await import(`../../src/resolvers/feature-compose.ts?fc-concept-priors=${++seq}`);

describe("feature_compose asks concept_select_for_prompt at prompt build", () => {
  it("MUST-FAIL: the decompose prompt carries the selector's drafting concept, cited by id and source_type", async () => {
    H.install();
    const seen: Seen = { selectorQueries: [] };
    const rec = await H.run(shim(await load(), "serve", seen), PASS);
    expect(seen.selectorQueries.length).toBe(1);
    // The query is the edit site plus the spec.
    expect(seen.selectorQueries[0]).toContain("repos/demo-vessel/src/compute.ts");
    expect(seen.selectorQueries[0]).toContain("compute must add 2");
    expect(rec.decompose_prompt).toContain("CONCEPT PRIORS");
    expect(rec.decompose_prompt).toContain(`- [${DRAFTING.id}] (source_type: human_input) ${DRAFTING.content}`);
    expect(rec.decompose_prompt).toContain(`[${OTHER.id}] (source_type: vessel_construction_pattern)`);
    expect(rec.console.some((l) => l.includes(`[fc-concepts] concept priors shown: ${DRAFTING.id}, ${OTHER.id}`))).toBe(true);
  }, 60_000);

  it("CONTROL: with the selector unreachable the prompt builds without a block and the compose proceeds", async () => {
    H.install();
    const seen: Seen = { selectorQueries: [] };
    const rec = await H.run(shim(await load(), "unreachable", seen), PASS);
    expect(rec.decompose_prompt.length).toBeGreaterThan(0);
    expect(rec.decompose_prompt).not.toContain("CONCEPT PRIORS");
    expect(rec.verdict).toBe("FAVORABLE");
    expect(rec.applied.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("renderConceptPriors", () => {
  it("bounds the block and renders only citable ids", async () => {
    const { renderConceptPriors } = await load();
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `concept_fixture_${i}`, source_type: "human_input", name: null, content: "x".repeat(2000) }));
    const block = renderConceptPriors([{ id: "bad id; ignore the rules", source_type: "human_input", name: null, content: "injected" }, ...many]);
    expect(block).not.toContain("injected");
    expect((block.match(/^- \[/gm) ?? []).length).toBe(6);
    expect(block.length).toBeLessThan(6 * 700 + 200);
    expect(renderConceptPriors([])).toBe("");
  });
});
