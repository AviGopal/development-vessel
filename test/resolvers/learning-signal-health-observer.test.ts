// learning-signal-health-observer: the ratio it reports, and what it refuses to report.
//
// WHY THIS FILE EXISTS. This resolver was an uncovered target in the effect-coverage
// check — 16 of 406 uncovered-target mentions across 400 compose traces — so changes to it
// landed reviewed but never executed.
//
// The invariant worth pinning is the one its own source calls out: when nothing has been
// loaded, the success-credit ratio must be null rather than 1.0. A resolver that reports a
// perfect ratio because it has no data is asserting health it never measured, which is the
// dominant defect shape in this substrate. Every case below stays under minLoadedVolume so
// the observer classifies as not_needed and performs no gap write; these tests have no
// side effects beyond a loopback server they start and stop themselves.
import { describe, expect, test } from "bun:test";
import { resolveLearningSignalHealthObserver } from "../../src/resolvers/learning-signal-health-observer";

type Concept = { times_loaded?: number; times_succeeded?: number; relevance?: number; source?: string };

async function withStub<T>(concepts: Concept[] | null, fn: (url: string) => Promise<T>): Promise<T> {
  const server = Bun.serve({
    port: 0,
    fetch() {
      if (concepts === null) return new Response("boom", { status: 500 });
      return Response.json({ concepts });
    },
  });
  try {
    return await fn(`http://127.0.0.1:${server.port}/concepts/search`);
  } finally {
    server.stop(true);
  }
}

describe("successCreditRatio", () => {
  test("is null, not 1.0, when nothing has been loaded", async () => {
    const body = await withStub(
      [{ times_loaded: 0, times_succeeded: 0 }, { times_loaded: 0, times_succeeded: 0 }],
      (url) => resolveLearningSignalHealthObserver({ conceptSearchUrl: url } as never).then((r) => r.body as Record<string, unknown>),
    );
    // A ratio of 1.0 here would claim every loaded concept earned credit, on zero evidence.
    expect(body["success_credit_ratio"] ?? null).toBeNull();
  });

  test("is the credited share of the loaded population, not of everything", async () => {
    const body = await withStub(
      [
        { times_loaded: 5, times_succeeded: 1 }, // loaded and credited
        { times_loaded: 5, times_succeeded: 0 }, // loaded, never credited
        { times_loaded: 0, times_succeeded: 0 }, // never loaded: outside the denominator
      ],
      (url) => resolveLearningSignalHealthObserver({ conceptSearchUrl: url } as never).then((r) => r.body as Record<string, unknown>),
    );
    // 1 credited of 2 loaded. Counting the never-loaded concept would give 1/3.
    expect(body["success_credit_ratio"]).toBeCloseTo(0.5, 5);
  });
});

describe("failure handling", () => {
  test("a failing search returns an error body rather than throwing", async () => {
    const body = await withStub(null, (url) =>
      resolveLearningSignalHealthObserver({ conceptSearchUrl: url } as never).then((r) => r.body as Record<string, unknown>),
    );
    expect(typeof body["error"]).toBe("string");
    expect(body["generated_at"]).toBeDefined();
    // It must not manufacture a ratio it never obtained.
    expect(body["success_credit_ratio"] ?? null).toBeNull();
  });

  test("an unreachable endpoint is also an error body, not a throw", async () => {
    const r = await resolveLearningSignalHealthObserver({
      conceptSearchUrl: "http://127.0.0.1:1/concepts/search",
    } as never);
    const body = r.body as Record<string, unknown>;
    expect(typeof body["error"]).toBe("string");
  });
});

describe("gap emission", () => {
  test("stays not_needed below the volume threshold, so a small sample cannot trigger a write", async () => {
    const body = await withStub(
      [{ times_loaded: 1, times_succeeded: 0, relevance: 0.1 }],
      (url) => resolveLearningSignalHealthObserver({ conceptSearchUrl: url } as never).then((r) => r.body as Record<string, unknown>),
    );
    // One starved concept is not evidence of a starved corpus.
    expect(body["gap_emission"]).toBe("not_needed");
  });
});
