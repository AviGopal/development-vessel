import { describe, it, expect, afterEach } from "bun:test";
import { resolveCompositionCoverageReport } from "../../src/resolvers/composition-coverage-report.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeFetch(templates: Array<Record<string, unknown>>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ templates }), { status: 200 })) as unknown as typeof fetch;
}

describe("composition_coverage_report", () => {
  it("classifies orphan_producer when output shape has no consumer", async () => {
    globalThis.fetch = makeFetch([
      { id: "scaffold-new-vessel", inputShapes: ["cwd"], outputShapes: ["commandResult"] },
      { id: "another", inputShapes: ["other_in"], outputShapes: ["other_out"] },
    ]);
    const r = await resolveCompositionCoverageReport({
      type: "composition_coverage_report",
      templatesUrl: "http://x/",
    });
    expect(r.shape).toBe("compositionCoverageReport");
    const body = r.body as any;
    expect(body.orphan_producer_total).toBeGreaterThan(0);
    const orphanIds = body.orphan_producers.map((p: any) => p.template_id);
    expect(orphanIds).toContain("scaffold-new-vessel");
  });

  it("classifies orphan_consumer when input shape has no producer", async () => {
    globalThis.fetch = makeFetch([
      { id: "consumer", inputShapes: ["missing_shape"], outputShapes: ["produced_out"] },
    ]);
    const r = await resolveCompositionCoverageReport({
      type: "composition_coverage_report",
      templatesUrl: "http://x/",
    });
    const body = r.body as any;
    expect(body.orphan_consumer_total).toBeGreaterThan(0);
    const cons = body.orphan_consumers.find((c: any) => c.template_id === "consumer");
    expect(cons.missing_input_shapes).toContain("missing_shape");
  });

  it("HEALTH WELL_CONNECTED when no orphans", async () => {
    globalThis.fetch = makeFetch([
      { id: "a", inputShapes: ["in1"], outputShapes: ["mid"] },
      { id: "b", inputShapes: ["mid"], outputShapes: ["out"] },
      { id: "seed", inputShapes: [], outputShapes: ["in1"] },
      { id: "sink", inputShapes: ["out"], outputShapes: [] },
    ]);
    const r = await resolveCompositionCoverageReport({
      type: "composition_coverage_report",
      templatesUrl: "http://x/",
    });
    const body = r.body as any;
    expect(body.health_verdict).toBe("WELL_CONNECTED");
  });

  it("network failure returns structuredError", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const r = await resolveCompositionCoverageReport({
      type: "composition_coverage_report",
      templatesUrl: "http://x/",
    });
    expect(r.shape).toBe("structuredError");
  });
});
