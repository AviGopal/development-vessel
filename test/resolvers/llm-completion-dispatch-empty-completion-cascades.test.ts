import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

/**
 * AN EMPTY COMPLETION IS NOT A WINNER.
 *
 * llm-resolver answers `{resolved:true, content:""}` when a model spends its budget on hidden
 * reasoning, runs its tool loop out, or returns an empty turn. The endpoint loop's guard read only
 * error/resolved/success, so that body won and the loop stopped; the tail then THREW "LLM
 * completion did not return text or tool_calls", which the route turned into HTTP 500. Every other
 * endpoint and federated arm went untried, and the caller saw a transport-looking failure.
 *
 * CONTRACT (pinned):
 *  - An answer with no text (null, "" or whitespace) and no tool_calls is a verifier_negative for
 *    that arm, and the cascade continues; the coming resolver form
 *    `{resolved:false, error:"empty_completion"}` is the same class.
 *  - When every arm that answered answered empty, the result is a structuredError with
 *    failure_mode "empty_completion" naming the model(s) and stop_reason, with those fields FIRST
 *    in the body and in `detail`. Nothing is thrown.
 *  - CONTROL: a first-endpoint text answer is byte-identical to what it was.
 *
 * Endpoints: two local arms with no substrate suffix, so no federated egress URL is derived.
 * Fetch is stubbed per URL; nothing reaches a real network.
 */

const ROWS = [
  { vesselId: "llm-resolver-vessel", endpoint: "http://local-a:8220", resolve_endpoint: "/resolve", health_score: 1 },
  { vesselId: "llm-resolver-google", endpoint: "http://local-b:8220", resolve_endpoint: "/resolve", health_score: 0.6 },
];
const A = "http://local-a:8220/resolve";
const B = "http://local-b:8220/resolve";

let answerFor: (url: string) => unknown = () => ({ resolved: true, content: "" });
const calls: string[] = [];
const ORIGINAL = { fetch: globalThis.fetch, error: console.error, warn: console.warn, log: console.log };

beforeEach(() => {
  calls.length = 0;
  // @ts-expect-error — test stub
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if ((body as { pointer?: { type?: string } } | undefined)?.pointer?.type === "vesselCapability") {
      const data = { content: { found: true, vessels: ROWS } };
      return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) } as Response;
    }
    const u = String(url);
    calls.push(u);
    const data = answerFor(u);
    if (data === "connect") throw new TypeError("Unable to connect. Is the computer able to access the url?");
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) } as Response;
  };
  const quiet = () => {};
  console.error = quiet; console.warn = quiet; console.log = quiet;
});
const restore = () => { globalThis.fetch = ORIGINAL.fetch; console.error = ORIGINAL.error; console.warn = ORIGINAL.warn; console.log = ORIGINAL.log; };
afterEach(restore);
afterAll(restore);

const { resolveLlmCompletionDispatch } = await import("../../src/resolvers/llm-completion-dispatch.js");
type Body = Record<string, unknown>;
const dispatch = () => resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: "Explain why the sky is blue" });

const EMPTY_FORMS: Array<[string, Record<string, unknown>]> = [
  ['content:""', { resolved: true, shape: "llmCompletion", content: "", provider: "openai", model: "cohere/north-mini-code:free" }],
  ["content:null", { resolved: true, shape: "llmCompletion", content: null, model: "google/gemini-2.5-flash" }],
  ["content:whitespace", { resolved: true, shape: "llmCompletion", content: "  \n\t ", model: "openai/gpt-5" }],
  ['content:[{text:""}]', { resolved: true, content: [{ text: "" }], model: "openai/gpt-4o-mini" }],
  ['content:{value:""}', { resolved: true, content: { value: "" }, model: "deepseek/deepseek-chat-v3-0324" }],
  ['resolved:false, error:"empty_completion"', { resolved: false, error: "empty_completion", stop_reason: "max_tokens", model: "openai/gpt-5" }],
];

describe("MUST-FAIL — endpoint A answers empty, endpoint B answers text: B's text wins", () => {
  for (const [label, empty] of EMPTY_FORMS) {
    it(`A returns ${label}`, async () => {
      answerFor = (u) => (u === A ? empty : { resolved: true, content: "Rayleigh scattering.", model: "b-model" });
      const r = await dispatch();
      expect(calls).toEqual([A, B]);
      expect(r.shape).toBe("llmTextCompletion");
      expect((r.body as Body).text).toBe("Rayleigh scattering.");
      expect((r.body as Body).model).toBe("b-model");
    });
  }
});

