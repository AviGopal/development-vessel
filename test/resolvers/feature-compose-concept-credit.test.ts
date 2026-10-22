// THE ATTEMPT OUTCOME GRADES THE PRIORS THE DRAFTER APPLIED, AND ONLY THOSE.
//
// THE DEFECT: no attempt record named the priors the drafter actually applied, so whether applying one made an attempt
// pass or fail was recorded nowhere, and a prior with the wrong cause read as confidently as one with the right cause.
// Crediting every LOADED prior would carry no attribution either: most composes load the same rows.
//
// The fix: each rendered prior carries its concept id, the plan names the ids it applied ("applied_ids"), the compose
// keeps only ids it actually rendered, records them on its trace and report, and once its own verdict is known
// credits exactly those ids through the existing concept_usage_record shape (routed by shape to this substrate's own
// producer, keyed to the compose's trace): a verified landing is a success, a draft the checks judged is a failure.
//
// The compose cases drive the REAL entry point over the drafter-split harness corpus; the harness router is wrapped,
// not edited (the shim answers the selector, the usage-record producer and the trace store, and adds applied_ids to
// the scripted plan). The usage-record resolver is the boundary mocked here.
//
// MUST-FAIL: a prior applied in a FAILED attempt has its failure recorded through concept_usage_record.
// CONTROL: a prior that was loaded (rendered) but not applied in the same attempt is not credited either way; an id
//   the plan cites that was never rendered is dropped.
// MUTANTS (seen red): no credit step (the parent tree); every rendered prior credited; the outcome mapping never
//   yields failure.
import { afterAll, describe, expect, it } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("fc-concept-credit", { superRepo: true, who: "test/resolvers/feature-compose-concept-credit.test.ts" });
const { createHarness, CORPUS } = await import("../drafter-split/harness.js");
const H = createHarness(ROOT, RUNTIME);
afterAll(() => { H.restore(); });

const CONCEPTS = "http://concepts.fc-credit-fixture";
const TRACE_ID = "exec_fixture_trace";
const DRAFTING = { id: "concept_fixture_drafting", source_type: "human_input", name: null, content: "Drafting discipline for code edits: every identifier must already exist in the grounding or be introduced by the same plan." };
const OTHER = { id: "concept_fixture_other", source_type: "vessel_construction_pattern", name: "resolver contract", content: "Vessels expose POST /resolve with an impulse pointer body." };
const INVENTED = "concept_fixture_never_rendered";

type Usage = { concept_id: unknown; outcome: unknown; trace_id: unknown };
type Seen = { usage: Usage[]; usageLookups: number };

function shim(fc: { resolveFeatureCompose: (p: unknown) => Promise<{ body: Record<string, unknown> }> }, appliedIds: string[], seen: Seen) {
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
          return Response.json({ success: true, shape: "conceptPromptPriors", body: { selected: [DRAFTING, OTHER] } });
        }
        if (url.startsWith(CONCEPTS) && ptr.type === "concept_usage_record") {
          seen.usage.push({ concept_id: ptr.concept_id, outcome: ptr.outcome, trace_id: ptr.trace_id });
          return Response.json({ success: true, shape: "conceptUsageRecorded", body: { concept_id: ptr.concept_id, trace_id: ptr.trace_id, outcome: ptr.outcome, usage_record_id: "usage_fixture" } });
        }
        if (url.endsWith("/v2/activities/executions")) return Response.json({ execution_id: TRACE_ID });
        if (typeof body?.prompt === "string" && body.prompt.includes("decomposing a feature specification")) {
          const r = await router(input, init);
          const j = (await r.json()) as { content: string };
          const plan = JSON.parse(j.content) as Record<string, unknown>;
          return Response.json({ ...j, content: JSON.stringify({ ...plan, applied_ids: appliedIds }) });
        }
        return router(input, init);
      }) as typeof fetch;
      try { return await fc.resolveFeatureCompose(p); } finally { globalThis.fetch = router as typeof fetch; }
    },
  };
}

const RED = CORPUS.find((f) => f.name === "directed / verify red")!;
let seq = 0;
const load = async () => await import(`../../src/resolvers/feature-compose.ts?fc-concept-credit=${++seq}`);
const run = async (fixture: typeof RED, applied: string[]) => {
  H.install();
  const seen: Seen = { usage: [], usageLookups: 0 };
  let body: Record<string, unknown> = {};
  const rec = await H.run(shim(await load(), applied, seen), fixture, (b) => { body = b; });
  return { rec, seen, body };
};

