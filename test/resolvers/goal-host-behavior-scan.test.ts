// goal-host-behavior-scan: its refusals, and the three response shapes it must accept.
//
// WHY THIS FILE EXISTS. This resolver was an uncovered target in the effect-coverage
// check — 17 of 406 uncovered-target mentions across 400 compose traces — so changes to it
// landed reviewed but never executed.
//
// Two contracts are pinned here. First, it must refuse rather than proceed when it has no
// credential, and must report a fetch failure as a reading rather than throwing: a scanner
// that throws produces no record at all, and a scanner that returns a silent zero asserts
// that nothing was found when in fact nothing was looked at. Second, it accepts the trace
// payload in three different shapes — a bare array, `{traces}`, and `{executions}` — and
// nothing else in the repo enforces that, so a producer renaming its envelope would make
// this scanner silently see zero traces.
//
// The fetch is scripted rather than real, per this vessel's guideline that HTTP-touching
// resolvers use a fake fetch and no test opens a socket. Every case passes persist:false
// so the scan performs no write.
import { describe, expect, test } from "bun:test";
import { resolveGoalHostBehaviorScan } from "../../src/resolvers/goal-host-behavior-scan";

const REAL_FETCH = globalThis.fetch;

/** Script the next fetch. `payload === null` scripts a throw; a number scripts that status. */
async function withFetch<T>(payload: unknown, fn: (calls: string[]) => Promise<T>): Promise<T> {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (payload === null) throw new Error("scripted network failure");
    if (typeof payload === "number") return new Response("nope", { status: payload });
    return Response.json(payload);
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
}

const base = { persist: false, apiKey: "test-key" } as const;

describe("refusals", () => {
  test("without a credential it reports missing_api_key and never calls out", async () => {
    await withFetch({ traces: [] }, async (calls) => {
      const r = await resolveGoalHostBehaviorScan({ persist: false, apiKey: "" } as never);
      const body = r.body as Record<string, unknown>;
      expect(body["error"]).toBe("missing_api_key");
      expect(body["directions"]).toBe(0);
      // The point of refusing early: no request is made at all.
      expect(calls.length).toBe(0);
    });
  });

  test("a non-ok response is reported as a reading, not thrown", async () => {
    await withFetch(503, async () => {
      const r = await resolveGoalHostBehaviorScan({ ...base } as never);
      const body = r.body as Record<string, unknown>;
      expect(String(body["error"])).toContain("503");
      expect(body["directions"]).toBe(0);
      expect(body["generated_at"]).toBeDefined();
    });
  });

  test("a network failure is reported as a reading, not thrown", async () => {
    await withFetch(null, async () => {
      const r = await resolveGoalHostBehaviorScan({ ...base } as never);
      const body = r.body as Record<string, unknown>;
      expect(typeof body["error"]).toBe("string");
      expect(body["directions"]).toBe(0);
    });
  });
});

describe("trace payload shapes", () => {
  // A producer renaming its envelope would otherwise make this scanner see zero traces
  // and report a confident, empty model.
  for (const [label, payload] of [
    ["a bare array", []],
    ["an object keyed traces", { traces: [] }],
    ["an object keyed executions", { executions: [] }],
  ] as const) {
    test(`accepts ${label} without reporting an error`, async () => {
      await withFetch(payload, async () => {
        const r = await resolveGoalHostBehaviorScan({ ...base } as never);
        const body = r.body as Record<string, unknown>;
        expect(body["error"]).toBeUndefined();
      });
    });
  }
});

describe("request construction", () => {
  test("asks the trace store for a bounded window and limit", async () => {
    await withFetch({ traces: [] }, async (calls) => {
      await resolveGoalHostBehaviorScan({ ...base, windowHours: 6, limit: 25 } as never);
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain("since=");
      expect(calls[0]).toContain("limit=25");
    });
  });
});
