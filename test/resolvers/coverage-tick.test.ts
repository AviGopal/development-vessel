import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveCoverageTick } from "../../src/resolvers/coverage-tick.js";

const originalFetch = globalThis.fetch;

// Three template shapes: shapeA, shapeB, shapeC
const TEMPLATES = [
  { id: "t:a", output_shapes: ["shapeA"] },
  { id: "t:b", output_shapes: ["shapeB"] },
  { id: "t:c", output_shapes: ["shapeC"] },
];

// callCount tracks which window is being queried so we can return different traces per window
let callCount = 0;

function makeFetchProgressing() {
  callCount = 0;
  // Timestamp guaranteed to be within all windows (30s ago); traces must have
  // executed_at to pass the client-side time filter added in the resolver.
  const recentTs = new Date(Date.now() - 30_000).toISOString();
  return (async (url: string) => {
    if (String(url).includes("/v2/activities/templates")) {
      return new Response(JSON.stringify({ templates: TEMPLATES }), { status: 200 });
    }
    if (String(url).includes("/v2/activities/execution-traces")) {
      callCount++;
      // callCount=1 = 1h lookback (newest): no traces (nothing ran in last 1h)
      // callCount=2 = 2h lookback: shapeA (template ran 1h-2h ago, cumulative)
      // callCount=3 = 3h lookback: shapeA+shapeB (additional template ran 2h-3h ago)
      // callCount=4 = 4h lookback (oldest): all three (additional template ran 3h-4h ago)
      let traces: Array<{ output_shapes: string[]; executed_at: string }> = [];
      if (callCount === 2) traces = [{ output_shapes: ["shapeA"], executed_at: recentTs }];
      if (callCount === 3) traces = [{ output_shapes: ["shapeA"], executed_at: recentTs }, { output_shapes: ["shapeB"], executed_at: recentTs }];
      if (callCount === 4) traces = [
        { output_shapes: ["shapeA"], executed_at: recentTs },
        { output_shapes: ["shapeB"], executed_at: recentTs },
        { output_shapes: ["shapeC"], executed_at: recentTs },
      ];
      return new Response(JSON.stringify({ traces }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function makeFetchFlat() {
  return (async (url: string) => {
    if (String(url).includes("/v2/activities/templates")) {
      return new Response(JSON.stringify({ templates: TEMPLATES }), { status: 200 });
    }
    // Same traces in every window — no progress; executed_at required for client-side filter
    if (String(url).includes("/v2/activities/execution-traces")) {
      return new Response(JSON.stringify({ traces: [{ output_shapes: ["shapeA"], executed_at: new Date(Date.now() - 30_000).toISOString() }] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("coverage-tick resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns coverageReport shape", async () => {
    globalThis.fetch = makeFetchFlat();
    const result = await resolveCoverageTick({ type: "coverage_tick", num_windows: 2 });
    expect(result.shape).toBe("coverageReport");
  });

  it("coverage_progress=true when all three monotonic over 3+ windows", async () => {
    globalThis.fetch = makeFetchProgressing();
    const result = await resolveCoverageTick({ type: "coverage_tick", num_windows: 4 });
    const body = result.body as { coverage_progress: boolean; consecutive_progressing_cycles: number };
    // cells_over_time[0..3] = 1h,2h,3h,4h lookbacks → RL=0,1,2,3 (newest=0, oldest=3)
    // Each consecutive pair (older > newer) shows progress → coverage_progress true
    expect(body.coverage_progress).toBe(true);
    expect(body.consecutive_progressing_cycles).toBeGreaterThanOrEqual(3);
  });

  it("coverage_progress=false when no progress across windows", async () => {
    globalThis.fetch = makeFetchFlat();
    const result = await resolveCoverageTick({ type: "coverage_tick", num_windows: 4 });
    const body = result.body as { coverage_progress: boolean };
    expect(body.coverage_progress).toBe(false);
  });

  it("cells_over_time has num_windows entries", async () => {
    globalThis.fetch = makeFetchFlat();
    const result = await resolveCoverageTick({ type: "coverage_tick", num_windows: 3 });
    const body = result.body as { cells_over_time: unknown[] };
    expect(body.cells_over_time).toHaveLength(3);
  });

  it("monotonic_progress fields are booleans", async () => {
    globalThis.fetch = makeFetchFlat();
    const result = await resolveCoverageTick({ type: "coverage_tick", num_windows: 2 });
    const body = result.body as {
      monotonic_progress: {
        reachable_learned_strictly_increasing: unknown;
        reachable_unlearned_strictly_decreasing: unknown;
        unknown_strictly_decreasing: unknown;
      }
    };
    expect(typeof body.monotonic_progress.reachable_learned_strictly_increasing).toBe("boolean");
    expect(typeof body.monotonic_progress.reachable_unlearned_strictly_decreasing).toBe("boolean");
    expect(typeof body.monotonic_progress.unknown_strictly_decreasing).toBe("boolean");
  });
});
