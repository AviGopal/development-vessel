import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveSubstrateHealthTick } from "../../src/resolvers/substrate-health-tick.js";

const originalFetch = globalThis.fetch;

// Confidence is computed from EXECUTION TRACES (per active template), not from
// template thompson_alpha/beta fields (those reset to 1 on every re-seed). The
// templates list only declares which ids are active; the traces supply the α/β
// evidence. So the CONFIDENT vs WEAK distinction lives in the trace volume.
const TEMPLATES = Array.from({ length: 10 }, (_, i) => ({
  id: `t:${i}`,
  output_shapes: [`shape${i}`],
  created_at: new Date(Date.now() - 7200_000).toISOString(), // 2h ago → outside stability window
}));

// CONFIDENT: ≥10 successful traces per template → α+β = 11 ≥ floor(10).
const CONFIDENT_TRACES = TEMPLATES.flatMap((t) =>
  Array.from({ length: 10 }, () => ({ activity_id: t.id, status: "success" })),
);

// WEAK: a single trace per template → α+β = 2 < floor(10).
const WEAK_TRACES = TEMPLATES.flatMap((t) => [{ activity_id: t.id, status: "success" }]);

interface FetchOpts {
  // omit `total` to simulate an endpoint that does not report it → incomplete corpus
  reportTotal?: boolean;
  // force a page fetch to fail mid-pagination → interrupted/incomplete corpus
  failTemplatesAfterOffset?: number;
  traces?: Array<{ activity_id: string; status: string }>;
}

