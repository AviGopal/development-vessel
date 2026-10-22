// THE EXACT OUTPUT SCHEMA ASKS FOR "applied_ids" WHENEVER THE CONCEPT PRIORS ARE SHOWN.
//
// THE DEFECT: the drafter was asked for a top-level "applied_ids" array only inside the CONCEPT PRIORS text, while the
// binding output contract at the end of the decompose prompt ("Emit ONE JSON object ... with this exact schema", then
// "respond with ONLY the JSON object") listed summary, touched_vessels and ops alone. A drafter that follows the exact
// schema never emits applied_ids, so appliedConceptIds found nothing, conceptsApplied.applied was always empty and the
// concept_usage_record credit never ran: the priors were shown on every compose and credited on none.
//
// The fix: the exact schema carries "applied_ids" (same field, same meaning as the priors text) whenever the priors
// block is in the prompt, and does not ask for it when no priors are shown.
//
// The compose cases drive the REAL entry point over the drafter-split harness corpus; the harness router is wrapped,
// not edited. The drafter here is SCHEMA-FOLLOWING: it reads the exact-schema section of the decompose prompt and cites
// the shown prior only under the top-level field that section declares beyond summary/touched_vessels/ops. (The concept
// credit test adds applied_ids to every plan unconditionally, so it cannot see this defect.)
//
// MUST-FAIL: with priors shown, the exact-schema section names "applied_ids" (unit, and in the real compose's prompt).
// MUST-FAIL: a schema-following drafter's plan then cites the shown prior, conceptsApplied.applied is that id, and the
//   concept_usage_record writer (stubbed) is called with it for a crediting outcome (a judged failing draft).
// CONTROL: with no priors shown (the selector unreachable), the schema asks for no applied_ids and no credit is written
//   (no usage-record lookup either).
// MUTANTS (seen red): applied_ids dropped from the schema; the schema names a different field; the credit gate inverted.
import { afterAll, describe, expect, it } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("fc-applied-ids-schema", { superRepo: true, who: "test/resolvers/feature-compose-applied-ids-schema.test.ts" });
const { createHarness, CORPUS } = await import("../drafter-split/harness.js");
const H = createHarness(ROOT, RUNTIME);
afterAll(() => { H.restore(); });

const CONCEPTS = "http://concepts.fc-applied-ids-fixture";
const TRACE_ID = "exec_fixture_trace";
const DRAFTING = { id: "concept_fixture_drafting", source_type: "human_input", name: null, content: "Drafting discipline for code edits: every identifier must already exist in the grounding or be introduced by the same plan." };
const OTHER = { id: "concept_fixture_other", source_type: "vessel_construction_pattern", name: "resolver contract", content: "Vessels expose POST /resolve with an impulse pointer body." };

/** The binding output contract: from "with this exact schema:" to the RULES that follow it. */
function schemaSection(prompt: string): string {
  const start = prompt.indexOf("with this exact schema:");
  if (start < 0) return "";
  const end = prompt.indexOf("\nRULES:", start);
  return prompt.slice(start, end < 0 ? undefined : end);
}
/** The top-level fields the schema declares beyond the plan's own (two-space indent inside the object literal). */
function extraTopLevelFields(prompt: string): string[] {
  return [...schemaSection(prompt).matchAll(/^ {2}"([\w-]+)"\s*:/gm)].map((m) => m[1]!).filter((k) => !["summary", "touched_vessels", "ops"].includes(k));
}

type Usage = { concept_id: unknown; outcome: unknown; trace_id: unknown };
type Seen = { usage: Usage[]; usageLookups: number; cited: Array<Record<string, unknown>> };
type Mode = "serve" | "unreachable";

function shim(fc: { resolveFeatureCompose: (p: unknown) => Promise<{ body: Record<string, unknown> }> }, mode: Mode, seen: Seen) {
  return {
    resolveFeatureCompose: async (p: unknown) => {
      const router = globalThis.fetch as (i: unknown, n?: RequestInit) => Promise<Response>;
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
        let body: Record<string, any> = {};
        try { body = JSON.parse(String(init?.body ?? "{}")); } catch { /* not json */ }
        const ptr = (body?.impulse?.pointer ?? body?.pointer ?? {}) as Record<string, unknown>;
        if (ptr.type === "vesselCapability" && (ptr.shape === "concept_select_for_prompt" || ptr.shape === "concept_usage_record")) {
          if (ptr.shape === "concept_usage_record") seen.usageLookups++;
          return Response.json({ content: { vessels: [{ vesselId: "development-vessel-local", endpoint: CONCEPTS, resolve_endpoint: "/v2/impulses/resolve", origin: "local" }] } });
        }
        if (url.startsWith(CONCEPTS) && ptr.type === "concept_select_for_prompt") {
          if (mode === "unreachable") throw new TypeError("Unable to connect. Is the computer able to access the url?");
          return Response.json({ success: true, shape: "conceptPromptPriors", body: { selected: [DRAFTING, OTHER] } });
        }
        if (url.startsWith(CONCEPTS) && ptr.type === "concept_usage_record") {
          seen.usage.push({ concept_id: ptr.concept_id, outcome: ptr.outcome, trace_id: ptr.trace_id });
          return Response.json({ success: true, shape: "conceptUsageRecorded", body: { concept_id: ptr.concept_id, trace_id: ptr.trace_id, outcome: ptr.outcome, usage_record_id: "usage_fixture" } });
        }
        if (url.endsWith("/v2/activities/executions")) return Response.json({ execution_id: TRACE_ID });
        // THE SCHEMA-FOLLOWING DRAFTER: it emits only what the exact schema asks for. When the schema declares a further
        // top-level field and the prompt shows the drafting prior, it cites that prior's id under that field.
        if (typeof body?.prompt === "string" && body.prompt.includes("decomposing a feature specification")) {
          const r = await router(input, init);
          const j = (await r.json()) as { content: string };
          const plan = JSON.parse(j.content) as Record<string, unknown>;
          const extra: Record<string, unknown> = {};
          if (body.prompt.includes(`[${DRAFTING.id}]`)) for (const k of extraTopLevelFields(body.prompt)) extra[k] = [DRAFTING.id];
          seen.cited.push(extra);
          return Response.json({ ...j, content: JSON.stringify({ ...plan, ...extra }) });
        }
        return router(input, init);
      }) as typeof fetch;
      try {
        const out = await fc.resolveFeatureCompose(p);
        await new Promise((r) => setTimeout(r, 250));
        return out;
      } finally { globalThis.fetch = router as typeof fetch; }
    },
  };
}

