import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveSubstrateHealthTick } from "../../src/resolvers/substrate-health-tick.js";

const originalFetch = globalThis.fetch;

// High confidence: templates with α+β well above floor (default 10)
const CONFIDENT_TEMPLATES = Array.from({ length: 10 }, (_, i) => ({
  id: `t:${i}`,
  output_shapes: [`shape${i}`],
  thompson_alpha: 8,
  thompson_beta: 5,   // α+β = 13 > floor 10
  created_at: new Date(Date.now() - 7200_000).toISOString(), // 2 hours ago
}));

// Low confidence: templates with α+β below floor
const WEAK_TEMPLATES = Array.from({ length: 10 }, (_, i) => ({
  id: `t:${i}`,
  output_shapes: [`shape${i}`],
  thompson_alpha: 1,
  thompson_beta: 1,   // α+β = 2 < floor 10
  created_at: new Date(Date.now() - 7200_000).toISOString(),
}));

function makeFetch(templates: typeof CONFIDENT_TEMPLATES) {
  return (async (url: string) => {
    if (String(url).includes("/v2/activities/templates")) {
      return new Response(JSON.stringify({ templates }), { status: 200 });
    }
    if (String(url).includes("/v2/activities/composition")) {
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
    globalThis.fetch = makeFetch(CONFIDENT_TEMPLATES);
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    expect(result.shape).toBe("substrateHealthReport");
  });

  it("confidence_passing=true when ≥50% of pairs clear the floor", async () => {
    globalThis.fetch = makeFetch(CONFIDENT_TEMPLATES);
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const body = result.body as { health_verdict: { confidence_passing: boolean } };
    expect(body.health_verdict.confidence_passing).toBe(true);
  });

  it("confidence_passing=false when <50% of pairs clear the floor", async () => {
    globalThis.fetch = makeFetch(WEAK_TEMPLATES);
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const body = result.body as { health_verdict: { confidence_passing: boolean } };
    expect(body.health_verdict.confidence_passing).toBe(false);
  });

  it("optimality_passing=null when no harness data available", async () => {
    globalThis.fetch = makeFetch(CONFIDENT_TEMPLATES);
    // WORKSPACE_ROOT will point somewhere with no validation/results/ dir
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const body = result.body as { health_verdict: { optimality_passing: null } };
    expect(body.health_verdict.optimality_passing).toBeNull();
  });

  it("stability_passing=true when mutation_rate_per_hour ≤ 1.0", async () => {
    // All templates created 2h ago → 0 new in lookback window → rate 0
    globalThis.fetch = makeFetch(CONFIDENT_TEMPLATES);
    const result = await resolveSubstrateHealthTick({
      type: "substrate_health_tick",
      lookback_window_seconds: 3600, // 1h lookback; templates created 2h ago
    });
    const body = result.body as { health_verdict: { stability_passing: boolean }; graph_stability: { mutation_rate_per_hour: number } };
    expect(body.graph_stability.mutation_rate_per_hour).toBe(0);
    expect(body.health_verdict.stability_passing).toBe(true);
  });

  it("overall_passing=true when confidence + stability pass and optimality is null", async () => {
    globalThis.fetch = makeFetch(CONFIDENT_TEMPLATES);
    const result = await resolveSubstrateHealthTick({ type: "substrate_health_tick" });
    const body = result.body as { health_verdict: { overall_passing: boolean } };
    expect(body.health_verdict.overall_passing).toBe(true);
  });

  it("posterior_confidence contains percentile fields", async () => {
    globalThis.fetch = makeFetch(CONFIDENT_TEMPLATES);
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
});