function makeFetch(opts: FetchOpts = {}) {
  const { reportTotal = true, failTemplatesAfterOffset, traces = CONFIDENT_TRACES } = opts;
  return (async (url: string) => {
    const u = String(url);
    if (u.includes("/v2/activities/templates")) {
      const offset = Number(new URL(u, "http://x").searchParams.get("offset") ?? "0");
      if (failTemplatesAfterOffset !== undefined && offset > failTemplatesAfterOffset) {
        // 404 (not 5xx) so fetchWithRetry returns it immediately without burning
        // the 6-attempt backoff budget — we only need !r.ok to mark the corpus
        // interrupted, not to exercise the retry path itself.
        return new Response("gone", { status: 404 });
      }
      // Single page holds the whole corpus; `total` lets the loop terminate AND
      // lets the resolver decide the corpus is complete.
      const body: Record<string, unknown> = { templates: offset === 0 ? TEMPLATES : [] };
      if (reportTotal) body["total"] = TEMPLATES.length;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (u.includes("/v2/activities/execution-traces")) {
      const offset = Number(new URL(u, "http://x").searchParams.get("offset") ?? "0");
      return new Response(JSON.stringify({ executions: offset === 0 ? traces : [] }), { status: 200 });
    }
    if (u.includes("/v2/activities/composition")) {
      return new Response(JSON.stringify({ edges: [] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("substrate-health-tick resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns substrateHealthReport shape", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    expect(result.shape).toBe("substrateHealthReport");
  });

  it("confidence_passing=true when ≥50% of pairs clear the floor", async () => {
    globalThis.fetch = makeFetch({ traces: CONFIDENT_TRACES });
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const body = result.body as { health_verdict: { confidence_passing: boolean } };
    expect(body.health_verdict.confidence_passing).toBe(true);
  });

  it("confidence_passing=false when <50% of pairs clear the floor", async () => {
    globalThis.fetch = makeFetch({ traces: WEAK_TRACES });
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const body = result.body as { health_verdict: { confidence_passing: boolean } };
    expect(body.health_verdict.confidence_passing).toBe(false);
  });

  it("optimality_passing=null when no harness data available", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const body = result.body as { health_verdict: { optimality_passing: null } };
    expect(body.health_verdict.optimality_passing).toBeNull();
  });

  it("stability_passing=true when mutation_rate_per_hour ≤ 1.0", async () => {
    // All templates created 2h ago → 0 new in lookback window → rate 0
    globalThis.fetch = makeFetch();
    const result = await resolveSubstrateHealthTick({
      type: "substrate_health_tick",
      lookback_window_seconds: 3600,
    });
    const body = result.body as { health_verdict: { stability_passing: boolean }; graph_stability: { mutation_rate_per_hour: number } };
    expect(body.graph_stability.mutation_rate_per_hour).toBe(0);
    expect(body.health_verdict.stability_passing).toBe(true);
  });

  it("overall_passing reduces to vessels_passing when confidence + stability pass, corpus is complete, and optimality is null", async () => {
    // confidence_passing=true, stability_passing=true, corpus_complete=true,
    // optimality_passing=null→treated as pass. The only remaining free variable
    // is vessel liveness (systemctl, not controllable from a unit test), so the
    // AND reduces to vessels_passing. Asserting the relationship is deterministic
    // regardless of whether the test host can see the substrate's services.
    globalThis.fetch = makeFetch();
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const body = result.body as {
      health_verdict: { overall_passing: boolean | null; confidence_passing: boolean | null; stability_passing: boolean | null; vessels_passing: boolean; corpus_complete: boolean };
    };
    expect(body.health_verdict.confidence_passing).toBe(true);
    expect(body.health_verdict.stability_passing).toBe(true);
    expect(body.health_verdict.corpus_complete).toBe(true);
    // measurable (no null dimensions) → overall is a real boolean equal to vessels_passing
    expect(body.health_verdict.overall_passing).toBe(body.health_verdict.vessels_passing);
  });

  it("posterior_confidence contains percentile fields", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const body = result.body as {
      posterior_confidence: {
        median_alpha_plus_beta: number;
        p25_alpha_plus_beta: number;
        p75_alpha_plus_beta: number;
      }
    };
    expect(body.posterior_confidence.median_alpha_plus_beta).toBeGreaterThan(0);
    expect(body.posterior_confidence.p25_alpha_plus_beta).toBeLessThanOrEqual(
      body.posterior_confidence.median_alpha_plus_beta
    );
  });

  // — Honest-measurement contract (2026-06-17) —
  // A truncated registry read must NOT produce a confident pass/fail. When the
  // endpoint does not report a total (or a page fetch fails), the corpus is
  // incomplete, confidence + stability are UNMEASURED, and overall_passing is
  // null — "couldn't measure this tick", not a regression.

  it("corpus_complete=true when the full corpus is fetched", async () => {
    globalThis.fetch = makeFetch({ reportTotal: true });
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const body = result.body as { health_verdict: { corpus_complete: boolean }; registry_fetch: { corpus_complete: boolean; templates_total: number | null } };
    expect(body.health_verdict.corpus_complete).toBe(true);
    expect(body.registry_fetch.templates_total).toBe(TEMPLATES.length);
  });

  it("overall_passing=null (unmeasured) when the registry total is unknown", async () => {
    globalThis.fetch = makeFetch({ reportTotal: false });
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const body = result.body as {
      health_verdict: { overall_passing: boolean | null; confidence_passing: boolean | null; stability_passing: boolean | null; corpus_complete: boolean; unmeasured_dimensions: string[] };
    };
    expect(body.health_verdict.corpus_complete).toBe(false);
    expect(body.health_verdict.overall_passing).toBeNull();
    expect(body.health_verdict.confidence_passing).toBeNull();
    expect(body.health_verdict.stability_passing).toBeNull();
    expect(body.health_verdict.unmeasured_dimensions).toContain("posterior_confidence");
  });

  it("overall_passing=null (unmeasured) when a page fetch fails mid-pagination", async () => {
    // total=10 but the page at offset>0 500s. With only the first page in hand
    // the loop would still satisfy length>=total here, so force a multi-page
    // corpus by failing the very first page.
    globalThis.fetch = makeFetch({ failTemplatesAfterOffset: -1 });
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const body = result.body as { health_verdict: { overall_passing: boolean | null; corpus_complete: boolean } };
    expect(body.health_verdict.corpus_complete).toBe(false);
    expect(body.health_verdict.overall_passing).toBeNull();
  });
});

// ---- Minimum-sample floor on the confidence term (2026-08-29) ----
//
// THE GATE PASSED WHEN THE SUBSTRATE WENT IDLE. Measured on the same unchanged system 4h apart,
// with no learning intervention between:
//   01:11Z  total_pairs 17, pairs_above_floor 2  -> 0.12  FAIL
//   05:00Z  total_pairs  4, pairs_above_floor 2  -> 0.50  PASS
// The numerator never moved; the denominator collapsed. Because CLAUDE.md defines the S1->S2 lift
// as three consecutive coverage_progress=true AND overall_passing=true, an IDLE substrate
// manufactured lift — the system certifying itself ready to advance by doing less.
//
// These pin the predicate directly. The resolver itself does network I/O, so the rule is mirrored
// here in the same style as the hashWork/bucketSignature tests elsewhere in this repo: a change to
// the predicate in substrate-health-tick.ts MUST change this file too.
import { describe, it, expect } from "bun:test";

function confidencePassing(
  total_pairs: number,
  pairs_above_floor: number,
  corpus_complete = true,
  confidenceMinPairs = 8,
  confidenceRatioThreshold = 0.25,
): boolean | null {
  return !corpus_complete
    ? null
    : (total_pairs < confidenceMinPairs ? null : pairs_above_floor / total_pairs >= confidenceRatioThreshold);
}

describe("confidence term — minimum sample floor", () => {
  it("THE REGRESSION: 2 of 4 pairs no longer passes", () => {
    // The exact reading that flipped the gate to true on an idle hour.
    expect(confidencePassing(4, 2)).toBeNull();
  });

  it("the same numerator cannot pass at ANY denominator below the floor", () => {
    // The load-bearing property: it is not that 4 is unlucky, it is that a thin sample is
    // unmeasured. 2/2 = 1.0 and 2/3 = 0.67 both clear the 0.25 ratio and must still be null.
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(confidencePassing(n, 2)).toBeNull();
  });

  it("UNMEASURED is null, never false", () => {
    // false asserts a MEASURED regression — as dishonest in the pessimistic direction as the old
    // behaviour was in the optimistic one. The file uses null for "couldn't measure this tick",
    // and overall_passing keys on `confidence_passing !== null`, so null resets the lift streak
    // honestly rather than signalling a regression that was never observed.
    expect(confidencePassing(0, 0)).toBeNull();
    expect(confidencePassing(0, 0)).not.toBe(false);
  });

  it("still discriminates once the sample is sufficient", () => {
    // The floor must not swallow real verdicts: at or above it, the ratio decides as before.
    expect(confidencePassing(8, 2)).toBe(true);    // 0.25 — exactly the threshold
    expect(confidencePassing(8, 1)).toBe(false);   // 0.125 — a genuine, measured fail
    expect(confidencePassing(17, 2)).toBe(false);  // the 01:11Z reading, still FAIL
    expect(confidencePassing(20, 15)).toBe(true);
  });

  it("an unreadable corpus is still null regardless of sample size", () => {
    expect(confidencePassing(50, 40, false)).toBeNull();
  });
});
