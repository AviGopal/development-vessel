import { describe, it, expect, afterEach } from "bun:test";
import { resolveResolverTierCostSummary } from "../../src/resolvers/resolver-tier-cost-summary.js";

// HERMETIC. Every test here invoked the resolver with no fetch stub, hitting the live trace
// store (limit=1000, 15s resolver timeout) against bun's 5s test timeout — so under substrate
// load they failed as timeouts rather than on their assertions. The assertions were also
// existence-only (Array.isArray(tiers), window_hours === 24), which an empty result satisfies,
// so the aggregation this resolver exists to perform was never actually checked.
//
// Pinned below: tier/cost field fallbacks, cost-descending order, the resolutions fallback that
// only fires when traces are empty, and the fetch-failure branch that reports `error` in-body.

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Route by URL: /v2/resolutions is the fallback, everything else is the traces call. */
const routeFetch = (routes: { traces?: unknown; tracesStatus?: number; resolutions?: unknown }): void => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/v2/resolutions")) return json(routes.resolutions ?? { resolutions: [] });
    return json(routes.traces ?? { executions: [] }, routes.tracesStatus ?? 200);
  }) as unknown as typeof fetch;
};

describe("resolveResolverTierCostSummary", () => {
  it("returns the shape with a 24h default window", async () => {
    routeFetch({});
    const result = await resolveResolverTierCostSummary({ type: "resolver_tier_cost_summary" });
    expect(result.shape).toBe("resolver_tier_cost_summary");
    const body = result.body as Record<string, any>;
    expect(body["window_hours"]).toBe(24);
    expect(Array.isArray(body["tiers"])).toBe(true);
    expect(typeof body["generated_at"]).toBe("string");
    expect(new Date(body["generated_at"]).getTime()).not.toBeNaN();
  });

  it("aggregates cost and count per tier, most expensive tier first", async () => {
    routeFetch({
      traces: {
        executions: [
          { resolver_tier: "llm", cost: 0.5 },
          { resolver_tier: "llm", cost: 0.25 },
          { resolver_tier: "deterministic", cost: 0.01 },
          { resolver_tier: "pattern", cost: 0.1 },
        ],
      },
    });
    const body = (await resolveResolverTierCostSummary({ type: "resolver_tier_cost_summary" })).body as Record<string, any>;
    expect(body["tiers"].map((t: any) => t.tier)).toEqual(["llm", "pattern", "deterministic"]);
    expect(body["tiers"][0]).toMatchObject({ tier: "llm", count: 2 });
    expect(body["tiers"][0].total_cost).toBeCloseTo(0.75, 10);
  });

  it("falls back through tier/cost field aliases and buckets the untagged as 'unknown'", async () => {
    routeFetch({
      traces: {
        executions: [
          { tier: "pattern", total_cost: 2 },        // tier alias + total_cost alias
          { resolver_tier: "llm", llm_cost_usd: 3 }, // llm_cost_usd alias
          { somethingElse: true },                    // no tier, no cost → unknown @ 0
        ],
      },
    });
    const body = (await resolveResolverTierCostSummary({ type: "resolver_tier_cost_summary" })).body as Record<string, any>;
    const byTier = Object.fromEntries(body["tiers"].map((t: any) => [t.tier, t]));
    expect(byTier["pattern"].total_cost).toBe(2);
    expect(byTier["llm"].total_cost).toBe(3);
    expect(byTier["unknown"]).toMatchObject({ total_cost: 0, count: 1 });
  });

  it("uses the resolutions endpoint ONLY when traces come back empty", async () => {
    routeFetch({
      traces: { executions: [] },
      resolutions: { resolutions: [{ resolver_tier: "llm", cost: 1.5 }] },
    });
    const body = (await resolveResolverTierCostSummary({ type: "resolver_tier_cost_summary" })).body as Record<string, any>;
    expect(body["tiers"]).toHaveLength(1);
    expect(body["tiers"][0]).toMatchObject({ tier: "llm", total_cost: 1.5, count: 1 });
  });

  it("does NOT consult resolutions when traces produced data", async () => {
    let resolutionsCalled = false;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/v2/resolutions")) { resolutionsCalled = true; return json({ resolutions: [] }); }
      return json({ executions: [{ resolver_tier: "llm", cost: 1 }] });
    }) as unknown as typeof fetch;
    await resolveResolverTierCostSummary({ type: "resolver_tier_cost_summary" });
    expect(resolutionsCalled).toBe(false);
  });

  it("reports the failure in-body when the trace fetch throws", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const result = await resolveResolverTierCostSummary({ type: "resolver_tier_cost_summary" });
    expect(result.shape).toBe("resolver_tier_cost_summary");
    const body = result.body as Record<string, any>;
    expect(body["tiers"]).toEqual([]);
    expect(String(body["error"])).toContain("Failed to fetch traces");
  });
});
