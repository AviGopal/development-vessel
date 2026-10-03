import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

/**
 * llm_completion_dispatch DECLARES AND ENFORCES ITS REQUIRED INPUT (check-first, defense in depth).
 *
 * Gap: the-walk-invokes-llm-completion-dispatch-with-no-prompt-so-every-floor-llm-call-from-a-
 * satisfier-fails-before-any-provider.
 *
 * MEASURED, node 1, 2026-10-03. goal-host's walk invoked llm_completion_dispatch with a pointer of
 * the goal plus bookkeeping and no `prompt`. routes/impulses.ts (`case "llm_completion_dispatch"`)
 * hands the pointer to resolveLlmCompletionDispatch, which builds `prompt: pointer.prompt`
 * (undefined) and never checks it: it spent a discovery round trip, POSTed to every llm arm, and
 * each refused "body must include non-empty 'prompt' string" before any provider call. On the
 * learning side that refusal was then graded against a healthy model arm and the calling template.
 *
 * Two things this vessel owns, both pinned here:
 *
 *  1. ENFORCE. A missing / empty / whitespace / non-string prompt is the CALLER's fault and is
 *     known before any network call. The dispatcher returns
 *         { shape: "structuredError", body: { resolver: "llm_completion_dispatch",
 *                                             failure_mode: "malformed_request", field: "prompt", ... } }
 *     WITHOUT contacting any endpoint — not discovery, not an llm arm, not the federation egress.
 *     `malformed_request` is the token the learning side abstains on (llm-resolver's arm grading,
 *     activity-api's computeDeltas) and the failure class it records against the calling step.
 *
 *  2. DECLARE. Required inputs are declared through this vessel's `resolver_schema` answer, which
 *     goal-host reads at invocation time to bind a producer's required inputs before invoking it
 *     (goal-host test/required-inputs-are-bound-before-a-producer-is-invoked.test.ts). At base
 *     CONTRACTS has no llm_completion_dispatch entry, so the walk is told known:false. The contract
 *     must name `prompt` as required, with `synthesize_from: "goal_and_upstream"` — the per-field
 *     provenance that lets the walk synthesize it from the goal plus bound upstream content
 *     instead of matching on the field's name.
 *
 * Fetch is stubbed per test and restored; nothing reaches a real network.
 */

// ── CROSS-REPO CONTRACT FIXTURES (this file is the EMITTER's test: the canonical copies) ──────────
// Vessels cannot import the super-repo's packages/, so each consuming end copies these blocks
// verbatim (goal-host reads synthesize_from; llm-resolver and activity-api read malformed_request).
// Blocks are delimited so a super-repo check can compare the copies byte for byte.
// CONTRACT-FIXTURE synthesize_from BEGIN (emitter: development-vessel test/resolvers/llm-completion-dispatch-refuses-a-missing-prompt.test.ts)
const SYNTHESIZE_FROM_GOAL_AND_UPSTREAM = "goal_and_upstream";
// CONTRACT-FIXTURE synthesize_from END
// CONTRACT-FIXTURE malformed_request BEGIN (emitter: development-vessel test/resolvers/llm-completion-dispatch-refuses-a-missing-prompt.test.ts)
const MALFORMED_REQUEST = "malformed_request";
// CONTRACT-FIXTURE malformed_request END

const calls: Array<{ url: string; body: unknown }> = [];
const ORIGINAL_FETCH = globalThis.fetch;
const ROW = { vesselId: "llm-resolver-vessel", endpoint: "http://llm-arm:8220", resolve_endpoint: "/resolve", health_score: 1 };

function installFetch(): void {
  // @ts-expect-error — test stub
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    const isDiscovery = (body as { pointer?: { type?: string } } | undefined)?.pointer?.type === "vesselCapability";
    const data = isDiscovery ? { content: { found: true, vessels: [ROW] } } : { resolved: true, content: "a completion" };
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) } as Response;
  };
}
beforeEach(() => { calls.length = 0; installFetch(); });
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });
afterAll(() => { globalThis.fetch = ORIGINAL_FETCH; });

const { resolveLlmCompletionDispatch } = await import("../../src/resolvers/llm-completion-dispatch.js");
const { resolveResolverSchema } = await import("../../src/resolvers/resolver-schema.js");

type Body = Record<string, unknown>;

describe("MUST-FAIL — a missing prompt is refused as malformed_request before any network call", () => {
  const cases: Array<[string, unknown]> = [
    ["absent", undefined],
    ["empty", ""],
    ["whitespace", "  \n\t "],
    ["not a string", { text: "hi" }],
  ];
  for (const [label, prompt] of cases) {
    it(`prompt ${label}: structuredError failure_mode=malformed_request, and no fetch at all`, async () => {
      const pointer: Record<string, unknown> = { type: "llm_completion_dispatch", goal: "Explain why the sky is blue", dispatch_id: "d-1" };
      if (prompt !== undefined) pointer.prompt = prompt;
      const r = await resolveLlmCompletionDispatch(pointer as never);
      // Assert the no-network half first: at base the call goes out, and that is the defect.
      expect(calls.map((c) => c.url), "no endpoint (discovery, arm or egress) may be contacted").toEqual([]);
      expect(r.shape).toBe("structuredError");
      const b = r.body as Body;
      expect(b.failure_mode).toBe(MALFORMED_REQUEST);
      expect(b.resolver).toBe("llm_completion_dispatch");
      expect(b.field).toBe("prompt");
    });
  }
});

describe("CONTROL — a request with a prompt dispatches as before", () => {
  it("discovers an arm, POSTs the prompt, and returns the completion", async () => {
    const r = await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: "Explain why the sky is blue" });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const armCall = calls.find((c) => c.url === "http://llm-arm:8220/resolve");
    expect(armCall).toBeDefined();
    expect((armCall!.body as Body).prompt).toBe("Explain why the sky is blue");
    expect(r.shape).toBe("llmTextCompletion");
    expect((r.body as Body).text).toBe("a completion");
  });
});

describe("MUST-FAIL — resolver_schema declares llm_completion_dispatch's required input", () => {
  it("answers known:true with prompt required and synthesizable from the goal plus upstream content", () => {
    const b = resolveResolverSchema({ shape: "llm_completion_dispatch" }).body as Body;
    expect(b.known).toBe(true);
    expect(b.envelope).toBeUndefined(); // flat pointer: the dispatcher reads pointer.prompt
    expect(b.required).toEqual(["prompt"]);
    const prompt = (b.fields as Array<Body>).find((f) => f.name === "prompt");
    expect(prompt?.required).toBe(true);
    expect(prompt?.synthesize_from).toBe(SYNTHESIZE_FROM_GOAL_AND_UPSTREAM);
  });

  it("CONFORMANCE: a payload built from the declared required list is accepted and dispatched", async () => {
    const b = resolveResolverSchema({ shape: "llm_completion_dispatch" }).body as Body;
    expect(Array.isArray(b.required) && (b.required as string[]).length > 0, "the contract must declare its required inputs").toBe(true);
    const pointer: Record<string, unknown> = { type: "llm_completion_dispatch" };
    for (const f of (b.required as string[] | undefined) ?? []) pointer[f] = "Explain why the sky is blue";
    const r = await resolveLlmCompletionDispatch(pointer as never);
    expect(r.shape).toBe("llmTextCompletion");
  });
});
