// A PROMPT-CEILING REFUSAL IS TERMINAL (llm-completion-dispatch.ts budgetRefusalOf).
// Measured: llm-resolver refused a ~280k-token prompt before any provider call (prompt_ceiling:true), and this
// dispatcher cascaded past it to the remaining local endpoints and two federated arms, about 138 s per call, before the
// same refusal came back. A prompt too large for one arm is too large for every arm.
//
// Prompt text from a 5-word draw (EFF large list, research-watch/draw-words.sh):
//   seed=1793080964217547271 words=popular shrubbery retool poison proponent
import { afterAll, beforeEach, describe, expect, it } from "bun:test";

const PROMPT = "Which popular shrubbery should a proponent retool, and which is poison to the garden?";
const fetchCalls: string[] = [];
let mockResponses: Array<{ ok: boolean; status: number; data: unknown }> = [];
const install = () => {
  // @ts-expect-error — replace global fetch for tests
  globalThis.fetch = async (url: string) => {
    fetchCalls.push(String(url));
    const r = mockResponses.shift() ?? { ok: false, status: 503, data: null };
    return { ok: r.ok, status: r.status, json: async () => r.data, text: async () => JSON.stringify(r.data) } as Response;
  };
};
const ORIGINAL_FETCH = globalThis.fetch;
install();
afterAll(() => { globalThis.fetch = ORIGINAL_FETCH; });

const { resolveLlmCompletionDispatch } = await import("../../src/resolvers/llm-completion-dispatch.js");

const twoArms = { ok: true, status: 200, data: { content: { found: true, vessels: [
  { vesselId: "a", endpoint: "http://a:9999", resolve_endpoint: "/resolve", health_score: 0.9 },
  { vesselId: "b", endpoint: "http://b:9999", resolve_endpoint: "/resolve", health_score: 0.5 },
] } } };
const CEILING_ERROR = "prompt too large: ~279118 estimated input tokens exceeds the 200000-token ceiling (llmModelPolicy.max_input_tokens); refused before the provider call, no fallback";

describe("llm_completion_dispatch: a prompt-ceiling refusal is not cascaded", () => {
  beforeEach(() => { fetchCalls.length = 0; mockResponses = []; install(); });

  it("[MUST-FAIL] a local prompt_ceiling refusal returns at once: no second endpoint, no federated arm", async () => {
    mockResponses.push(twoArms);
    mockResponses.push({ ok: true, status: 200, data: { resolved: false, shape: "llmCompletion", prompt_ceiling: true, error: CEILING_ERROR } });
    mockResponses.push({ ok: true, status: 200, data: { content: "a second arm would have been sent the same prompt" } });
    const t0 = performance.now();
    const result = await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: PROMPT });
    const ms = performance.now() - t0;
    expect(result.shape).toBe("structuredError");
    const body = result.body as { failure_mode: string; detail: string };
    expect(body.failure_mode).toBe("prompt_ceiling");
    expect(body.detail).toBe(CEILING_ERROR);
    expect(fetchCalls).toEqual([expect.stringContaining("/resolve"), "http://a:9999/resolve"]);
    expect(ms).toBeLessThan(1000);
  });

  it("[MUST-FAIL] the refusal is recognised under content.body too (an arm reached over the federation transport)", async () => {
    mockResponses.push(twoArms);
    mockResponses.push({ ok: true, status: 200, data: { content: { body: { resolved: false, prompt_ceiling: true, error: CEILING_ERROR } } } });
    mockResponses.push({ ok: true, status: 200, data: { content: "a second arm would have been sent the same prompt" } });
    const result = await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: PROMPT });
    expect((result.body as { failure_mode: string }).failure_mode).toBe("prompt_ceiling");
    expect(fetchCalls).toEqual([expect.stringContaining("/resolve"), "http://a:9999/resolve"]);
  });

  it("CONTROL: an ordinary refusal still cascades to the next endpoint, which answers", async () => {
    mockResponses.push(twoArms);
    mockResponses.push({ ok: true, status: 200, data: { resolved: false, error: "provider unavailable" } });
    mockResponses.push({ ok: true, status: 200, data: { content: "answered by the second arm" } });
    const result = await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: PROMPT });
    expect(result.shape).not.toBe("structuredError");
    expect(fetchCalls).toEqual([expect.stringContaining("/resolve"), "http://a:9999/resolve", "http://b:9999/resolve"]);
  });

  it("CONTROL: a dispatch-budget refusal is still terminal and keeps its own failure mode", async () => {
    mockResponses.push(twoArms);
    mockResponses.push({ ok: true, status: 200, data: { resolved: false, dispatch_budget_exhausted: true, dispatch_budget: { cap_input_tokens: 1 }, error: "dispatch input-token budget spent" } });
    const result = await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: PROMPT });
    expect((result.body as { failure_mode: string }).failure_mode).toBe("dispatch_budget_exhausted");
    expect(fetchCalls).toEqual([expect.stringContaining("/resolve"), "http://a:9999/resolve"]);
  });
});
