import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveLearnedTopologySnapshot } from "../../src/resolvers/learned-topology-snapshot.js";

const originalFetch = globalThis.fetch;

const FAKE_TEMPLATES = [
  { id: "t:a", output_shapes: ["shapeX", "shapeY"], input_shapes: [], thompson_alpha: 2 },
  { id: "t:b", output_shapes: ["shapeZ"], input_shapes: ["shapeX"], thompson_alpha: 1 },
];

const FAKE_TRACES = [
  { output_shapes: ["shapeX"], activity_template_id: "t:a" },
];

function makeFetch(templates = FAKE_TEMPLATES, traces = FAKE_TRACES, statsOk = true) {
  return (async (url: string) => {
    if (String(url).includes("/v2/activities/templates")) {
      return new Response(JSON.stringify({ templates, total: templates.length }), { status: 200 });
    }
    if (String(url).includes("/v2/activities/execution-traces")) {
      return new Response(JSON.stringify({ traces }), { status: 200 });
    }
    if (String(url).includes("/registry/stats") && statsOk) {
      return new Response(JSON.stringify({ totalShapes: 2 }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("learned-topology-snapshot resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
    process.env["DISCOVERY_ENDPOINT"] = "https://discovery.test";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns learnedTopologySnapshot shape", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveLearnedTopologySnapshot({ type: "learned_topology_snapshot" });
    expect(result.shape).toBe("learnedTopologySnapshot");
  });

  it("advertised_shapes lists all template output_shapes", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveLearnedTopologySnapshot({ type: "learned_topology_snapshot" });
    const body = result.body as { advertised_shapes: Array<{ shape: string }> };
    const shapes = body.advertised_shapes.map(a => a.shape);
    expect(shapes).toContain("shapeX");
    expect(shapes).toContain("shapeY");
    expect(shapes).toContain("shapeZ");
  });

  it("trace_counts counts per shape from traces", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveLearnedTopologySnapshot({ type: "learned_topology_snapshot" });
    const body = result.body as { trace_counts: Record<string, number> };
    expect(body.trace_counts["shapeX"]).toBe(1);
    expect(body.trace_counts["shapeY"]).toBeUndefined();
  });

  it("composition_edges links producer output to consumer input", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveLearnedTopologySnapshot({ type: "learned_topology_snapshot" });
    const body = result.body as { composition_edges: Array<{ from_activity: string; via_shape: string; to_activity: string }> };
    const edge = body.composition_edges.find(e => e.via_shape === "shapeX");
    expect(edge).toBeDefined();
    expect(edge!.from_activity).toBe("t:a");
    expect(edge!.to_activity).toBe("t:b");
  });

  it("counts.reachable_learned > 0 when a traced shape is advertised", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveLearnedTopologySnapshot({ type: "learned_topology_snapshot" });
    const body = result.body as { counts: { reachable_learned: number; reachable_unlearned: number } };
    expect(body.counts.reachable_learned).toBeGreaterThan(0);
    // shapeY and shapeZ have no traces
    expect(body.counts.reachable_unlearned).toBeGreaterThan(0);
  });

  it("handles trace endpoint failure gracefully", async () => {
    globalThis.fetch = makeFetch(FAKE_TEMPLATES, [], false);
    const result = await resolveLearnedTopologySnapshot({ type: "learned_topology_snapshot" });
    expect(result.shape).toBe("learnedTopologySnapshot");
    const body = result.body as { counts: { reachable_learned: number } };
    expect(body.counts.reachable_learned).toBe(0);
  });
});
