// CONTENT REACHES THE CODE DRAFTER WITH ITS KIND: A RECORDED REJECTED APPROACH DOES NOT STEER A DRAFT.
//
// THE DEFECT: feature_compose's consultation before drafting (CONSULTATION-ON-AUTHOR) searches the concept graph with
// keywords from the spec and no shape or source_type filter, and rendered every hit the same way. A concept recording a
// REJECTED approach names the very file and symbols the spec does, so it matched and was rendered like a rule: recording
// what failed could steer the system's own drafts toward it.
//
// THE FIX: a concept of shape rejected_approach is excluded from the consultation, and each remaining item is rendered
// with its id, shape and source_type.
//
// Driven through the REAL entry point (resolveFeatureCompose) over the drafter-split harness corpus; the harness router
// is wrapped, not edited: the shim answers the consultation's concept search and the prompt-prior selector.
//
// MUST-FAIL: a rejected_approach concept matching the spec's keywords is absent from the decompose prompt, and the
//   consultation item that remains carries its kind.
// CONTROL: the selector's human_input drafting rule is still selected and rendered with its kind.
// MUTANT (seen red): the excluded-shape set emptied.
import { afterAll, describe, expect, it } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("fc-consult-kind", { superRepo: true, who: "test/resolvers/feature-compose-consult-kind.test.ts" });
const { createHarness, CORPUS } = await import("../drafter-split/harness.js");
const H = createHarness(ROOT, RUNTIME);
afterAll(() => { H.restore(); });

const CONCEPTS = "http://concepts.fc-consult-kind-fixture";
const REJECTED = { id: "concept_fixture_rejected", shape: "rejected_approach", source_type: "human_input", summary: "rejected: make compute add two by editing helper.ts", content: "REJECTED-APPROACH-MARKER edit scale in helper.ts to return x * 2 + 1" };
const RULE = { id: "concept_fixture_rule", shape: "architecturePrinciple", source_type: "vessel_construction_pattern", summary: "keep edits surgical", content: "Edit only the target file named in the spec." };
const DRAFTING = { id: "concept_fixture_drafting", source_type: "human_input", name: null, content: "Drafting discipline for code edits: every identifier must already exist in the grounding or be introduced by the same plan." };

function shim(fc: { resolveFeatureCompose: (p: unknown) => Promise<{ body: Record<string, unknown> }> }, searches: string[]) {
  return {
    resolveFeatureCompose: async (p: unknown) => {
      const router = globalThis.fetch as (i: unknown, n?: RequestInit) => Promise<Response>;
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
        let body: Record<string, any> = {};
        try { body = JSON.parse(String(init?.body ?? "{}")); } catch { /* not json */ }
        const ptr = (body?.impulse?.pointer ?? body?.pointer ?? {}) as Record<string, unknown>;
        if (url.includes("/concepts/search?")) { searches.push(url); return Response.json({ concepts: [REJECTED, RULE], count: 2 }); }
        if (ptr.type === "vesselCapability" && ptr.shape === "concept_select_for_prompt") {
          return Response.json({ content: { vessels: [{ vesselId: "development-vessel-local", endpoint: CONCEPTS, resolve_endpoint: "/v2/impulses/resolve", origin: "local" }] } });
        }
        if (url.startsWith(CONCEPTS) && ptr.type === "concept_select_for_prompt") return Response.json({ success: true, shape: "conceptPromptPriors", body: { selected: [DRAFTING] } });
        return router(input, init);
      }) as typeof fetch;
      try { return await fc.resolveFeatureCompose(p); } finally { globalThis.fetch = router as typeof fetch; }
    },
  };
}

const PASS = CORPUS.find((f) => f.name === "directed / pass / no region / no own check")!;
let seq = 0;
const load = async () => await import(`../../src/resolvers/feature-compose.ts?fc-consult-kind=${++seq}`);

describe("the consultation before drafting carries each concept's kind and drops rejected approaches", () => {
  it("MUST-FAIL: a rejected_approach concept matching the spec is absent; the remaining item carries its kind", async () => {
    H.install();
    const searches: string[] = [];
    const rec = await H.run(shim(await load(), searches), PASS);
    expect(searches.length).toBeGreaterThan(0);
    expect(rec.decompose_prompt).toContain("ARCHITECTURAL PRINCIPLES");
    expect(rec.decompose_prompt).not.toContain("REJECTED-APPROACH-MARKER");
    expect(rec.decompose_prompt).not.toContain(REJECTED.summary);
    expect(rec.decompose_prompt).toContain(`1. [${RULE.id}] (shape: architecturePrinciple, source_type: vessel_construction_pattern) ${RULE.summary}`);
    expect(rec.console.some((l) => l.includes(`[fc-principles] excluded 1 rejected_approach concept(s) from the consultation: ${REJECTED.id}`))).toBe(true);
  }, 60_000);

  it("CONTROL: the selector's human_input drafting rule is still selected and rendered with its kind", async () => {
    H.install();
    const rec = await H.run(shim(await load(), []), PASS);
    expect(rec.decompose_prompt).toContain(`- [${DRAFTING.id}] (source_type: human_input) ${DRAFTING.content}`);
    expect(rec.verdict).toBe("FAVORABLE");
  }, 60_000);
});

describe("renderConsultedConcepts", () => {
  it("drops every rejected_approach, keeps at most four, and names each kind", async () => {
    const { renderConsultedConcepts } = await load();
    const rows = [REJECTED, ...Array.from({ length: 5 }, (_, i) => ({ id: `concept_fixture_${i}`, shape: "architecturePrinciple", source_type: "human_input", summary: `rule ${i}`, content: "x" }))];
    const out = renderConsultedConcepts(rows);
    expect(out.excluded).toEqual([REJECTED.id]);
    expect((out.text.match(/^\d+\. \[/gm) ?? []).length).toBe(4);
    expect(out.text).not.toContain("REJECTED-APPROACH-MARKER");
    expect(renderConsultedConcepts([REJECTED])).toEqual({ text: "", excluded: [REJECTED.id] });
  });
});
