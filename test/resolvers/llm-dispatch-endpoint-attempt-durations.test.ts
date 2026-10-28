// ONE LINE PER ENDPOINT ATTEMPT (llm-completion-dispatch.ts noteAttempt; routing locality step 1: measure first).
// Measured only by inference: a cascade spent ~138 s in the remaining local endpoints before the federated arms answered,
// and no line said which endpoint took the time. Each attempt now logs its index, phase, kind, duration and outcome, and a
// failed dispatch's per-endpoint `failures` entries carry the same duration. Ordering and outcome are unchanged.
//
// Prompt text from a 5-word draw (EFF large list, research-watch/draw-words.sh):
//   seed=1793094420768793127 words=rehire cactus cringing sandstone sprung
import { afterAll, beforeEach, describe, expect, it } from "bun:test";

const PROMPT = "Would you rehire the gardener who left the cactus cringing on sprung sandstone?";
const calls: string[] = [];
type Answer = { delayMs?: number; status?: number; data: unknown; throws?: boolean };
let answers: Answer[] = [];
const install = () => {
  // @ts-expect-error — replace global fetch for tests
  globalThis.fetch = async (url: string) => {
    calls.push(String(url));
    const a = answers.shift() ?? { status: 503, data: null };
    if (a.delayMs) await new Promise((r) => setTimeout(r, a.delayMs));
    if (a.throws) throw new Error("connect ECONNREFUSED");
    const status = a.status ?? 200;
    return { ok: status < 400, status, json: async () => a.data, text: async () => JSON.stringify(a.data) } as Response;
  };
};
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;
install();
afterAll(() => { globalThis.fetch = ORIGINAL_FETCH; console.log = ORIGINAL_LOG; });

const { resolveLlmCompletionDispatch } = await import("../../src/resolvers/llm-completion-dispatch.js");

const A = "http://a.example:9999/resolve", B = "http://b.example:9999/resolve", C = "http://127.0.0.1:9998/resolve";
const threeArms = { data: { content: { found: true, vessels: [
  { vesselId: "a", endpoint: "http://a.example:9999", resolve_endpoint: "/resolve", health_score: 0.9 },
  { vesselId: "b", endpoint: "http://b.example:9999", resolve_endpoint: "/resolve", health_score: 0.8 },
  { vesselId: "c", endpoint: "http://127.0.0.1:9998", resolve_endpoint: "/resolve", health_score: 0.7 },
] } } };

let lines: string[] = [];
const attemptLines = () => lines.filter((l) => l.startsWith("[llm-completion-dispatch] endpoint attempt="));
const field = (line: string, k: string) => new RegExp(`\\b${k}=(\\S+)`).exec(line)?.[1];

describe("llm_completion_dispatch: each endpoint attempt is measured", () => {
  beforeEach(() => {
    calls.length = 0; answers = []; lines = []; install();
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  });

  it("[MUST-FAIL] a cascade over 3 endpoints, one slow, logs 3 attempt lines and the slow one is identifiable", async () => {
    answers.push(threeArms);
    answers.push({ data: { resolved: false, error: "provider unavailable" } });
    answers.push({ delayMs: 300, data: { resolved: false, error: "provider unavailable" } });
    answers.push({ data: { resolved: true, content: "a third arm answered" } });
    await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: PROMPT });
    const got = attemptLines();
    expect(got).toHaveLength(3);
    expect(got.map((l) => field(l, "attempt"))).toEqual(["0", "1", "2"]);
    expect(got.map((l) => field(l, "endpoint"))).toEqual([A, B, C]);
    expect(got.map((l) => field(l, "outcome"))).toEqual(["refused", "refused", "ok"]);
    expect(got.map((l) => field(l, "kind"))).toEqual(["direct_host", "direct_host", "local_http"]);
    const ms = got.map((l) => Number(field(l, "duration_ms")));
    expect(ms[1]).toBeGreaterThanOrEqual(250);
    expect(Math.max(...ms)).toBe(ms[1]);
  });

  it("[MUST-FAIL] a failed dispatch's per-endpoint failures carry each attempt's duration, index and kind", async () => {
    answers.push(threeArms);
    answers.push({ throws: true, data: null });
    answers.push({ delayMs: 300, status: 502, data: "bad gateway" });
    answers.push({ data: { resolved: false, error: "provider unavailable" } });
    const r = await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: PROMPT });
    expect(r.shape).toBe("structuredError");
    const failures = (r.body as { failures: Array<{ endpoint: string; attempt?: number; kind?: string; duration_ms?: number }> }).failures;
    expect(failures.map((f) => [f.endpoint, f.attempt, f.kind])).toEqual([[A, 0, "direct_host"], [B, 1, "direct_host"], [C, 2, "local_http"]]);
    expect(failures[1]!.duration_ms!).toBeGreaterThanOrEqual(250);
    expect(attemptLines().map((l) => field(l, "outcome"))).toEqual(["transport_error", "http_502", "refused"]);
  });

  it("[MUST-FAIL] a terminal refusal is measured too, with its own outcome", async () => {
    answers.push(threeArms);
    answers.push({ data: { resolved: false, prompt_ceiling: true, error: "prompt too large: over the ceiling" } });
    await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: PROMPT });
    expect(attemptLines().map((l) => [field(l, "attempt"), field(l, "outcome")])).toEqual([["0", "prompt_ceiling"]]);
  });

  it("CONTROL: the order of the cascade and its final result are unchanged", async () => {
    answers.push(threeArms);
    answers.push({ data: { resolved: false, error: "provider unavailable" } });
    answers.push({ delayMs: 50, data: { resolved: false, error: "provider unavailable" } });
    answers.push({ data: { resolved: true, content: "a third arm answered", model: "m-c" } });
    const r = await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: PROMPT });
    expect(calls).toEqual([expect.stringContaining("/resolve"), A, B, C]);
    expect(r).toEqual({ shape: "llmTextCompletion", body: { text: "a third arm answered", model: "m-c", requested_model: "auto", usage: undefined } });
  });

  it("CONTROL: a first endpoint that answers stops the cascade there", async () => {
    answers.push(threeArms);
    answers.push({ data: { resolved: true, content: "the first arm answered" } });
    const r = await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: PROMPT });
    expect(calls).toEqual([expect.stringContaining("/resolve"), A]);
    expect((r.body as { text: string }).text).toBe("the first arm answered");
  });
});
