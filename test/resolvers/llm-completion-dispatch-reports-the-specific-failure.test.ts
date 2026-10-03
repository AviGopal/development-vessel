import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

/**
 * A LOCAL REFUSAL MUST NOT READ AS "UNABLE TO CONNECT" (check-first).
 *
 * Gap: llm-completion-dispatch-overwrites-the-real-failure-with-the-last-endpoints-error-so-a-
 * local-refusal-reads-as-unable-to-connect.
 *
 * MEASURED, node 1, before its transport came back. resolveLlmCompletionDispatch keeps ONE
 * `lastFailure`, overwritten by every endpoint it tries. The local llm-resolver answered first with
 * the specific, fixable refusal "body must include non-empty 'prompt' string"; then every later
 * endpoint (the dead federated arms) failed to CONNECT and overwrote it, so the structuredError
 * the caller received said "Unable to connect". goal-host's arg-correction reads that reason to
 * decide what to repair — it saw a transport fault, not a missing field, and never repaired the
 * prompt. The masking was load-bearing: the one cause the caller could act on was the one erased.
 *
 * CONTRACT (pinned):
 *  - The returned structuredError's PRIMARY reason (`detail`, `failure_mode`, `status`) is the most
 *    specific NON-TRANSPORT cause any endpoint gave — an endpoint that answered and refused beats
 *    one that could not be reached. Only when every endpoint failed to connect is a connect error
 *    the primary reason.
 *  - The body also carries `failures: [{ endpoint, detail, failure_mode, status? }]`, one entry per
 *    endpoint tried, in order, so nothing is lost even when the primary pick is wrong.
 *  - The "local arms exhausted" log line names the local reason, not the bare phrase.
 *  - A dispatch whose first endpoint succeeds carries no failure list (the success path is
 *    unchanged).
 *
 * Endpoints in the scenario: two local arms and one peer row (which, carrying a circuit multiaddr
 * and a foreign substrate suffix, is ALSO tried later as a target-pinned federated egress URL).
 * Fetch is stubbed per URL; nothing reaches a real network.
 */

const R = "prompt of 250000 tokens exceeds the per-turn ceiling max_input_tokens=200000";
const CONNECT = "Unable to connect. Is the computer able to access the url?";

const ROWS = [
  { vesselId: "llm-resolver-vessel", endpoint: "http://local-a:8220", resolve_endpoint: "/resolve", health_score: 1 },
  { vesselId: "llm-resolver-google", endpoint: "http://local-b:8220", resolve_endpoint: "/resolve", health_score: 0.6 },
  { vesselId: "llm-resolver-haiku@hub-1", endpoint: "http://hub-1:8220", resolve_endpoint: "/resolve", health_score: 0.4, libp2p_multiaddr: ["/ip4/10.0.0.9/tcp/4001/p2p/QmHub"] },
];

type Answer = { refuse?: string; succeed?: string } | "connect";
let answerFor: (url: string) => Answer = () => "connect";
const calls: string[] = [];
const logs: string[] = [];
const ORIGINAL = { fetch: globalThis.fetch, error: console.error, warn: console.warn, log: console.log };

beforeEach(() => {
  calls.length = 0;
  logs.length = 0;
  // @ts-expect-error — test stub
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const u = String(url);
    if ((body as { pointer?: { type?: string } } | undefined)?.pointer?.type === "vesselCapability") {
      const data = { content: { found: true, vessels: ROWS } };
      return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) } as Response;
    }
    calls.push(u);
    const a = answerFor(u);
    if (a === "connect") throw new TypeError(CONNECT);
    const data = a.refuse !== undefined ? { resolved: false, shape: "llmCompletion", error: a.refuse } : { resolved: true, content: a.succeed };
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) } as Response;
  };
  const cap = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.error = cap; console.warn = cap; console.log = cap;
});
const restore = () => { globalThis.fetch = ORIGINAL.fetch; console.error = ORIGINAL.error; console.warn = ORIGINAL.warn; console.log = ORIGINAL.log; };
afterEach(restore);
afterAll(restore);

const { resolveLlmCompletionDispatch } = await import("../../src/resolvers/llm-completion-dispatch.js");
type Body = Record<string, unknown>;
const dispatch = () => resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: "Explain why the sky is blue" });

describe("MUST-FAIL — a local refusal followed by connect failures keeps the refusal as the reason", () => {
  beforeEach(() => { answerFor = (u) => (u.startsWith("http://local-a:8220") ? { refuse: R } : "connect"); });

  it("the structuredError's primary reason is the local refusal R, and every endpoint's failure is listed", async () => {
    const r = await dispatch();
    // Instrument guard: the scenario really tried the local arm first and then the dead ones.
    expect(calls[0]).toBe("http://local-a:8220/resolve");
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.some((u) => u.includes("/egress/resolve?target="))).toBe(true);

    expect(r.shape).toBe("structuredError");
    const b = r.body as Body;
    expect(String(b.detail)).toContain(R);
    expect(String(b.detail)).not.toContain("Unable to connect");
    expect(b.failure_mode).toBe("verifier_negative");
    const failures = b.failures as Array<Body> | undefined;
    expect(Array.isArray(failures), "body.failures must list every endpoint's failure").toBe(true);
    expect(failures!.map((f) => f.endpoint)).toEqual(calls);
    expect(String(failures![0]!.detail)).toContain(R);
    for (const f of failures!.slice(1)) expect(String(f.detail)).toContain("Unable to connect");
  });

  it("the 'local arms exhausted' log line names the local reason", async () => {
    await dispatch();
    const line = logs.find((l) => l.includes("local arms exhausted"));
    expect(line, "the cascade must log that local arms are exhausted").toBeDefined();
    expect(line!).toContain(R);
  });
});

describe("CONTROL — the success path and the all-transport path are unchanged", () => {
  it("every endpoint fails to connect: the connect error is reported (cascading)", async () => {
    answerFor = () => "connect";
    const r = await dispatch();
    expect(r.shape).toBe("structuredError");
    const b = r.body as Body;
    expect(String(b.detail)).toContain("Unable to connect");
    expect(b.failure_mode).toBe("cascading");
  });

  it("the first endpoint succeeds: a completion, no failure list, one arm contacted", async () => {
    answerFor = (u) => (u.startsWith("http://local-a:8220") ? { succeed: "Rayleigh scattering" } : "connect");
    const r = await dispatch();
    expect(r.shape).toBe("llmTextCompletion");
    expect((r.body as Body).text).toBe("Rayleigh scattering");
    expect((r.body as Body).failures).toBeUndefined();
    expect(calls).toEqual(["http://local-a:8220/resolve"]);
  });
});
