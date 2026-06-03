import { describe, it, expect, afterEach } from "bun:test";
import { resolveVesselArchitecturePatternScan } from "../../src/resolvers/vessel-architecture-pattern-scan.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function routedFetch(routes: Array<{ match: string; status?: number; body: unknown }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    for (const r of routes) {
      if (url.includes(r.match)) {
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
      }
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("vessel_architecture_pattern_scan", () => {
  it("flags single_dispatcher when one dispatcher handles >=90% of traces", async () => {
    const traces = Array.from({ length: 10 }, (_, i) => ({
      status: i === 9 ? "failure" : "success",
      duration_ms: 500,
      metadata: { dispatcher_used: i === 9 ? "light-dispatch" : "goal-host-vessel", template_id: "tpl-a" },
    }));
    globalThis.fetch = routedFetch([
      { match: "execution-traces", body: { executions: traces } },
      { match: "/shapes", body: { shapes: ["a", "b"] } },
      { match: "/templates", body: { templates: [{ id: "tpl-a", inputShapes: ["a"], outputShapes: ["b"] }] } },
    ]);
    const r = await resolveVesselArchitecturePatternScan({
      type: "vessel_architecture_pattern_scan",
      dry_run: true,
    });
    expect(r.shape).toBe("vesselArchitecturePatternScan");
    const body = r.body as any;
    const single = body.findings.find((f: any) => f.pattern === "single_dispatcher");
    expect(single).toBeTruthy();
    expect(single.severity).toBe("high");
  });

  it("flags catalogue_bloat when advertised >> invoked", async () => {
    const advertised = Array.from({ length: 100 }, (_, i) => `shape_${i}`);
    globalThis.fetch = routedFetch([
      {
        match: "execution-traces",
        body: { executions: [{ status: "success", metadata: { template_id: "tpl-x", dispatcher_used: "a" } }] },
      },
      { match: "/shapes", body: { shapes: advertised } },
      { match: "/templates", body: { templates: [{ id: "tpl-x", inputShapes: ["shape_0"], outputShapes: ["shape_1"] }] } },
    ]);
    const r = await resolveVesselArchitecturePatternScan({
      type: "vessel_architecture_pattern_scan",
      dry_run: true,
    });
    const body = r.body as any;
    const bloat = body.findings.find((f: any) => f.pattern === "catalogue_bloat");
    expect(bloat).toBeTruthy();
    expect(bloat.evidence.advertised_count).toBe(100);
  });

  it("flags cost_output_mismatch on high-duration zero-task failures", async () => {
    const traces = Array.from({ length: 5 }, () => ({
      status: "failure",
      duration_ms: 9000,
      tasks: [],
      metadata: { template_id: "tpl-bad", dispatcher_used: "a" },
    }));
    globalThis.fetch = routedFetch([
      { match: "execution-traces", body: { executions: traces } },
      { match: "/shapes", body: { shapes: ["x"] } },
      { match: "/templates", body: { templates: [] } },
    ]);
    const r = await resolveVesselArchitecturePatternScan({
      type: "vessel_architecture_pattern_scan",
      dry_run: true,
    });
    const body = r.body as any;
    const com = body.findings.find((f: any) => f.pattern === "cost_output_mismatch");
    expect(com).toBeTruthy();
    expect(com.evidence.cost_output_mismatch_count).toBe(5);
  });

  it("returns no findings when traces are healthy and diverse", async () => {
    const traces = [
      { status: "success", duration_ms: 200, tasks: [{}, {}], metadata: { dispatcher_used: "a", template_id: "t1" } },
      { status: "success", duration_ms: 200, tasks: [{}, {}], metadata: { dispatcher_used: "b", template_id: "t1" } },
      { status: "success", duration_ms: 200, tasks: [{}, {}], metadata: { dispatcher_used: "c", template_id: "t1" } },
    ];
    globalThis.fetch = routedFetch([
      { match: "execution-traces", body: { executions: traces } },
      { match: "/shapes", body: { shapes: ["a", "b"] } },
      { match: "/templates", body: { templates: [{ id: "t1", inputShapes: ["a"], outputShapes: ["b"] }] } },
    ]);
    const r = await resolveVesselArchitecturePatternScan({
      type: "vessel_architecture_pattern_scan",
      dry_run: true,
    });
    const body = r.body as any;
    expect(body.finding_count).toBe(0);
  });
});