describe("a failed attempt credits its failure to exactly the priors the drafter applied", () => {
  it("MUST-FAIL: the applied prior's failure is recorded through concept_usage_record, keyed to the compose's trace", async () => {
    const { rec, seen, body } = await run(RED, [DRAFTING.id, INVENTED]);
    expect(rec.verdict).toBe("UNFAVORABLE");
    expect(body.failure_kind).toBe("fix");
    expect(seen.usage).toEqual([{ concept_id: DRAFTING.id, outcome: "failure", trace_id: TRACE_ID }]);
    expect(body.applied_concept_ids).toEqual([DRAFTING.id]);
    expect((body.concept_credits as Array<{ recorded: boolean }>).map((c) => c.recorded)).toEqual([true]);
    expect(rec.console.some((l) => l.includes(`[fc-concepts] plan applied: [${DRAFTING.id}]; dropped, not shown to it: [${INVENTED}]`))).toBe(true);
    expect(rec.console.some((l) => l.includes(`[fc-concepts] credit concept=${DRAFTING.id} outcome=failure recorded`))).toBe(true);
  }, 60_000);

  it("CONTROL: a prior loaded but not applied is not credited; the applied one alone is", async () => {
    const { seen } = await run(RED, [OTHER.id]);
    expect(seen.usage).toEqual([{ concept_id: OTHER.id, outcome: "failure", trace_id: TRACE_ID }]);
    expect(seen.usage.some((u) => u.concept_id === DRAFTING.id)).toBe(false);
  }, 60_000);

  it("CONTROL: a plan that applies nothing credits nothing and makes no usage-record lookup", async () => {
    const { seen, body } = await run(RED, []);
    expect(seen.usage).toEqual([]);
    expect(seen.usageLookups).toBe(0);
    expect(body.concept_credits).toBeUndefined();
  }, 60_000);
});

describe("conceptCreditOutcome", () => {
  it("success only for a verified landing, failure only for a judged draft, otherwise not credited", async () => {
    const { conceptCreditOutcome } = await load();
    expect(conceptCreditOutcome({ verdict: "FAVORABLE", landed: true, dissent: false, failureKind: null })).toBe("success");
    expect(conceptCreditOutcome({ verdict: "FAVORABLE", landed: false, dissent: false, failureKind: null })).toBeNull();
    expect(conceptCreditOutcome({ verdict: "FAVORABLE", landed: true, dissent: true, failureKind: null })).toBeNull();
    expect(conceptCreditOutcome({ verdict: "UNFAVORABLE", landed: false, dissent: false, failureKind: "fix" })).toBe("failure");
    expect(conceptCreditOutcome({ verdict: "UNFAVORABLE", landed: false, dissent: false, failureKind: "environment" })).toBeNull();
    expect(conceptCreditOutcome({ verdict: "UNFAVORABLE", landed: false, dissent: false, failureKind: "terminal_refusal" })).toBeNull();
    expect(conceptCreditOutcome({ verdict: "BUSY", landed: false, dissent: false, failureKind: null })).toBeNull();
  });
});

describe("creditAppliedConcepts", () => {
  it("journals a refused or failed credit instead of swallowing it", async () => {
    const { creditAppliedConcepts } = await load();
    const lines: string[] = [];
    const warn = console.warn, log = console.log;
    console.warn = (...a: unknown[]) => { lines.push(a.join(" ")); };
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      const out = await creditAppliedConcepts(["concept_fixture_a", "concept_fixture_b"], "failure", TRACE_ID, async (p: { concept_id: string }) => {
        if (p.concept_id === "concept_fixture_a") throw new Error("Unable to connect");
        return { shape: "structuredError", body: { detail: "usage POST returned 404" } };
      });
      expect(out.map((c: { recorded: boolean }) => c.recorded)).toEqual([false, false]);
    } finally { console.warn = warn; console.log = log; }
    expect(lines.some((l) => l.includes("concept=concept_fixture_a outcome=failure NOT recorded: Unable to connect"))).toBe(true);
    expect(lines.some((l) => l.includes("concept=concept_fixture_b outcome=failure NOT recorded: structuredError"))).toBe(true);
  });
});

describe("appliedConceptIds", () => {
  it("keeps only rendered ids, deduped; a missing or malformed field applies nothing", async () => {
    const { appliedConceptIds } = await load();
    expect(appliedConceptIds({ applied_ids: ["[a]", "a", "b", 7, "zz"] }, ["a", "b", "c"])).toEqual({ applied: ["a", "b"], dropped: ["zz"] });
    expect(appliedConceptIds({ ops: [] }, ["a"])).toEqual({ applied: [], dropped: [] });
    expect(appliedConceptIds({ applied_ids: "a" }, ["a"])).toEqual({ applied: [], dropped: [] });
    expect(appliedConceptIds(null, ["a"])).toEqual({ applied: [], dropped: [] });
  });
});
