import { describe, it, expect } from "bun:test";
import { resolveTemplateSuccessRanking24h } from "../../src/resolvers/template-success-ranking-24h.js";

describe("resolveTemplateSuccessRanking24h", () => {
  it("returns the correct shape", async () => {
    const result = await resolveTemplateSuccessRanking24h({});
    expect(result.shape).toBe("template_success_ranking_24h");
  });

  it("returns a body with required fields", async () => {
    const result = await resolveTemplateSuccessRanking24h({});
    const body = result.body as Record<string, unknown>;
    expect(body).toBeDefined();
    expect(typeof body["window_hours"]).toBe("number");
    expect(body["window_hours"]).toBe(24);
    expect(Array.isArray(body["ranked"])).toBe(true);
    expect(typeof body["total_templates_observed"]).toBe("number");
    expect(typeof body["total_successes_observed"]).toBe("number");
    expect(typeof body["generated_at"]).toBe("string");
  });

  it("ranked array has at most 7 entries", async () => {
    const result = await resolveTemplateSuccessRanking24h({});
    const body = result.body as Record<string, unknown>;
    const ranked = body["ranked"] as unknown[];
    expect(ranked.length).toBeLessThanOrEqual(7);
  });

  it("ranked entries are sorted ascending by successCount", async () => {
    const result = await resolveTemplateSuccessRanking24h({});
    const body = result.body as Record<string, unknown>;
    const ranked = body["ranked"] as Array<{ templateId: string; successCount: number }>;
    for (let i = 1; i < ranked.length; i++) {
      const prev = ranked[i - 1];
      const curr = ranked[i];
      expect((curr?.successCount ?? 0) >= (prev?.successCount ?? 0)).toBe(true);
    }
  });

  it("each ranked entry has templateId and successCount", async () => {
    const result = await resolveTemplateSuccessRanking24h({});
    const body = result.body as Record<string, unknown>;
    const ranked = body["ranked"] as Array<Record<string, unknown>>;
    for (const entry of ranked) {
      expect(typeof entry["templateId"]).toBe("string");
      expect(typeof entry["successCount"]).toBe("number");
    }
  });
});
