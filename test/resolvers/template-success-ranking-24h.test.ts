import { describe, it, expect, afterEach } from "bun:test";
import { resolveTemplateSuccessRanking24h } from "../../src/resolvers/template-success-ranking-24h.js";

// HERMETIC. Every `it` here used to invoke the resolver with no fetch stub, and the resolver
// makes up to THREE live calls (execution-traces?limit=500, the status=success fallback, and
// templates?limit=200) with its own 10-15s timeouts. bun's test timeout is 5s, so under real
// substrate load all five tests failed as timeouts before reaching an assertion — this file was
// the single largest block of failures in the suite and none of it was about the code. Worse,
// the assertions were shape-only (typeof/Array.isArray), so against live data they could not
// distinguish a correct ranking from an empty one.
//
// NAMING, since it reads like a bug and is not: the resolver sorts ASCENDING and takes
// `bottom7` — this is a WEAKEST-templates report despite the shape name "success_ranking".
// The ascending assertion below is therefore correct and deliberate.

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** Route by URL so each of the resolver's three calls is answered independently. */
const routeFetch = (routes: { traces?: unknown; templates?: unknown }): void => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/templates")) return json(routes.templates ?? { templates: [] });
    return json(routes.traces ?? { executions: [] });
  }) as unknown as typeof fetch;
};

const recent = (): string => new Date(Date.now() - 60 * 60 * 1000).toISOString();
const stale = (): string => new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

describe("resolveTemplateSuccessRanking24h", () => {
  it("returns the correct shape and required body fields", async () => {
    routeFetch({});
    const result = await resolveTemplateSuccessRanking24h({});
    expect(result.shape).toBe("template_success_ranking_24h");
    const body = result.body as Record<string, unknown>;
    expect(body["window_hours"]).toBe(24);
    expect(Array.isArray(body["ranked"])).toBe(true);
    expect(typeof body["total_templates_observed"]).toBe("number");
    expect(typeof body["total_successes_observed"]).toBe("number");
    expect(typeof body["generated_at"]).toBe("string");
  });

  it("counts only successful traces inside the 24h window", async () => {
    routeFetch({
      traces: {
        executions: [
          { activity_template_id: "alpha", status: "success", created_at: recent() },
          { activity_template_id: "alpha", status: "completed", created_at: recent() },
          { activity_template_id: "beta", status: "success", created_at: recent() },
          // excluded: outside the window
          { activity_template_id: "beta", status: "success", created_at: stale() },
          // excluded: not a success
          { activity_template_id: "beta", status: "failed", created_at: recent() },
        ],
      },
    });
    const body = (await resolveTemplateSuccessRanking24h({})).body as Record<string, unknown>;
    const ranked = body["ranked"] as Array<{ templateId: string; successCount: number }>;
    const counts = Object.fromEntries(ranked.map((r) => [r.templateId, r.successCount]));
    expect(counts).toEqual({ beta: 1, alpha: 2 });
    // three traces survived the window+status filter
    expect(body["total_successes_observed"]).toBe(3);
  });

  it("includes zero-success templates from the templates endpoint", async () => {
    routeFetch({
      traces: { executions: [{ activity_template_id: "used", status: "success", created_at: recent() }] },
      templates: { templates: [{ id: "used" }, { id: "never-run" }] },
    });
    const body = (await resolveTemplateSuccessRanking24h({})).body as Record<string, unknown>;
    const ranked = body["ranked"] as Array<{ templateId: string; successCount: number }>;
    // the whole point of the third call: a template nothing exercised must be visible, at 0
    expect(ranked.find((r) => r.templateId === "never-run")?.successCount).toBe(0);
    expect(body["total_templates_observed"]).toBe(2);
  });

  it("ranks weakest-first (ascending) and caps at 7 entries", async () => {
    const executions = Array.from({ length: 10 }, (_, i) =>
      Array.from({ length: i + 1 }, () => ({
        activity_template_id: `t${i}`,
        status: "success",
        created_at: recent(),
      })),
    ).flat();
    routeFetch({ traces: { executions } });
    const body = (await resolveTemplateSuccessRanking24h({})).body as Record<string, unknown>;
    const ranked = body["ranked"] as Array<{ templateId: string; successCount: number }>;
    expect(ranked).toHaveLength(7);
    expect(ranked[0]?.templateId).toBe("t0"); // weakest first
    for (let i = 1; i < ranked.length; i++) {
      expect((ranked[i]?.successCount ?? 0) >= (ranked[i - 1]?.successCount ?? 0)).toBe(true);
    }
  });

  it("degrades to an empty ranking when the trace store is unreachable", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const result = await resolveTemplateSuccessRanking24h({});
    expect(result.shape).toBe("template_success_ranking_24h");
    const body = result.body as Record<string, unknown>;
    expect(body["ranked"]).toEqual([]);
    expect(body["total_successes_observed"]).toBe(0);
  });
});
