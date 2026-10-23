// A COMPOSED CAPABILITY'S ID IS ITS CONTRACT, NOT ITS GOAL'S OPENING WORDS (law 3: a wrong mint is negative value).
// author_composed_capability keyed the template id on the goal's first 40 characters, so goals that open with a
// generic preamble minted ids every goal of the class shares: composed-cap-could-you-please-close-the-substrate-gap,
// composed-cap-investigate-and-decompose. One such template shadowed many unrelated goals and split their selection
// traffic. Driven through resolveAuthorComposedCapability with the planner LLM and the mint stood in for (bun
// mock.module) and discovery answered by a fetch stub; the minted template is what activity_create_variant receives.
// MUST-FAIL at the parent d0449bf3: both generic-prefix goals mint composed-cap-could-you-please-close-the-substrate-gap.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

const LLM = "../../src/resolvers/llm-completion-dispatch.js";
const MINT = "../../src/resolvers/activity-create-variant.js";
const realLlm = { ...(await import(LLM)) };
const realMint = { ...(await import(MINT)) };

type Minted = { id: string; name: string; output_shapes: string[]; input_shapes: string[] };
const minted: Minted[] = [];
let planInputs: string[] = [];

mock.module(LLM, () => ({
  ...realLlm,
  resolveLlmCompletionDispatch: async () => ({
    shape: "llm_completion_result",
    body: {
      text: JSON.stringify([
        { id: "fmt", resolver: "llm_completion_dispatch", config: { prompt: "Answer the goal." }, input_shapes: planInputs },
      ]),
    },
  }),
}));
mock.module(MINT, () => ({
  ...realMint,
  resolveActivityCreateVariant: async (p: { template: Minted }) => {
    minted.push(p.template);
    return { shape: "activityRegistryChange", body: { variantId: p.template.id } };
  },
}));

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/registry/shapes")) return new Response(JSON.stringify({ shapes: ["llm_completion_dispatch"] }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  mock.module(LLM, () => realLlm);
  mock.module(MINT, () => realMint);
});

const { resolveAuthorComposedCapability } = await import("../../src/resolvers/author-composed-capability.js");

async function mintFor(goal: string, target_shapes?: string[], inputs: string[] = []): Promise<Minted> {
  planInputs = inputs;
  const before = minted.length;
  const r = await resolveAuthorComposedCapability({ type: "author_composed_capability", goal, ...(target_shapes ? { target_shapes } : {}), max_attempts: 1 });
  expect(r.shape).toBe("author_composed_capability");
  expect(minted.length).toBe(before + 1);
  return minted[minted.length - 1]!;
}

const GENERIC = "composed-cap-could-you-please-close-the-substrate-gap";
const GOAL_A = "Could you please close the substrate gap about recall credit in concept-db";
const GOAL_B = "Could you please close the substrate gap about the boredom tail-cut in goal generation";

describe("a composed capability's template id", () => {
  it("[MUST-FAIL] two generic-prefix goals with different shape signatures mint distinct ids", async () => {
    const a = await mintFor(GOAL_A, ["conceptCreditReport"]);
    const b = await mintFor(GOAL_B, ["goalGenerationRepairPlan"]);
    expect(a.id).not.toBe(b.id);
    expect(a.name).not.toBe(b.name);
  });

  it("[MUST-FAIL] the instance goal text never mints the generic class id, nor one that prefix-matches it either way", async () => {
    for (const m of [await mintFor(GOAL_A, ["conceptCreditReport"]), await mintFor(GOAL_A)]) {
      expect(m.id).not.toBe(GENERIC);
      expect(m.id.startsWith(GENERIC)).toBe(false);
      expect(GENERIC.startsWith(m.id)).toBe(false);
      expect(m.id.startsWith("composed-cap-")).toBe(true); // reach-rate-scan, trace retention and the panels key on it
      // no goal words in the id or name: the goal-slug deliverable fallback reads as "deliverable"
      expect(m.id).not.toContain("could-you-please");
      expect(m.name).not.toContain("could-you-please");
      expect(m.id).toMatch(/-[0-9a-f]{12}$/);
    }
  });

  it("[MUST-FAIL] the same goal with different external inputs is a different contract, so a different id", async () => {
    const a = await mintFor(GOAL_A, ["conceptCreditReport"], ["fileContent"]);
    const b = await mintFor(GOAL_A, ["conceptCreditReport"], ["gitDiff"]);
    expect(a.id).not.toBe(b.id);
  });

  it("[MUST-FAIL] the id is keyed on the signature, so a reworded goal with the same signature reuses it", async () => {
    const a = await mintFor(GOAL_A, ["conceptCreditReport"]);
    const reworded = await mintFor("Please report how concept credit is recorded after a reached walk", ["conceptCreditReport"]);
    expect(reworded.id).toBe(a.id);
    expect(a.id).toContain("conceptcreditreport");
  });

  it("[CONTROL] the same signature mints the same id (stable; re-authoring upserts one template)", async () => {
    const a1 = await mintFor(GOAL_A, ["conceptCreditReport"]);
    const a2 = await mintFor(GOAL_A, ["conceptCreditReport"]);
    expect(a2.id).toBe(a1.id);
    expect(a2.name).toBe(a1.name);
    expect(a1.output_shapes).toEqual(["conceptCreditReport"]);
  });
});
