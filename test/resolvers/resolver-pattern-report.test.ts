import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveResolverPatternReport } from "../../src/resolvers/resolver-pattern-report.js";

const originalFetch = globalThis.fetch;

const TEMPLATES = [
  {
    id: "tpl-coverage",
    tasks: [
      { id: "t1", resolver: "coverage_tick", outputShapes: ["coverageReport"] },
    ],
    output_shapes: ["coverageReport"],
  },
  {
    id: "tpl-probe",
    tasks: [
      { id: "t1", resolver: "reachable_unlearned_report", outputShapes: ["reachableButUnlearnedReport"] },
    ],
    output_shapes: ["reachableButUnlearnedReport"],
  },
  {
    id: "tpl-multi",
    tasks: [
      { id: "t1", resolver: "fs_read", outputShapes: ["fileContent"] },
      { id: "t2", resolver: "llm_completion_dispatch", outputShapes: ["analysisReport"] },
    ],
    output_shapes: ["fileContent", "analysisReport"],
  },
];

function makeFetch(traces: Array<{ activity_id: string; success: boolean; status?: string }>) {
  const recentTs = new Date(Date.now() - 60_000).toISOString();
  const enrichedTraces = traces.map((t) => ({ ...t, executed_at: recentTs }));
  return (async (url: string) => {
    if (String(url).includes("/v2/activities/templates")) {
      return new Response(JSON.stringify({ templates: TEMPLATES }), { status: 200 });
    }
    if (String(url).includes("/v2/activities/execution-traces")) {
      return new Response(JSON.stringify({ traces: enrichedTraces }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("resolver_pattern_report resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns resolverPatternReport shape", async () => {
    globalThis.fetch = makeFetch([]);
    const result = await resolveResolverPatternReport({ type: "resolver_pattern_report" });
    expect(result.shape).toBe("resolverPatternReport");
  });

  it("aggregates (resolver, output_shape) across traces with success counts", async () => {
    globalThis.fetch = makeFetch([
      { activity_id: "tpl-coverage", success: true },
      { activity_id: "tpl-coverage", success: true },
      { activity_id: "tpl-coverage", success: false },
      { activity_id: "tpl-probe", success: true },
    ]);
    const result = await resolveResolverPatternReport({ type: "resolver_pattern_report" });
    const body = result.body as {
      rows: Array<{
        resolver_id: string; output_shape: string;
        count: number; success_count: number; failure_count: number;
        success_rate: number;
      }>;
    };

    const coverage = body.rows.find(r => r.resolver_id === "coverage_tick" && r.output_shape === "coverageReport");
    expect(coverage).toBeDefined();
    expect(coverage!.count).toBe(3);
    expect(coverage!.success_count).toBe(2);
    expect(coverage!.failure_count).toBe(1);
    expect(coverage!.success_rate).toBeCloseTo(0.667, 2);

    const probe = body.rows.find(r => r.resolver_id === "reachable_unlearned_report");
    expect(probe).toBeDefined();
    expect(probe!.count).toBe(1);
    expect(probe!.success_rate).toBe(1);
  });

  it("emits one row per (resolver, output_shape) for multi-task templates", async () => {
    globalThis.fetch = makeFetch([
      { activity_id: "tpl-multi", success: true },
      { activity_id: "tpl-multi", success: true },
    ]);
    const result = await resolveResolverPatternReport({ type: "resolver_pattern_report" });
    const body = result.body as { rows: Array<{ resolver_id: string; output_shape: string; count: number }> };
    // Two tasks → two rows
    const fsRead = body.rows.find(r => r.resolver_id === "fs_read");
    const llm = body.rows.find(r => r.resolver_id === "llm_completion_dispatch");
    expect(fsRead?.count).toBe(2);
    expect(llm?.count).toBe(2);
  });

  it("respects min_count filter", async () => {
    globalThis.fetch = makeFetch([
      { activity_id: "tpl-coverage", success: true },
      { activity_id: "tpl-probe", success: true },
    ]);
    const result = await resolveResolverPatternReport({ type: "resolver_pattern_report", min_count: 2 });
    const body = result.body as { rows: unknown[]; total_rows: number };
    expect(body.total_rows).toBe(0);
  });

  it("returns empty rows when no traces match", async () => {
    globalThis.fetch = makeFetch([]);
    const result = await resolveResolverPatternReport({ type: "resolver_pattern_report" });
    const body = result.body as { rows: unknown[]; total_observations: number };
    expect(body.rows).toEqual([]);
    expect(body.total_observations).toBe(0);
  });

  it("reports summary metrics", async () => {
    globalThis.fetch = makeFetch([
      { activity_id: "tpl-coverage", success: true },
      { activity_id: "tpl-coverage", success: false },
    ]);
    const result = await resolveResolverPatternReport({ type: "resolver_pattern_report" });
    const body = result.body as {
      total_observations: number;
      total_successes: number;
      overall_success_rate: number;
      unique_resolvers: number;
      unique_output_shapes: number;
    };
    expect(body.total_observations).toBe(2);
    expect(body.total_successes).toBe(1);
    expect(body.overall_success_rate).toBe(0.5);
    expect(body.unique_resolvers).toBe(1);
    expect(body.unique_output_shapes).toBe(1);
  });
});
