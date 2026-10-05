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

type Answer = { refuse?: string; succeed?: string; raw?: unknown } | "connect";
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
    const data = a.raw !== undefined ? a.raw : a.refuse !== undefined ? { resolved: false, shape: "llmCompletion", error: a.refuse } : { resolved: true, content: a.succeed };
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

// THE CLASS, NOT ONE ORDERING. The MUST-FAIL cases above put the refusal FIRST, so "keep the FIRST
// failure" passes them and both controls, and "keep the last" is the bug. Below, the endpoint
// sequence is learned from an all-connect dispatch (local arms, the peer row, then the lazy
// target-pinned federated arms), and a refusal is placed at EVERY position, then at every ordered
// pair, then in every refusal envelope the dispatcher recognises. Refusal texts are random per run.
describe("CLASS — a refusal is the primary reason wherever it sits in the cascade", () => {
  const learnSequence = async (): Promise<string[]> => {
    answerFor = () => "connect";
    calls.length = 0;
    await dispatch();
    const seq = [...calls];
    calls.length = 0;
    logs.length = 0;
    return seq;
  };
  const tag = () => Math.random().toString(36).slice(2, 10);

  it("instrument: the all-connect cascade tries every local arm and at least one federated egress arm", async () => {
    const seq = await learnSequence();
    expect(seq[0]).toBe("http://local-a:8220/resolve");
    expect(seq.length).toBeGreaterThanOrEqual(4);
    expect(seq.some((u) => u.includes("/egress/resolve?target="))).toBe(true);
    expect(new Set(seq).size).toBe(seq.length);
  });

  it("class: one refusal at ANY position (each local arm, the peer row, each federated arm), connect failures everywhere else, is the primary reason and every endpoint is listed in order", async () => {
    const seq = await learnSequence();
    const wrong: string[] = [];
    for (let i = 0; i < seq.length; i++) {
      const Ri = `refusal@${i}:${tag()} body must include non-empty 'prompt' string`;
      answerFor = (u) => (u === seq[i] ? { refuse: Ri } : "connect");
      calls.length = 0;
      const r = await dispatch();
      if (JSON.stringify(calls) !== JSON.stringify(seq)) { wrong.push(`@${i}: cascade order changed: ${JSON.stringify(calls)}`); continue; }
      const b = r.body as Body;
      if (r.shape !== "structuredError") { wrong.push(`@${i}: shape ${r.shape}`); continue; }
      if (!String(b.detail).includes(Ri)) wrong.push(`@${i} (${seq[i]}): primary detail is ${JSON.stringify(String(b.detail).slice(0, 80))}`);
      if (b.failure_mode !== "verifier_negative") wrong.push(`@${i}: failure_mode ${String(b.failure_mode)}`);
      const f = b.failures as Array<Body> | undefined;
      if (!Array.isArray(f) || JSON.stringify(f.map((x) => x.endpoint)) !== JSON.stringify(seq)) wrong.push(`@${i}: failures do not list every endpoint in order`);
      else if (!String(f[i]!.detail).includes(Ri)) wrong.push(`@${i}: failures[${i}] does not carry the refusal`);
    }
    expect(wrong).toEqual([]);
  });

  it("class: two refusals at any ordered pair of positions — the primary is one of the two refusals, never a connect error, and both are listed", async () => {
    const seq = await learnSequence();
    const wrong: string[] = [];
    for (let i = 0; i < seq.length; i++) for (let j = i + 1; j < seq.length; j++) {
      const Ri = `first-refusal@${i}:${tag()}`;
      const Rj = `second-refusal@${j}:${tag()}`;
      answerFor = (u) => (u === seq[i] ? { refuse: Ri } : u === seq[j] ? { refuse: Rj } : "connect");
      calls.length = 0;
      const r = await dispatch();
      const b = r.body as Body;
      const d = String(b.detail);
      if (r.shape !== "structuredError") { wrong.push(`@${i},${j}: shape ${r.shape}`); continue; }
      if (!(d.includes(Ri) || d.includes(Rj)) || d.includes("Unable to connect")) wrong.push(`@${i},${j}: primary detail is ${JSON.stringify(d.slice(0, 80))}`);
      if (b.failure_mode !== "verifier_negative") wrong.push(`@${i},${j}: failure_mode ${String(b.failure_mode)}`);
      const listed = JSON.stringify(b.failures ?? null);
      if (!listed.includes(Ri) || !listed.includes(Rj)) wrong.push(`@${i},${j}: failures do not carry both refusals`);
    }
    expect(wrong).toEqual([]);
  });

  it("class: every refusal envelope the dispatcher recognises (top-level error, success:false, federated content.error, content.body.error) at the first arm, followed by connect failures, is the primary reason", async () => {
    const seq = await learnSequence();
    const R0 = () => `envelope-refusal:${tag()}`;
    const envelopes: Array<{ form: string; make: (r: string) => unknown }> = [
      { form: "resolved:false + error", make: (r) => ({ resolved: false, shape: "llmCompletion", error: r }) },
      { form: "success:false + error", make: (r) => ({ success: false, error: r }) },
      { form: "content.error", make: (r) => ({ content: { error: r } }) },
      { form: "content.body.error", make: (r) => ({ content: { body: { resolved: false, error: r } } }) },
    ];
    const wrong: string[] = [];
    for (const e of envelopes) {
      const r0 = R0();
      answerFor = (u) => (u === seq[0] ? { raw: e.make(r0) } : "connect");
      calls.length = 0;
      const r = await dispatch();
      const b = r.body as Body;
      if (r.shape !== "structuredError" || !String(b.detail).includes(r0) || b.failure_mode !== "verifier_negative") {
        wrong.push(`${e.form}: ${r.shape} ${String(b.failure_mode)} ${JSON.stringify(String(b.detail).slice(0, 80))}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("class: the 'local arms exhausted' log line names the refusal from whichever LOCAL arm gave it", async () => {
    const seq = await learnSequence();
    const local = seq.filter((u) => !u.includes("/egress/"));
    expect(local.length).toBeGreaterThanOrEqual(2);
    const wrong: string[] = [];
    for (const [i, u0] of local.entries()) {
      const Ri = `local-refusal@${i}:${tag()}`;
      answerFor = (u) => (u === u0 ? { refuse: Ri } : "connect");
      calls.length = 0;
      logs.length = 0;
      await dispatch();
      const line = logs.find((l) => l.includes("local arms exhausted"));
      if (!line) wrong.push(`@${u0}: no 'local arms exhausted' line`);
      else if (!line.includes(Ri)) wrong.push(`@${u0}: log line lacks the refusal: ${line.slice(0, 120)}`);
    }
    expect(wrong).toEqual([]);
  });

  it("control: a refusal followed by a SUCCESS still fails over — the completion is returned from the next arm", async () => {
    const seq = await learnSequence();
    answerFor = (u) => (u === seq[0] ? { refuse: `refusal:${tag()}` } : u === seq[1] ? { succeed: "Rayleigh scattering" } : "connect");
    calls.length = 0;
    const r = await dispatch();
    expect(r.shape).toBe("llmTextCompletion");
    expect((r.body as Body).text).toBe("Rayleigh scattering");
    expect(calls).toEqual([seq[0]!, seq[1]!]);
  });
});
