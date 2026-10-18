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
  // replace the traceAggregateReport answer (default: the same traces, grouped per metric)
  aggregate?: (metric: string) => Record<string, unknown>;
  // every request the resolver made: aggregate pointers and trace-list urls
  calls?: { aggregates: Array<Record<string, unknown>>; lists: string[] };
}

// What traceAggregateReport (group_by activity_id) answers over the given traces.
function aggregateOf(traces: Array<{ activity_id: string; status: string }>, metric: string): Record<string, unknown> {
  const counts = new Map<string, number>();
  for (const t of traces) {
    if (metric === "success_count" && t.status !== "success") continue;
    counts.set(t.activity_id, (counts.get(t.activity_id) ?? 0) + 1);
  }
  const rows = [...counts].map(([key, value]) => ({ key, value }));
  return {
    shape: "traceAggregateReport", metric, group_by: "activity_id", window_hours: 720, rows,
    total_groups: rows.length, truncated: false, empty: rows.length === 0, measured: true,
    matched_total: rows.reduce((a, r) => a + r.value, 0), query_ms: 1,
  };
}

function makeFetch(opts: FetchOpts = {}) {
  const { reportTotal = true, failTemplatesAfterOffset, traces = CONFIDENT_TRACES, aggregate, calls } = opts;
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/v2/impulses/resolve")) {
      const pointer = (JSON.parse(String(init?.body ?? "{}")) as { impulse?: { pointer?: Record<string, unknown> } }).impulse?.pointer ?? {};
      calls?.aggregates.push(pointer);
      if (pointer["type"] !== "traceAggregateReport") return new Response("not found", { status: 404 });
      const metric = String(pointer["metric"] ?? "count");
      const report = aggregate ? aggregate(metric) : aggregateOf(traces, metric);
      return new Response(JSON.stringify({ success: true, content: JSON.stringify(report) }), { status: 200 });
    }
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
      calls?.lists.push(u);
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

// ---- 30-day execution counts come from the server-side aggregate ----
//
// The trace list route caps limit at 100, so the old offset loop was one request that sorted the
// whole 30-day window and counted only its newest 100 rows, reported as 30 days. The per-template
// counts now come from traceAggregateReport (group_by activity_id, 720h): one aggregate per metric,
// count and success_count, and no trace-list read at all. An aggregate that did not measure leaves
// confidence + stability UNMEASURED with a named reason, never a zero.
describe("substrate-health-tick: 30-day counts by aggregate", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });
  afterAll(() => { globalThis.fetch = originalFetch; });

  it("must-fail: aggregate requests (group_by activity_id, window_hours 720) replace the trace-list paging", async () => {
    const calls = { aggregates: [] as Array<Record<string, unknown>>, lists: [] as string[] };
    globalThis.fetch = makeFetch({ calls });
    await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const aggs = calls.aggregates.filter((p) => p["type"] === "traceAggregateReport");
    expect(aggs.map((p) => p["metric"]).sort()).toEqual(["count", "success_count"]);
    for (const p of aggs) {
      expect(p["group_by"]).toBe("activity_id");
      expect(p["window_hours"]).toBe(720);
    }
    expect(calls.lists).toEqual([]);
  });

  it("must-fail: the posterior pairs are built from the aggregate's counts, not from list rows", async () => {
    // The list would answer WEAK (1 trace per template); the aggregate says 30 runs, 20 successes each.
    const counted = TEMPLATES.map((t) => t.id);
    globalThis.fetch = makeFetch({
      traces: WEAK_TRACES,
      aggregate: (metric) => ({
        ...aggregateOf([], metric),
        rows: counted.map((key) => ({ key, value: metric === "count" ? 30 : 20 })),
        empty: false,
      }),
    });
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const body = result.body as {
      posterior_confidence: { total_pairs: number; pairs_above_floor: number; median_alpha_plus_beta: number; mean_variance: number };
      health_verdict: { confidence_passing: boolean | null };
      trace_counts: { measured: boolean; reason: string | null; group_by: string; window_hours: number; templates_counted: number };
    };
    expect(body.posterior_confidence.total_pairs).toBe(10);
    expect(body.posterior_confidence.pairs_above_floor).toBe(10);
    expect(body.posterior_confidence.median_alpha_plus_beta).toBe(32); // 30 runs + 2
    // α = 21, β = 11: the success/fail split survives the move to the aggregate.
    expect(body.posterior_confidence.mean_variance).toBeCloseTo((21 * 11) / (32 * 32 * 33), 12);
    expect(body.health_verdict.confidence_passing).toBe(true);
    expect(body.trace_counts).toEqual({ measured: true, reason: null, group_by: "activity_id", window_hours: 720, templates_counted: 10 });
  });

  it("control: the report keeps its sections for a fixed aggregate response", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    expect(result.shape).toBe("substrateHealthReport");
    const body = result.body as Record<string, Record<string, unknown>>;
    for (const k of ["posterior_confidence", "graph_stability", "optimality", "vessel_liveness", "registry_fetch", "health_verdict"]) {
      expect(typeof body[k]).toBe("object");
    }
    for (const k of ["total_pairs", "pairs_above_floor", "floor", "median_alpha_plus_beta", "p25_alpha_plus_beta", "p75_alpha_plus_beta", "mean_variance"]) {
      expect(typeof body["posterior_confidence"]![k]).toBe("number");
    }
    // CONFIDENT fixtures: 10 templates × 10 successes → α+β = 12, no failures.
    expect(body["posterior_confidence"]!["total_pairs"]).toBe(10);
    expect(body["posterior_confidence"]!["median_alpha_plus_beta"]).toBe(12);
    expect(body["health_verdict"]!["confidence_passing"]).toBe(true);
  });

  it("control: measured:false is a named failure — confidence + stability UNMEASURED, never a zero count", async () => {
    globalThis.fetch = makeFetch({
      aggregate: (metric) => ({ ...aggregateOf([], metric), measured: false, matched_total: null, reason: "unserved_group_by" }),
    });
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const body = result.body as {
      trace_counts: { measured: boolean; reason: string | null };
      health_verdict: { confidence_passing: boolean | null; stability_passing: boolean | null; overall_passing: boolean | null; corpus_complete: boolean; unmeasured_dimensions: string[] };
    };
    expect(body.trace_counts.measured).toBe(false);
    expect(body.trace_counts.reason).toBe("count: unserved_group_by");
    expect(body.health_verdict.confidence_passing).toBeNull();
    expect(body.health_verdict.stability_passing).toBeNull();
    expect(body.health_verdict.overall_passing).toBeNull();
    // The registry corpus itself was complete: the unmeasured cause is the counts, not the registry.
    expect(body.health_verdict.corpus_complete).toBe(true);
    expect(body.health_verdict.unmeasured_dimensions).toEqual(expect.arrayContaining(["posterior_confidence", "graph_stability"]));
  });

  it("control: a truncated aggregate is unmeasured (it drops the low-count groups)", async () => {
    globalThis.fetch = makeFetch({ aggregate: (metric) => ({ ...aggregateOf(CONFIDENT_TRACES, metric), truncated: true }) });
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const body = result.body as { trace_counts: { measured: boolean; reason: string | null }; health_verdict: { confidence_passing: boolean | null } };
    expect(body.trace_counts).toMatchObject({ measured: false, reason: "count: aggregate_truncated" });
    expect(body.health_verdict.confidence_passing).toBeNull();
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
