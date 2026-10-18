import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveReachableUnlearnedReport } from "../../src/resolvers/reachable-unlearned-report.js";

const originalFetch = globalThis.fetch;

const TEMPLATES = [
  { id: "t:a", output_shapes: ["shapeX", "shapeY"], thompson_alpha: 3 },
  { id: "t:b", output_shapes: ["shapeZ"], thompson_alpha: 1 },
];

// shapeX is learned (in a trace), shapeY and shapeZ are not
const TRACES_WITH_X = [{ output_shapes: ["shapeX"] }];

function makeFetch(templates = TEMPLATES, traces = TRACES_WITH_X) {
  return (async (url: string) => {
    if (String(url).includes("/v2/activities/templates")) {
      return new Response(JSON.stringify({ templates, total: templates.length }), { status: 200 });
    }
    if (String(url).includes("/v2/activities/execution-traces")) {
      return new Response(JSON.stringify({ traces }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("reachable-unlearned-report resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns reachableButUnlearnedReport shape", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    expect(result.shape).toBe("reachableButUnlearnedReport");
  });

  it("excludes shapes that have traces", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const body = result.body as { entries: Array<{ shape: string }> };
    const shapes = body.entries.map(e => e.shape);
    expect(shapes).not.toContain("shapeX");
    expect(shapes).toContain("shapeY");
    expect(shapes).toContain("shapeZ");
  });

  it("total matches entries length", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const body = result.body as { entries: unknown[]; total: number };
    expect(body.total).toBe(body.entries.length);
  });

  it("entries include best_template_id", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const body = result.body as { entries: Array<{ shape: string; best_template_id: string }> };
    const shapeY = body.entries.find(e => e.shape === "shapeY");
    expect(shapeY?.best_template_id).toBe("t:a");
  });

  it("returns empty entries when all shapes are learned", async () => {
    const allLearned = [{ output_shapes: ["shapeX", "shapeY", "shapeZ"] }];
    globalThis.fetch = makeFetch(TEMPLATES, allLearned);
    const result = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const body = result.body as { total: number };
    expect(body.total).toBe(0);
  });

  it("rotates: tied-priority shapes ranked by producer last-execution (oldest first)", async () => {
    // Three templates, three unlearned shapes (all tied at 1/3 priority).
    // Producer t:a was just executed; producer t:b was executed an hour ago;
    // producer t:c was never executed. Expected order: t:c first (most stale),
    // then t:b, then t:a. This prevents the substrate from always dispatching
    // the same producer (live bug: 3 consecutive observer dispatches all to
    // release-change with priority=0.04 tied across 25 shapes).
    const tpls = [
      { id: "t:a", output_shapes: ["shapeA"], thompson_alpha: 1 },
      { id: "t:b", output_shapes: ["shapeB"], thompson_alpha: 1 },
      { id: "t:c", output_shapes: ["shapeC"], thompson_alpha: 1 },
    ];
    const now = Date.now();
    const wideTraces = [
      // t:a most recent (within last 24h but not 1h, so its shape stays unlearned)
      { activity_id: "t:a", output_shapes: [], executed_at: new Date(now - 5 * 60 * 1000).toISOString() },
      { activity_id: "t:b", output_shapes: [], executed_at: new Date(now - 60 * 60 * 1000).toISOString() },
      // t:c — no execution in wide window
    ];
    let templateFetchCount = 0;
    let traceFetchCount = 0;
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/v2/activities/templates")) {
        templateFetchCount++;
        return new Response(JSON.stringify({ templates: tpls, total: tpls.length }), { status: 200 });
      }
      if (u.includes("/v2/activities/execution-traces")) {
        traceFetchCount++;
        // The wider trace fetch (24h since) returns the rotation evidence;
        // the narrower 1h fetch returns empty (none of these shapes are learned).
        const isWide = u.includes("limit=500");
        return new Response(JSON.stringify({ traces: isWide ? wideTraces : [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const body = result.body as {
      entries: Array<{ shape: string; best_template_id: string; best_template_last_executed_ms: number }>;
      top_shape: string;
      top_template_id: string;
      producers_exercised_last_24h: number;
    };

    expect(body.entries).toHaveLength(3);
    // Rotation order: never-exercised (t:c) first, then oldest-exercised (t:b), then most-recent (t:a)
    expect(body.entries[0]!.best_template_id).toBe("t:c");
    expect(body.entries[0]!.best_template_last_executed_ms).toBe(0);
    expect(body.entries[1]!.best_template_id).toBe("t:b");
    expect(body.entries[2]!.best_template_id).toBe("t:a");
    expect(body.top_template_id).toBe("t:c");
    expect(body.top_shape).toBe("shapeC");
    expect(body.producers_exercised_last_24h).toBe(2);
  });
});

// ---- 30-day execution counts come from ONE server-side aggregate ----
//
// The trace list route caps limit at 100, so the old offset loop was one request that sorted the
// whole 30-day window and counted only its newest 100 rows, reported as 30 days. The counts behind
// below_confidence_floor now come from traceAggregateReport (group_by activity_id, 720h), and an
// aggregate that did not measure is UNKNOWN (null + reason), never zero.
describe("reachable-unlearned-report: 30-day counts by aggregate", () => {
  const FLOOR_TEMPLATES = [
    { id: "activity:⟨t:a⟩", output_shapes: ["shapeA"] },
    { id: "activity:⟨t:b⟩", output_shapes: ["shapeB"] },
    { id: "activity:⟨t:c⟩", output_shapes: ["shapeC"] },
  ];
  const AGG_OK = {
    shape: "traceAggregateReport", metric: "count", group_by: "activity_id", window_hours: 720,
    rows: [{ key: "activity:⟨t:a⟩", value: 5 }, { key: "t:b", value: 3 }, { key: "t:c", value: 40 }],
    total_groups: 3, truncated: false, empty: false, measured: true, matched_total: 48, query_ms: 1,
  };

  function aggFetch(report: Record<string, unknown>) {
    const calls = { aggregates: [] as Array<Record<string, unknown>>, lists: [] as string[] };
    const f = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v2/activities/templates/auto-promote")) return new Response(JSON.stringify({ promoted: [], skipped: [] }), { status: 200 });
      if (u.includes("/v2/activities/templates")) {
        return new Response(JSON.stringify({ templates: FLOOR_TEMPLATES, total: FLOOR_TEMPLATES.length }), { status: 200 });
      }
      if (u.includes("/v2/impulses/resolve")) {
        const pointer = (JSON.parse(String(init?.body ?? "{}")) as { impulse?: { pointer?: Record<string, unknown> } }).impulse?.pointer ?? {};
        calls.aggregates.push(pointer);
        return new Response(JSON.stringify({ success: true, content: JSON.stringify(report) }), { status: 200 });
      }
      if (u.includes("/v2/activities/execution-traces")) {
        calls.lists.push(u);
        // What the paged loop would count: two t:a rows, no others.
        return new Response(JSON.stringify({ executions: [{ activity_id: "t:a" }, { activity_id: "t:a" }] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });
  afterAll(() => { globalThis.fetch = originalFetch; });

  it("must-fail: ONE aggregate request (group_by activity_id, window_hours 720) replaces the offset-paged list loop", async () => {
    const { f, calls } = aggFetch(AGG_OK);
    globalThis.fetch = f;
    await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const aggs = calls.aggregates.filter((p) => p["type"] === "traceAggregateReport");
    expect(aggs).toHaveLength(1);
    expect(aggs[0]!["group_by"]).toBe("activity_id");
    expect(aggs[0]!["window_hours"]).toBe(720);
    expect(calls.lists.filter((u) => u.includes("offset="))).toEqual([]);
  });

  it("must-fail: below_confidence_floor counts come from the aggregate rows, wrapped and bare ids counted once", async () => {
    const { f } = aggFetch(AGG_OK);
    globalThis.fetch = f;
    const result = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const body = result.body as {
      below_confidence_floor: Array<{ template_id: string; total_executions: number; runs_needed: number }>;
      below_confidence_floor_count: number | null; top_below_floor_template_id: string | null; top_below_floor_runs_needed: number | null;
      execution_counts_measured: boolean; execution_counts_reason: string | null;
    };
    // floor 10 → 8 executions needed; t:c (40) clears it.
    expect(body.below_confidence_floor).toEqual([
      { template_id: "activity:⟨t:a⟩", total_executions: 5, runs_needed: 3 },
      { template_id: "activity:⟨t:b⟩", total_executions: 3, runs_needed: 5 },
    ]);
    expect(body.below_confidence_floor_count).toBe(2);
    expect(body.top_below_floor_template_id).toBe("activity:⟨t:a⟩");
    expect(body.top_below_floor_runs_needed).toBe(3);
    expect(body.execution_counts_measured).toBe(true);
    expect(body.execution_counts_reason).toBeNull();
  });

  it("control: the report keeps its fields and types for a fixed aggregate response", async () => {
    const { f } = aggFetch(AGG_OK);
    globalThis.fetch = f;
    const result = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    expect(result.shape).toBe("reachableButUnlearnedReport");
    const body = result.body as Record<string, unknown>;
    for (const k of ["generated_at", "snapshot_id", "top_template_id", "top_shape"]) expect(k in body).toBe(true);
    expect(Array.isArray(body["entries"])).toBe(true);
    expect(body["total"]).toBe((body["entries"] as unknown[]).length);
    for (const k of ["top_template_last_executed_ms", "producers_exercised_last_24h", "below_confidence_floor_count",
      "confidence_floor", "executions_needed_for_floor", "top_below_floor_runs_needed"]) expect(typeof body[k]).toBe("number");
    expect(Array.isArray(body["below_confidence_floor"])).toBe(true);
    expect(body["confidence_floor"]).toBe(10);
    expect(body["executions_needed_for_floor"]).toBe(8);
  });

  it("control: measured:false is a named failure — floor fields UNKNOWN (null), never zero; entries still reported", async () => {
    const { f } = aggFetch({ ...AGG_OK, rows: [], measured: false, matched_total: null, reason: "unserved_group_by" });
    globalThis.fetch = f;
    const result = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const body = result.body as Record<string, unknown>;
    expect(body["execution_counts_measured"]).toBe(false);
    expect(body["execution_counts_reason"]).toBe("unserved_group_by");
    expect(body["below_confidence_floor_count"]).toBeNull();
    expect(body["top_below_floor_runs_needed"]).toBeNull();
    expect(body["top_below_floor_template_id"]).toBeNull();
    expect(body["below_confidence_floor"]).toEqual([]);
    expect((body["entries"] as unknown[]).length).toBe(3);
  });

  it("control: a truncated aggregate is unmeasured (it drops the low-count groups the floor exists to find)", async () => {
    const { f } = aggFetch({ ...AGG_OK, truncated: true });
    globalThis.fetch = f;
    const result = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const body = result.body as Record<string, unknown>;
    expect(body["execution_counts_measured"]).toBe(false);
    expect(body["execution_counts_reason"]).toBe("aggregate_truncated");
    expect(body["below_confidence_floor_count"]).toBeNull();
  });
});
