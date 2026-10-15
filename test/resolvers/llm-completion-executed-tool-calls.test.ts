import { describe, it, expect, beforeEach, afterAll } from "bun:test";

// The llm-resolver runs its own tool loop and reports the tools it EXECUTED as a top-level
// `tool_calls` array next to the final text. On the llmTextCompletion path the dispatcher must
// carry that array through as `executed_tool_calls`; otherwise the goal-host floor reads a
// grounded, tool-using answer as a zero-tool completion. Fixtures only: fetch is mocked.
let mockResponses: Array<{ ok: boolean; status: number; data: unknown }> = [];

const ORIGINAL_FETCH = globalThis.fetch;
const install = () => {
  // @ts-expect-error — replace global fetch for tests
  globalThis.fetch = async () => {
    const response = mockResponses.shift() ?? { ok: false, status: 503, data: null };
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.data,
      text: async () => JSON.stringify(response.data),
    } as Response;
  };
};
install();
afterAll(() => { globalThis.fetch = ORIGINAL_FETCH; });

const { resolveLlmCompletionDispatch } = await import(
  "../../src/resolvers/llm-completion-dispatch.js"
);

const discovery = {
  ok: true,
  status: 200,
  data: { content: { found: true, vessels: [{ vesselId: "llm", endpoint: "http://llm:9999", resolve_endpoint: "/resolve" }] } },
};

const executed = [
  { iteration: 1, tool_name: "fs_read", tool_input: { path: "README.md" }, tool_output: "# readme", duration_ms: 12 },
  { iteration: 2, tool_name: "shellResult", tool_input: { command: "ls" }, tool_output: { error: "denied" }, duration_ms: 3 },
];

describe("llm_completion_dispatch passes executed tool calls through", () => {
  beforeEach(() => {
    mockResponses = [];
    install();
  });

  it("a resolver response with top-level tool_calls yields body.executed_tool_calls equal to them", async () => {
    mockResponses.push(discovery);
    mockResponses.push({
      ok: true,
      status: 200,
      data: { resolved: true, shape: "llmCompletion", content: "grounded answer", model: "m-1", tool_calls: executed, usage: { input_tokens: 10, output_tokens: 5 } },
    });

    const result = await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: "read the readme", model: "m-1" });

    expect(result.shape).toBe("llmTextCompletion");
    const body = result.body as Record<string, unknown>;
    expect(body.executed_tool_calls).toEqual(executed);
    expect(body.text).toBe("grounded answer");
  });

  it("without tool_calls the body is exactly what it was before: no executed_tool_calls key", async () => {
    mockResponses.push(discovery);
    mockResponses.push({
      ok: true,
      status: 200,
      data: { resolved: true, shape: "llmCompletion", content: "plain answer", model: "m-2", fallback_from: "m-1", usage: { input_tokens: 4, output_tokens: 2 } },
    });

    const result = await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: "hi", model: "m-1" });

    expect(result.shape).toBe("llmTextCompletion");
    expect(result.body).toEqual({
      text: "plain answer",
      model: "m-2",
      requested_model: "m-1",
      fallback_from: "m-1",
      usage: { input_tokens: 4, output_tokens: 2 },
    });
    expect(Object.keys(result.body as object)).not.toContain("executed_tool_calls");
  });

  it("the llmToolCalls path is unchanged: content-level tool_calls still return only tool_calls", async () => {
    const pending = [{ id: "t1", name: "fs_read", input: { path: "x" } }];
    mockResponses.push(discovery);
    mockResponses.push({
      ok: true,
      status: 200,
      data: { resolved: true, content: { tool_calls: pending }, tool_calls: executed },
    });

    const result = await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: "use a tool" });

    expect(result.shape).toBe("llmToolCalls");
    expect(result.body).toEqual({ tool_calls: pending });
  });
});