const RED = CORPUS.find((f) => f.name === "directed / verify red")!;
let seq = 0;
const load = async () => await import(`../../src/resolvers/feature-compose.ts?fc-applied-ids-schema=${++seq}`);
const run = async (mode: Mode) => {
  H.install();
  const seen: Seen = { usage: [], usageLookups: 0, cited: [] };
  let body: Record<string, unknown> = {};
  const rec = await H.run(shim(await load(), mode, seen), RED, (b) => { body = b; });
  return { rec, seen, body };
};

describe("decomposePrompt: the exact schema carries applied_ids exactly when the concept priors are shown", () => {
  it("MUST-FAIL: with the priors block in the prompt, the exact-schema section names \"applied_ids\"", async () => {
    const { decomposePrompt, renderConceptPriors } = await load();
    const priors = renderConceptPriors([DRAFTING, OTHER]);
    expect(priors).toContain(`[${DRAFTING.id}]`);
    const prompt = decomposePrompt("spec: compute must add 2", 4, "", `some principle\n${priors}`);
    const schema = schemaSection(prompt);
    expect(schema.length).toBeGreaterThan(0);
    expect(schema).toContain(`"applied_ids"`);
    expect(extraTopLevelFields(prompt)).toEqual(["applied_ids"]);
    // The same field the priors text and appliedConceptIds name.
    expect(priors).toContain(`"applied_ids"`);
  });

  it("CONTROL: with no priors shown, the schema asks for no applied_ids", async () => {
    const { decomposePrompt } = await load();
    for (const principles of ["", "ARCHITECTURAL: reuse an existing producer before minting a new one."]) {
      const prompt = decomposePrompt("spec: compute must add 2", 4, "", principles);
      expect(schemaSection(prompt).length).toBeGreaterThan(0);
      expect(prompt).not.toContain("applied_ids");
      expect(extraTopLevelFields(prompt)).toEqual([]);
    }
  });
});

describe("a schema-following drafter's cited prior reaches the concept_usage_record credit", () => {
  it("MUST-FAIL: the plan cites the shown prior, conceptsApplied.applied is that id, and its failure is credited", async () => {
    const { rec, seen, body } = await run("serve");
    expect(extraTopLevelFields(rec.decompose_prompt)).toEqual(["applied_ids"]);
    expect(seen.cited[0]).toEqual({ applied_ids: [DRAFTING.id] });
    expect(rec.verdict).toBe("UNFAVORABLE");
    expect(body.failure_kind).toBe("fix");
    expect(body.applied_concept_ids).toEqual([DRAFTING.id]);
    expect(rec.console.some((l) => l.includes(`[fc-concepts] plan applied: [${DRAFTING.id}]`))).toBe(true);
    expect(seen.usage).toEqual([{ concept_id: DRAFTING.id, outcome: "failure", trace_id: TRACE_ID }]);
    expect((body.concept_credits as Array<{ recorded: boolean }>).map((c) => c.recorded)).toEqual([true]);
  }, 60_000);

  it("CONTROL: with no priors shown, the schema asks for nothing, the drafter cites nothing and no credit is written", async () => {
    const { rec, seen, body } = await run("unreachable");
    expect(rec.decompose_prompt.length).toBeGreaterThan(0);
    expect(rec.decompose_prompt).not.toContain("CONCEPT PRIORS");
    expect(extraTopLevelFields(rec.decompose_prompt)).toEqual([]);
    expect(seen.cited.every((c) => Object.keys(c).length === 0)).toBe(true);
    expect(rec.verdict).toBe("UNFAVORABLE");
    expect(seen.usage).toEqual([]);
    expect(seen.usageLookups).toBe(0);
    expect(body.concept_credits).toBeUndefined();
  }, 60_000);
});
