import { expect, test } from "bun:test";
import { executionTrace } from "../../src/resolvers/execution-trace.js";

test("executionTrace returns expected shape", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ ok: true, trace: "mock" }), { status: 200 });
    };
    const res = await executionTrace({ test: 1 });
    expect(res).toEqual({ shape: "execution_trace", body: { ok: true, trace: "mock" } });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("executionTrace throws on non-2xx", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 500 });
    await expect(executionTrace({})).rejects.toThrow("execution-trace fetch failed: 500");
  } finally {
    globalThis.fetch = origFetch;
  }
});
