// ONE HUNG LLM ENDPOINT CANNOT TAKE THE WHOLE FAILOVER DEADLINE, AND A TIMED-OUT ENDPOINT IS DEMOTED.
//
// llmCallWithFailover's deadline is a third of the compose ceiling (300 s at the shipped default) and each endpoint's call
// was clipped to min(250 s, time left). An endpoint that accepts the request and never answers therefore used ~250 s, the
// endpoints after it shared ~50 s, and a draft from a healthy endpoint that needs a minute died on the deadline. The hung
// endpoint kept its place, first in discovery's order, so the next call hung on it again. Expected, with the SHIPPED
// constants (this file sets no ceiling) on bun's fake clock (Date, setTimeout and AbortSignal.timeout), fetch stubbed:
//   - [A hangs, B answers in 1 s]: B's answer, before the deadline, with A cut at no more than half of the deadline; A's
//     timeout is logged by its host label only; and on the NEXT call B is tried first (the must-fail);
//   - [A hangs, B answers in 60 s]: B's answer (the parent's ~50 s left for B ran out on the deadline; must-fail);
//   - CONTROL: every endpoint answering: the first one's answer, no other call;
//   - CONTROL: every endpoint refusing fast: the same calls, rounds and error as before (503: three rounds; 400: one);
//   - CONTROL: a lone endpoint gets the whole remaining time (the 250 s per-call cap, as before).
// Every URL is this file's own (localhost, a port and a run tag no other file uses), so the module's in-process demotion
// memory cannot reach another file's endpoints.
import { afterEach, describe, expect, it, jest, spyOn } from "bun:test";
import { llmCallWithFailover } from "../../src/resolvers/feature-compose.js";

const RUN = Math.random().toString(36).slice(2, 8);
const url = (port: number, tag: string) => `http://localhost:${port}/resolve?hung-${tag}-${RUN}`;
const DEADLINE_MS = 300_000; // a third of the shipped 15 min compose ceiling
const CALL_CAP_MS = 250_000;

type Behaviour = { kind: "never" } | { kind: "ok"; ms: number; text: string } | { kind: "status"; status: number };
type Call = { url: string; at: number; ended?: number; aborted?: boolean };
let realFetch: typeof fetch | null = null;
let logSpy: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  jest.useRealTimers();
  if (realFetch) { globalThis.fetch = realFetch; realFetch = null; }
  logSpy?.mockRestore(); logSpy = null;
});

/** Fake clock + a fetch stub: each URL behaves as `plan` says. Returns the call log and the console lines. */
function install(plan: Record<string, Behaviour>): { calls: Call[]; lines: string[]; t0: number } {
  jest.useFakeTimers();
  const t0 = Date.now();
  const calls: Call[] = [];
  const lines: string[] = [];
  logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    const c: Call = { url: u, at: Date.now() - t0 };
    calls.push(c);
    const b = plan[u] ?? { kind: "status", status: 502 };
    if (b.kind === "status") { c.ended = c.at; return new Response(`fixture ${b.status}`, { status: b.status }); }
    const signal = init?.signal ?? undefined;
    return await new Promise<Response>((resolve, reject) => {
      const t = b.kind === "ok" ? setTimeout(() => { c.ended = Date.now() - t0; resolve(Response.json({ content: b.text, resolved: true })); }, b.ms) : null;
      signal?.addEventListener("abort", () => { if (t) clearTimeout(t); c.ended = Date.now() - t0; c.aborted = true; reject(signal.reason ?? new Error("aborted")); });
    });
  }) as typeof fetch;
  return { calls, lines, t0 };
}

/** Run one failover on the fake clock, advancing it in 100 ms steps until it settles (at most 400 s of fake time). */
async function drive(endpoints: string[], t0: number): Promise<{ result?: string; error?: string; elapsed: number }> {
  let out: { result?: string; error?: string } | null = null;
  const started = Date.now() - t0;
  llmCallWithFailover(endpoints, "prompt", "auto").then((v) => { out = { result: v }; }, (e) => { out = { error: String((e as Error)?.message ?? e) }; });
  for (let i = 0; i < 4000 && out === null; i++) {
    for (let k = 0; k < 40 && out === null; k++) await Promise.resolve();
    if (out === null) jest.advanceTimersByTime(100);
  }
  expect(out).not.toBeNull();
  return { ...out!, elapsed: Date.now() - t0 - started };
}

