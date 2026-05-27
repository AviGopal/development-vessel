import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveCoverageTick } from "../../src/resolvers/coverage-tick.js";

const originalFetch = globalThis.fetch;

// Three template shapes: shapeA, shapeB, shapeC
const TEMPLATES = [
  { id: "t:a", output_shapes: ["shapeA"] },
  { id: "t:b", output_shapes: ["shapeB"] },
  { id: "t:c", output_shapes: ["shapeC"] },
];

/**
 * Non-overlapping rolling windows in the new design:
 *   window[0] = [now - 1h, now)     newest
 *   window[1] = [now - 2h, now - 1h)
 *   window[2] = [now - 3h, now - 2h)
 *   window[3] = [now - 4h, now - 3h) oldest
 *
 * Mocks return a single trace list with timestamps in different windows;
 * the resolver's client-side [since, until) filter slices them per window.
 */
function makeFetchProgressing() {
  // Trace timestamps placed mid-window for each of windows 0..2 (no trace in window 3).
  // coverage_progress should be TRUE: shapes are introduced in each newer window.
  const t0 = new Date(Date.now() - 30 * 60 * 1000).toISOString();     // 30min ago → window[0]
  const t1 = new Date(Date.now() - 90 * 60 * 1000).toISOString();     // 1.5h ago → window[1]
  const t2 = new Date(Date.now() - 150 * 60 * 1000).toISOString();    // 2.5h ago → window[2]
  const traces = [
    { output_shapes: ["shapeA"], executed_at: t0 },
    { output_shapes: ["shapeB"], executed_at: t1 },
    { output_shapes: ["shapeC"], executed_at: t2 },
  ];
  return (async (url: string) => {
    if (String(url).includes("/v2/activities/templates")) {
      return new Response(JSON.stringify({ templates: TEMPLATES }), { status: 200 });
    }
    if (String(url).includes("/v2/activities/execution-traces")) {
      return new Response(JSON.stringify({ traces }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function makeFetchFlat() {
  // Same shape (shapeA) in every window — no new-shape introductions in newer
  // windows → coverage_progress should be FALSE.
  const traces = [
    { output_shapes: ["shapeA"], executed_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
    { output_shapes: ["shapeA"], executed_at: new Date(Date.now() - 90 * 60 * 1000).toISOString() },
    { output_shapes: ["shapeA"], executed_at: new Date(Date.now() - 150 * 60 * 1000).toISOString() },
    { output_shapes: ["shapeA"], executed_at: new Date(Date.now() - 210 * 60 * 1000).toISOString() },
  ];
  return (async (url: string) => {
    if (String(url).includes("/v2/activities/templates")) {
      return new Response(JSON.stringify({ templates: TEMPLATES }), { status: 200 });
    }
    if (String(url).includes("/v2/activities/execution-traces")) {
      return new Response(JSON.stringify({ traces }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function makeFetchOnlyMetaActivity() {
  // Trace exists but it's a meta-activity (validator-dispatch) — should be excluded
  // from learned-shape counts. coverage_progress should remain FALSE despite traces.
  const traces = [
    { activity_id: "validator-dispatch", output_shapes: ["validationResult"], executed_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
    { activity_id: "validator-dispatch", output_shapes: ["validationResult"], executed_at: new Date(Date.now() - 90 * 60 * 1000).toISOString() },
  ];
  return (async (url: string) => {
    if (String(url).includes("/v2/activities/templates")) {
      return new Response(JSON.stringify({ templates: TEMPLATES }), { status: 200 });
    }
    if (String(url).includes("/v2/activities/execution-traces")) {
      return new Response(JSON.stringify({ traces }), { status: 200 });
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

  it("coverage_progress=true when new shapes are introduced in recent windows", async () => {
    globalThis.fetch = makeFetchProgressing();
    const result = await resolveCoverageTick({ type: "coverage_tick", num_windows: 4 });
    const body = result.body as {
      coverage_progress: boolean;
      consecutive_progressing_cycles: number;
      recent_new_shapes_introduced: number;
      cells_over_time: Array<{ new_shapes_introduced: number; reachable_learned: number }>;
    };
    expect(body.coverage_progress).toBe(true);
    // Each window introduces exactly 1 new shape: shapeA(w0), shapeB(w1), shapeC(w2)
    expect(body.cells_over_time[0]!.new_shapes_introduced).toBe(1);
    expect(body.cells_over_time[1]!.new_shapes_introduced).toBe(1);
    expect(body.cells_over_time[2]!.new_shapes_introduced).toBe(1);
    expect(body.cells_over_time[3]!.new_shapes_introduced).toBe(0); // window 3 has no traces
    expect(body.recent_new_shapes_introduced).toBeGreaterThan(0);
  });

  it("coverage_progress=false when the same shapes recur without new introductions", async () => {
    globalThis.fetch = makeFetchFlat();
    const result = await resolveCoverageTick({ type: "coverage_tick", num_windows: 4 });
    const body = result.body as {
      coverage_progress: boolean;
      recent_new_shapes_introduced: number;
      cells_over_time: Array<{ new_shapes_introduced: number; reachable_learned: number }>;
    };
    // Same shapeA in every window; the oldest window introduces it. No new shapes in recent half.
    expect(body.coverage_progress).toBe(false);
    expect(body.recent_new_shapes_introduced).toBe(0);
    // shapeA introduced once, in the oldest window
    expect(body.cells_over_time[3]!.new_shapes_introduced).toBe(1);
  });

  it("excludes meta-activity templates from learned-shape counts (F-118)", async () => {
    globalThis.fetch = makeFetchOnlyMetaActivity();
    const result = await resolveCoverageTick({ type: "coverage_tick", num_windows: 4 });
    const body = result.body as {
      coverage_progress: boolean;
      total_learned_unique: number;
      cells_over_time: Array<{ trace_count: number; reachable_learned: number }>;
    };
    // validator-dispatch is excluded → no learning credit, even though traces exist
    expect(body.total_learned_unique).toBe(0);
    expect(body.coverage_progress).toBe(false);
    expect(body.cells_over_time[0]!.trace_count).toBe(0); // substantive traces only
  });

  it("cells_over_time has num_windows entries", async () => {
    globalThis.fetch = makeFetchFlat();
    const result = await resolveCoverageTick({ type: "coverage_tick", num_windows: 3 });
    const body = result.body as { cells_over_time: unknown[] };
    expect(body.cells_over_time).toHaveLength(3);
  });

  it("reports window design and meta-activity exclusion list", async () => {
    globalThis.fetch = makeFetchFlat();
    const result = await resolveCoverageTick({ type: "coverage_tick", num_windows: 2 });
    const body = result.body as {
      window_design: string;
      meta_activities_excluded: string[];
    };
    expect(body.window_design).toBe("non_overlapping_rolling_v2");
    expect(body.meta_activities_excluded).toContain("validator-dispatch");
    expect(body.meta_activities_excluded).toContain("slot-binding");
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
