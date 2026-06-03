import { describe, it, expect, afterEach } from "bun:test";
import { resolveCodeNeedsReport } from "../../src/resolvers/code-needs-report.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function routedFetch(map: Record<string, () => Response>): typeof fetch {
  return (async (input: any) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const prefix of Object.keys(map)) {
      if (url.startsWith(prefix)) return map[prefix]!();
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("code_needs_report", () => {
  it("surfaces missing_resolver for capability shape demanded by N templates not advertised", async () => {
    globalThis.fetch = routedFetch({
      "http://traces/": () => new Response(JSON.stringify({ executions: [] }), { status: 200 }),
      "http://templates/": () =>
        new Response(
          JSON.stringify({
            templates: [
              { id: "t1", inputShapes: ["fancyReport"], outputShapes: [] },
              { id: "t2", inputShapes: ["fancyReport"], outputShapes: [] },
              { id: "t3", inputShapes: ["fancyReport", "trace"], outputShapes: [] },
            ],
          }),
          { status: 200 },
        ),
      "http://discovery/": () =>
        new Response(JSON.stringify({ shapes: ["coverage_tick", "trace"] }), { status: 200 }),
    });
    const r = await resolveCodeNeedsReport({
      type: "code_needs_report",
      tracesUrl: "http://traces/",
      templatesUrl: "http://templates/",
      discoveryShapesUrl: "http://discovery/",
      resolverDemandThreshold: 3,
    });
    const body = r.body as any;
    expect(r.shape).toBe("codeNeedsReport");
    const missingResolvers = body.needs.filter((n: any) => n.category === "missing_resolver");
    expect(missingResolvers.length).toBe(1);
    expect(missingResolvers[0].target_name).toBe("fancyReport");
    expect(missingResolvers[0].action).toBe("CREATE");
  });

  it("flags broken_template when preflight + truncation failures cross threshold", async () => {
    globalThis.fetch = routedFetch({
      "http://traces/": () =>
        new Response(
          JSON.stringify({
            executions: [
              ...Array.from({ length: 3 }, (_, i) => ({
                execution_id: `exec_${i}`,
                status: "failure",
                duration_ms: 5,
                task_count: 0,
                activity_id: "broken_one",
              })),
              ...Array.from({ length: 2 }, (_, i) => ({
                execution_id: `truncate_${i}`,
                status: "failure",
                duration_ms: 5000,
                task_count: 4,
                failure_mode: null,
                activity_id: "truncate_one",
              })),
            ],
          }),
          { status: 200 },
        ),
      "http://templates/": () => new Response(JSON.stringify({ templates: [] }), { status: 200 }),
      "http://discovery/": () => new Response(JSON.stringify({ shapes: [] }), { status: 200 }),
    });
    const r = await resolveCodeNeedsReport({
      type: "code_needs_report",
      tracesUrl: "http://traces/",
      templatesUrl: "http://templates/",
      discoveryShapesUrl: "http://discovery/",
      brokenTemplateThreshold: 2,
    });
    const body = r.body as any;
    const broken = body.needs.filter((n: any) => n.category === "broken_template");
    expect(broken.length).toBe(2);
    expect(broken.map((n: any) => n.target_name)).toContain("broken_one");
    expect(broken.map((n: any) => n.target_name)).toContain("truncate_one");
  });

  it("flags missing_template for capability output shapes nobody consumes", async () => {
    globalThis.fetch = routedFetch({
      "http://traces/": () => new Response(JSON.stringify({ executions: [] }), { status: 200 }),
      "http://templates/": () =>
        new Response(
          JSON.stringify({
            templates: [
              {
                id: "producer_t",
                inputShapes: [],
                outputShapes: ["orphanReport", "another_scan"],
              },
              { id: "consumer_t", inputShapes: ["another_scan"], outputShapes: [] },
            ],
          }),
          { status: 200 },
        ),
      "http://discovery/": () => new Response(JSON.stringify({ shapes: [] }), { status: 200 }),
    });
    const r = await resolveCodeNeedsReport({
      type: "code_needs_report",
      tracesUrl: "http://traces/",
      templatesUrl: "http://templates/",
      discoveryShapesUrl: "http://discovery/",
    });
    const body = r.body as any;
    const missingTemplates = body.needs.filter((n: any) => n.category === "missing_template");
    expect(missingTemplates.length).toBe(1);
    expect(missingTemplates[0].target_name).toBe("consumer-of-orphanReport");
  });

  it("sorts by priority desc and exposes category_counts", async () => {
    globalThis.fetch = routedFetch({
      "http://traces/": () =>
        new Response(
          JSON.stringify({
            executions: Array.from({ length: 10 }, (_, i) => ({
              execution_id: `exec_${i}`,
              status: "failure",
              duration_ms: 3,
              task_count: 0,
              activity_id: "big_failing",
            })),
          }),
          { status: 200 },
        ),
      "http://templates/": () =>
        new Response(
          JSON.stringify({
            templates: [
              { id: "t1", inputShapes: ["smallReport"] },
              { id: "t2", inputShapes: ["smallReport"] },
              { id: "t3", inputShapes: ["smallReport"] },
            ],
          }),
          { status: 200 },
        ),
      "http://discovery/": () => new Response(JSON.stringify({ shapes: [] }), { status: 200 }),
    });
    const r = await resolveCodeNeedsReport({
      type: "code_needs_report",
      tracesUrl: "http://traces/",
      templatesUrl: "http://templates/",
      discoveryShapesUrl: "http://discovery/",
      brokenTemplateThreshold: 3,
      resolverDemandThreshold: 3,
    });
    const body = r.body as any;
    expect(body.category_counts.broken_template).toBe(1);
    expect(body.category_counts.missing_resolver).toBe(1);
    // big_failing scored 10/20=0.5 > smallReport 3/10=0.3 → broken should be first
    expect(body.top_priority.category).toBe("broken_template");
  });

  it("graceful empty results on all-network-fail", async () => {
    globalThis.fetch = (async () => {
      throw new Error("net down");
    }) as unknown as typeof fetch;
    const r = await resolveCodeNeedsReport({
      type: "code_needs_report",
    });
    expect(r.shape).toBe("codeNeedsReport");
    const body = r.body as any;
    expect(body.traces_scanned).toBe(0);
    expect(body.templates_scanned).toBe(0);
    expect(body.total_needs).toBe(0);
  });
});