describe("feature-compose llmCallWithFailover: a hung endpoint, the shipped constants", () => {
  it("[MUST-FAIL] [A hangs, B answers in 1 s]: B's answer before the deadline, A cut at half, and B first on the next call", async () => {
    const A = url(28711, "a1"), B = url(28712, "b1");
    const { calls, lines, t0 } = install({ [A]: { kind: "never" }, [B]: { kind: "ok", ms: 1_000, text: "B" } });
    const r = await drive([A, B], t0);
    expect(r.result).toBe("B");
    expect(r.elapsed).toBeLessThan(DEADLINE_MS);
    const a = calls.find((c) => c.url === A)!;
    expect(a.aborted).toBe(true);
    expect(a.ended! - a.at).toBeLessThanOrEqual(DEADLINE_MS / 2);
    const timedOut = lines.filter((l) => l.includes("[llm-failover]") && l.includes("timed out"));
    expect(timedOut.length).toBe(1);
    expect(timedOut[0]).toContain("localhost:28711");
    expect(timedOut[0]).not.toContain("hung-a1"); // the host label only, never the URL's query
    calls.length = 0;
    const r2 = await drive([A, B], t0);
    expect(r2.result).toBe("B");
    expect(calls.map((c) => c.url)).toEqual([B]);
  }, 60_000);

  it("[MUST-FAIL] [A hangs, B answers in 60 s]: B's answer, inside the deadline", async () => {
    const A = url(28721, "a2"), B = url(28722, "b2");
    const { t0 } = install({ [A]: { kind: "never" }, [B]: { kind: "ok", ms: 60_000, text: "B" } });
    const r = await drive([A, B], t0);
    expect(r.error).toBeUndefined();
    expect(r.result).toBe("B");
    expect(r.elapsed).toBeLessThan(DEADLINE_MS);
  }, 60_000);

  it("[CONTROL] every endpoint answering: the first endpoint's answer, nothing else called", async () => {
    const C = url(28731, "c"), D = url(28732, "d");
    const { calls, t0 } = install({ [C]: { kind: "ok", ms: 5_000, text: "C" }, [D]: { kind: "ok", ms: 10, text: "D" } });
    const r = await drive([C, D], t0);
    expect(r.result).toBe("C");
    expect(calls.map((c) => c.url)).toEqual([C]);
  }, 60_000);

  it("[CONTROL] every endpoint refusing fast: the same calls, rounds and error as before", async () => {
    const E = url(28741, "e"), F = url(28742, "f");
    const s1 = install({ [E]: { kind: "status", status: 503 }, [F]: { kind: "status", status: 503 } });
    const r = await drive([E, F], s1.t0);
    expect(r.error).toStartWith(`llmCall to ${F} failed with status 503`);
    expect(s1.calls.map((c) => c.url)).toEqual([E, F, E, F, E, F]);
    const G = url(28743, "g"), H = url(28744, "h");
    s1.calls.length = 0;
    globalThis.fetch = realFetch!; realFetch = null; logSpy?.mockRestore(); logSpy = null; jest.useRealTimers();
    const s2 = install({ [G]: { kind: "status", status: 400 }, [H]: { kind: "status", status: 400 } });
    const r2 = await drive([G, H], s2.t0);
    expect(r2.error).toStartWith(`llmCall to ${H} failed with status 400`);
    expect(s2.calls.map((c) => c.url)).toEqual([G, H]);
  }, 60_000);

  it("[CONTROL] a lone endpoint gets the whole remaining time (the per-call cap)", async () => {
    const I = url(28751, "i");
    const { calls, t0 } = install({ [I]: { kind: "never" } });
    await drive([I], t0);
    const first = calls[0]!;
    expect(first.aborted).toBe(true);
    expect(first.ended! - first.at).toBe(CALL_CAP_MS);
  }, 60_000);
});
