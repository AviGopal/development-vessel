import { describe, it, expect, mock, beforeEach, afterAll} from "bun:test";

// Mock fetch before importing the resolver so the module picks up the mock.
const fetchCalls: { url: string; body: unknown }[] = [];
let mockResponses: Array<{ ok: boolean; status: number; data: unknown }> = [];

const mockFetch = mock(async (url: string, init?: RequestInit) => {
  fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
  const response = mockResponses.shift() ?? { ok: false, status: 503, data: null };
  return {
    ok: response.ok,
    status: response.status,
    json: async () => response.data,
    text: async () => JSON.stringify(response.data),
  } as Response;
});

// This install is at MODULE SCOPE (it must be, so the resolver below imports against
// the mock), which means nothing scoped to a test hook ever takes it back down. Without
// the afterAll restore, this file leaks its mock into every suite bun runs afterwards:
// a leaked mock answers instantly with a canned 200, so any later test that needs a REAL
// network failure — "degrades to reachable=false on unreachable endpoint", "timeout to
// non-routable host" — silently succeeds and asserts red. Reproduced:
// `bun test llm-completion-dispatch.test.ts discovery-vessel-registry-observer.test.ts`
// fails 2, while the victim alone passes 3/0.
const ORIGINAL_FETCH = globalThis.fetch;
// @ts-expect-error — replace global fetch for tests
globalThis.fetch = mockFetch;
afterAll(() => { globalThis.fetch = ORIGINAL_FETCH; });

// Import AFTER installing the mock.
const { resolveLlmCompletionDispatch } = await import(
  "../../src/resolvers/llm-completion-dispatch.js"
);

describe("resolveLlmCompletionDispatch", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    mockResponses = [];
    mockFetch.mockReset();
    // Re-install the recording mock after reset.
    // @ts-expect-error
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const response = mockResponses.shift() ?? { ok: false, status: 503, data: null };
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.data,
        text: async () => JSON.stringify(response.data),
      } as Response;
    };
  });

  it("returns structuredError when discovery finds no vessels", async () => {
    // Discovery returns empty vessels array.
    mockResponses.push({
      ok: true,
      status: 200,
      data: { content: { vessels: [], found: false } },
    });

    const result = await resolveLlmCompletionDispatch({
      type: "llm_completion_dispatch",
      prompt: "Say hello.",
    });

    expect(result.shape).toBe("structuredError");
    const body = result.body as { failure_mode: string; detail: string };
    expect(body.failure_mode).toBe("cascading");
    expect(body.detail).toContain("No vessel advertising llm_completion");
  });

  it("returns llm_completion_result on success", async () => {
    // Discovery returns one vessel.
    mockResponses.push({
      ok: true,
      status: 200,
      data: {
        content: {
          found: true,
          vessels: [{ vesselId: "conv-vessel-1", endpoint: "http://conv-vessel:9999", resolve_endpoint: "/resolve/llm", health_score: 1.0 }],
        },
      },
    });
    // LLM vessel responds successfully.
    mockResponses.push({
      ok: true,
      status: 200,
      data: { success: true, data: '{"id":"gap-closing:fp-11","tasks":[]}' },
    });

    const result = await resolveLlmCompletionDispatch({
      type: "llm_completion_dispatch",
      prompt: "Draft a template.",
      system_prompt: "Be concise.",
      model: "anthropic/claude-haiku-4-5-20251001",
    });

    expect(result.shape).toBe("llm_completion_result");
    const body = result.body as { text: string; model: string };
    expect(typeof body.text).toBe("string");
    expect(body.text.length).toBeGreaterThan(0);
    expect(body.model).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("returns structuredError when discovery call fails", async () => {
    mockResponses.push({ ok: false, status: 503, data: {} });

    const result = await resolveLlmCompletionDispatch({
      type: "llm_completion_dispatch",
      prompt: "hello",
    });

    expect(result.shape).toBe("structuredError");
    const body = result.body as { failure_mode: string };
    expect(body.failure_mode).toBe("cascading");
  });

  it("returns structuredError when LLM vessel returns success=false", async () => {
    mockResponses.push({
      ok: true,
      status: 200,
      data: { content: { found: true, vessels: [{ vesselId: "cv", endpoint: "http://cv:9999", resolve_endpoint: "/resolve/llm" }] } },
    });
    mockResponses.push({
      ok: true,
      status: 200,
      data: { success: false, error: "LLM API key missing" },
    });

    const result = await resolveLlmCompletionDispatch({
      type: "llm_completion_dispatch",
      prompt: "hello",
    });

    expect(result.shape).toBe("structuredError");
    const body = result.body as { failure_mode: string };
    expect(body.failure_mode).toBe("verifier_negative");
  });

  it("picks the vessel with highest health_score", async () => {
    mockResponses.push({
      ok: true,
      status: 200,
      data: {
        content: {
          found: true,
          vessels: [
            { vesselId: "low", endpoint: "http://low:9999", resolve_endpoint: "/resolve/llm", health_score: 0.2 },
            { vesselId: "high", endpoint: "http://high:9999", resolve_endpoint: "/resolve/llm", health_score: 0.9 },
          ],
        },
      },
    });
    mockResponses.push({
      ok: true,
      status: 200,
      data: { success: true, data: "response" },
    });

    await resolveLlmCompletionDispatch({
      type: "llm_completion_dispatch",
      prompt: "test",
    });

    const llmCall = fetchCalls[1];
    expect(llmCall?.url).toContain("high:9999");
  });
});
