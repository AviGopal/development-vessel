// THE CALLER'S SIGNAL REACHES THE LLM REQUEST: a caller that gives up on llm_completion_dispatch
// stops the paid model request, and a long-running compose still outlives its caller.
import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A slow "model" endpoint that records whether its request was aborted by the caller.
const seen: { started: number; aborted: number } = { started: 0, aborted: 0 };
const model = Bun.serve({ port: 0, async fetch(req) {
  seen.started++;
  req.signal.addEventListener("abort", () => { seen.aborted++; });
  await Bun.sleep(3_000);
  return Response.json({ content: "late", usage: { input_tokens: 1, output_tokens: 1 } });
} });
process.env["LLM_COMPLETION_ENDPOINT"] = `http://127.0.0.1:${model.port}/resolve`;
const { runWithRequestSignal, outboundSignal, currentRequestSignal } = await import("../../src/lib/request-signal.js");
const { resolveLlmCompletionDispatch } = await import("../../src/resolvers/llm-completion-dispatch.js");
afterAll(() => { model.stop(true); delete process.env["LLM_COMPLETION_ENDPOINT"]; });
const SRC = (p: string) => readFileSync(join(import.meta.dir, "..", "..", "src", p), "utf8");

describe("outboundSignal", () => {
  it("[UNIT] outside a request and with no deadline there is no signal (in-process callers unchanged)", () => {
    expect(currentRequestSignal()).toBeUndefined();
    expect(outboundSignal()).toBeUndefined();
  });
  it("[UNIT] inside a request it follows the request; a deadline aborts on its own", async () => {
    const ctl = new AbortController();
    const s = runWithRequestSignal(ctl.signal, () => outboundSignal())!;
    expect(s.aborted).toBe(false);
    ctl.abort();
    expect(s.aborted).toBe(true);
    const d = outboundSignal(50)!;
    await Bun.sleep(120);
    expect(d.aborted).toBe(true);
  });
});

describe("llm_completion_dispatch under the caller's signal", () => {
  it("[MUST-FAIL] the caller gives up after 200 ms: the model request is aborted and the dispatch returns at once", async () => {
    const before = { ...seen };
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const t0 = Date.now();
    const r = await runWithRequestSignal(ctl.signal, () => resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: "hello" }));
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.shape).toBe("structuredError");
    await Bun.sleep(50);
    expect(seen.started - before.started).toBeGreaterThanOrEqual(1);
    expect(seen.aborted - before.aborted).toBe(seen.started - before.started);
  });
  it("[MUST-FAIL] the pointer's own timeout_ms bounds each model request", async () => {
    const t0 = Date.now();
    const r = await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: "hello", timeout_ms: 300 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.shape).toBe("structuredError");
  });
  it("[CONTROL] no signal and no deadline: the request runs to its answer, as before", async () => {
    const r = await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: "hello" });
    expect(r.shape).not.toBe("structuredError");
  }, 10_000);
});

describe("[WIRING] the resolve route carries the request's signal; long-running work keeps its own", () => {
  it("both resolve routes pass c.req.raw.signal into resolveDispatch, which runs the dispatch under it", () => {
    const src = SRC("routes/impulses.ts");
    expect(src).toContain("const result = await runWithRequestSignal(opts.signal, () => dispatchInner(pointer));");
    expect(src.match(/\{ signal: c\.req\.raw\.signal \}\)/g)?.length).toBe(2);
  });
  it("every model request and the discovery lookup carry a signal", () => {
    const src = SRC("resolvers/llm-completion-dispatch.ts");
    expect(src.match(/signal: callSignal\(\),/g)?.length).toBe(2);
    expect(src).toContain("signal: AbortSignal.timeout(5_000),");
  });
  it("[HELD-OUT] the long-running rebuild does NOT forward the caller's signal: a compose outlives its caller", () => {
    const src = SRC("index.ts");
    const at = src.indexOf("forwarded = new Request(req.url, {");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 200)).not.toContain("signal");
  });
});
