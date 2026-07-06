import { describe, it, expect } from "bun:test";
import { resolveResolverTierCostSummary } from "../../src/resolvers/resolver-tier-cost-summary.js";

describe("resolveResolverTierCostSummary", () => {
  it("returns shape resolver_tier_cost_summary", async () => {
    const result = await resolveResolverTierCostSummary({ type: "resolver_tier_cost_summary" });
    expect(result.shape).toBe("resolver_tier_cost_summary");
  });

  it("body contains tiers array", async () => {
    const result = await resolveResolverTierCostSummary({ type: "resolver_tier_cost_summary" });
    const body = result.body as Record<string, unknown>;
    expect(Array.isArray(body["tiers"])).toBe(true);
  });

  it("body contains window_hours = 24", async () => {
    const result = await resolveResolverTierCostSummary({ type: "resolver_tier_cost_summary" });
    const body = result.body as Record<string, unknown>;
    expect(body["window_hours"]).toBe(24);
  });

  it("body contains generated_at as ISO string", async () => {
    const result = await resolveResolverTierCostSummary({ type: "resolver_tier_cost_summary" });
    const body = result.body as Record<string, unknown>;
    const generatedAt = body["generated_at"];
    expect(typeof generatedAt).toBe("string");
    expect(() => new Date(generatedAt as string).toISOString()).not.toThrow();
  });

  it("tiers are sorted by total_cost descending when data is present", async () => {
    const result = await resolveResolverTierCostSummary({ type: "resolver_tier_cost_summary" });
    const body = result.body as Record<string, unknown>;
    const tiers = body["tiers"] as Array<{ tier: string; total_cost: number; count: number }>;
    for (let i = 1; i < tiers.length; i++) {
      const prev = tiers[i - 1];
      const curr = tiers[i];
      expect((prev?.total_cost ?? 0) >= (curr?.total_cost ?? 0)).toBe(true);
    }
  });

  it("each tier entry has tier, total_cost, count fields", async () => {
    const result = await resolveResolverTierCostSummary({ type: "resolver_tier_cost_summary" });
    const body = result.body as Record<string, unknown>;
    const tiers = body["tiers"] as Array<Record<string, unknown>>;
    for (const entry of tiers) {
      expect(typeof entry["tier"]).toBe("string");
      expect(typeof entry["total_cost"]).toBe("number");
      expect(typeof entry["count"]).toBe("number");
    }
  });
});