describe("MUST-FAIL — every endpoint answers empty: a structuredError empty_completion, nothing thrown", () => {
  it("names the model(s), carries stop_reason, and puts those fields first", async () => {
    answerFor = (u) => (u === A
      ? { resolved: true, shape: "llmCompletion", content: "", provider: "openai", model: "cohere/north-mini-code:free" }
      : { resolved: true, shape: "llmCompletion", content: "", model: "openai/gpt-5", stop_reason: "max_tokens", iterations: 20 });
    let r: Awaited<ReturnType<typeof dispatch>> | undefined;
    let thrown: unknown;
    try { r = await dispatch(); } catch (e) { thrown = e; }
    expect(thrown).toBeUndefined();
    expect(calls).toEqual([A, B]);
    expect(r!.shape).toBe("structuredError");
    const b = r!.body as Body;
    expect(b.failure_mode).toBe("empty_completion");
    expect(b.models).toEqual(["cohere/north-mini-code:free", "openai/gpt-5"]);
    expect(b.stop_reason).toBe("max_tokens");
    expect(b.iterations).toBe(20);
    expect(Object.keys(b)[0]).toBe("failure_mode");
    expect(String(b.detail).startsWith("empty_completion models=cohere/north-mini-code:free,openai/gpt-5")).toBe(true);
    expect(String(b.detail)).toContain("stop_reason=max_tokens");
    // The fields survive a 200-character cut of the serialized envelope the route returns.
    const wire = JSON.stringify({ success: false, shape: r!.shape, body: b }).slice(0, 200);
    expect(wire).toContain('"failure_mode":"empty_completion"');
    expect(wire).toContain("openai/gpt-5");
    const failures = b.failures as Array<Body>;
    expect(failures.map((f) => f.endpoint)).toEqual([A, B]);
    for (const f of failures) expect(f.failure_mode).toBe("verifier_negative");
  });

  it("the resolver's own empty_completion refusal on every arm is the same class", async () => {
    answerFor = () => ({ resolved: false, error: "empty_completion", model: "openai/gpt-4o-mini", stop_reason: "tool_loop_exhausted" });
    const r = await dispatch();
    expect(r.shape).toBe("structuredError");
    const b = r.body as Body;
    expect(b.failure_mode).toBe("empty_completion");
    expect(b.models).toEqual(["openai/gpt-4o-mini"]);
    expect(b.stop_reason).toBe("tool_loop_exhausted");
  });

  it("the arm that ANSWERED empty is named: served_model, not the drawn or requested arm (nested and top-level refusals)", async () => {
    const refusal = { resolved: false, error: "empty_completion", served_model: "Y", model: "X", requested_model: "X" };
    answerFor = (u) => (u === A ? { content: { body: refusal } } : refusal);
    const r = await dispatch();
    expect(r.shape).toBe("structuredError");
    const b = r.body as Body;
    expect(b.failure_mode).toBe("empty_completion");
    expect(b.models).toEqual(["Y"]);
    expect(String(b.detail).startsWith("empty_completion models=Y requested=X")).toBe(true);
    const failures = b.failures as Array<Body>;
    expect(failures.map((f) => [f.model, f.requested_model])).toEqual([["Y", "X"], ["Y", "X"]]);
    for (const f of failures) expect(String(f.detail).startsWith("empty_completion model=Y requested=X")).toBe(true);
  });

  it("an arm that could not be reached does not hide that the arms that answered were empty", async () => {
    answerFor = (u) => (u === A ? "connect" : { resolved: true, content: "", model: "m-b" });
    const r = await dispatch();
    expect((r.body as Body).failure_mode).toBe("empty_completion");
    expect((r.body as Body).models).toEqual(["m-b"]);
    expect(((r.body as Body).failures as Array<Body>).map((f) => f.failure_mode)).toEqual(["cascading", "verifier_negative"]);
  });

  it("a real refusal on one arm and an empty answer on the other keeps the refusal's reason (not empty_completion)", async () => {
    answerFor = (u) => (u === A ? { resolved: false, error: "body must include non-empty 'prompt' string" } : { resolved: true, content: "" });
    const r = await dispatch();
    expect(r.shape).toBe("structuredError");
    const b = r.body as Body;
    expect(b.failure_mode).toBe("verifier_negative");
    expect(String(b.detail)).toContain("non-empty 'prompt'");
  });
});

describe("CONTROL — a first-endpoint answer is byte-identical to before", () => {
  it("text answer: the full returned object, in key order", async () => {
    const usage = { input_tokens: 11, output_tokens: 7 };
    answerFor = () => ({ resolved: true, shape: "llmCompletion", content: "Rayleigh scattering.", model: "served-model", usage, tool_calls: [{ iteration: 1, tool_name: "fs_read" }] });
    const r = await dispatch();
    expect(calls).toEqual([A]);
    expect(JSON.stringify(r)).toBe(JSON.stringify({
      shape: "llmTextCompletion",
      body: { text: "Rayleigh scattering.", model: "served-model", requested_model: "auto", usage, executed_tool_calls: [{ iteration: 1, tool_name: "fs_read" }] },
    }));
    expect(Object.keys(r.body as Body)).toEqual(["text", "model", "requested_model", "usage", "executed_tool_calls"]);
    expect(r).toEqual({
      shape: "llmTextCompletion",
      body: { text: "Rayleigh scattering.", model: "served-model", requested_model: "auto", usage, executed_tool_calls: [{ iteration: 1, tool_name: "fs_read" }] },
    });
  });

  it("text answer with no usage or tool executions: usage key kept as undefined", async () => {
    answerFor = () => ({ resolved: true, content: "ok" });
    const r = await dispatch();
    expect(Object.keys(r.body as Body)).toEqual(["text", "model", "requested_model", "usage"]);
    expect(JSON.stringify(r)).toBe(JSON.stringify({ shape: "llmTextCompletion", body: { text: "ok", model: "auto", requested_model: "auto" } }));
  });

  it("caller-run tool_calls with empty text are not empty: returned as llmToolCalls from the first endpoint", async () => {
    answerFor = () => ({ resolved: true, content: { value: "", tool_calls: [{ name: "fs_read", input: { path: "x" } }] } });
    const r = await dispatch();
    expect(calls).toEqual([A]);
    expect(JSON.stringify(r)).toBe(JSON.stringify({ shape: "llmToolCalls", body: { tool_calls: [{ name: "fs_read", input: { path: "x" } }] } }));
  });
});
