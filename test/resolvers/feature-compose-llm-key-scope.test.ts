// A DIRECT LLM ARM OFF THIS MACHINE GETS NO NODE KEY (self-auth.ts, "same-host peers only"; user ruling
// "Narrow: direct off-host only (Recommended)", 2026-10-21T10:22:11Z).
//
// feature-compose's llmCall used to put `Authorization: ApiKey <node key>` on every endpoint of its failover list,
// including a plain HTTP row on another host, which has no transport in front of it to decide who may hold the key.
// Expected:
//   - a direct endpoint off this machine is called WITHOUT the key (it answers or refuses on its own), with one
//     names-only line (the must-fail);
//   - an overlay hop through this node's own federation egress keeps the key, as before: the transport's same-authority
//     peer list decides whether it goes further (control);
//   - a same-host endpoint keeps the key (control).
// The verdict, and so its line, is worked out once per endpoint per process: each case below touches its endpoint first.
// No real key: a dummy is set before the module loads (config.ts freezes the key at import, self-auth.ts reads it at use).
// No real address either: hosts are localhost or an .invalid name, which never resolves.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";

const DUMMY = `dummy-node-key-${Math.random().toString(36).slice(2, 10)}`;
const savedKey = process.env["METABOB_API_KEY"];
const savedEgress = process.env["FED_TRANSPORT_EGRESS"];
process.env["METABOB_API_KEY"] = DUMMY;
process.env["FED_TRANSPORT_EGRESS"] = "http://localhost:8401";

const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;

const LOCAL = "http://localhost:18110/resolve";
const FAR_TARGET = "/dns4/far-hub.invalid/tcp/4001/p2p/12D3KooWDummyRelay/p2p-circuit/p2p/12D3KooWDummyDest";
const EGRESS = `http://localhost:8401/egress/resolve?target=${encodeURIComponent(FAR_TARGET)}&vessel=llm-resolver-dummy&expect_substrate=far-substrate`;
const OFFHOST = "http://far-arm.invalid:18100/resolve";

type Call = { url: string; auth: string | null };
let calls: Call[] = [];
let warned: string[] = [];
const ORIGINAL_FETCH = globalThis.fetch;
const origWarn = console.warn;
const origLog = console.log;

/** A fetch stub: each URL in `answers` returns its status (200 answers "OK"); any other URL answers 503. */
function stub(answers: Record<string, number>): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    const h = new Headers(init?.headers);
    calls.push({ url, auth: h.get("authorization") });
    const status = answers[url] ?? 503;
    return status === 200 ? Response.json({ content: "OK", resolved: true }) : new Response("unavailable (test)", { status });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  warned = [];
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
  console.log = () => {};
});
afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.warn = origWarn;
  console.log = origLog;
  if (savedKey === undefined) delete process.env["METABOB_API_KEY"]; else process.env["METABOB_API_KEY"] = savedKey;
  if (savedEgress === undefined) delete process.env["FED_TRANSPORT_EGRESS"]; else process.env["FED_TRANSPORT_EGRESS"] = savedEgress;
});
const restore = (): void => { globalThis.fetch = ORIGINAL_FETCH; console.warn = origWarn; console.log = origLog; };

describe("feature-compose llmCallWithFailover: the node key's scope", () => {
  it("CONTROL: over [local arm, overlay egress hop] both carry the node key; the transport decides past the hop", async () => {
    expect(typeof fc.llmCallWithFailover).toBe("function");
    stub({ [EGRESS]: 200 }); // the local arm is down (503), so the call spills to the egress hop
    try {
      expect(await fc.llmCallWithFailover([LOCAL, EGRESS], "prompt", "auto")).toBe("OK");
    } finally { restore(); }
    expect(calls).toEqual([{ url: LOCAL, auth: `ApiKey ${DUMMY}` }, { url: EGRESS, auth: `ApiKey ${DUMMY}` }]);
    expect(warned).toEqual([]);
  });

  it("CONTROL: a same-host arm still receives the node key, and nothing is logged", async () => {
    expect(typeof fc.llmCallWithFailover).toBe("function");
    stub({ [LOCAL]: 200 });
    try {
      expect(await fc.llmCallWithFailover([LOCAL], "prompt", "auto")).toBe("OK");
    } finally { restore(); }
    expect(calls).toEqual([{ url: LOCAL, auth: `ApiKey ${DUMMY}` }]);
    expect(warned).toEqual([]);
  });

  it("MUST-FAIL: an endpoint off this machine is called without the key; the next endpoint still gets it", async () => {
    expect(typeof fc.llmCallWithFailover).toBe("function");
    stub({ [LOCAL]: 200 }); // the off-machine arm answers 503, so the call moves on to the local arm
    try {
      expect(await fc.llmCallWithFailover([OFFHOST, LOCAL], "prompt", "auto")).toBe("OK");
    } finally { restore(); }
    expect(calls).toEqual([{ url: OFFHOST, auth: null }, { url: LOCAL, auth: `ApiKey ${DUMMY}` }]);
    expect(warned).toEqual(["[cross-node-key] refused non-local far-arm.invalid"]);
    expect(warned.some((w) => w.includes(DUMMY))).toBe(false);
  });
});
