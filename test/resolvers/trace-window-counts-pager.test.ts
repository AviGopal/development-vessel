/**
 * The 30-day count readers (reachable-unlearned-report, substrate-health-tick) read the aggregate, not the trace list.
 *
 * Before: both paged /v2/activities/execution-traces 200 at a time over 30 days; the route clamps to 100, so each loop
 * stopped after one page (a 47-71 s database sort) and counted its newest 100 rows as 30 days. reachable-unlearned-report
 * also made a second limit=500 30-day list read for produced shapes.
 *
 * (a) with traceAggregateReport available (by shape, through discovery), neither reader makes a 30-day list call;
 * (b) without it, the list fallback stops at its page cap and at its wall-time cap;
 * (c) a capped or partial read yields no synthetic pairs or counts;
 * (d) the health verdict on insufficient data abstains (null), never passes;
 * control: with the aggregate complete, the reports' numbers are the aggregate's.
 *
 * Only symbols that exist before the change are imported, so a base run is red on behaviour, not on an import.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveReachableUnlearnedReport } from "../../src/resolvers/reachable-unlearned-report.js";
import { resolveSubstrateHealthTick, __setSubstrateHealthTickDepsForTests } from "../../src/resolvers/substrate-health-tick.js";
import { __setDiscoveryForTests, __resetDiscoveryForTests } from "../../src/config.js";

const originalFetch = globalThis.fetch;
const AGG_URL = "http://agg.fixture/v2/impulses/resolve";

const N = 10;
const TEMPLATES = Array.from({ length: N }, (_, i) => ({
  id: `activity:⟨app:t${i}⟩`,
  output_shapes: [`shape${i}`],
  input_shapes: [] as string[],
  created_at: new Date(Date.now() - 7200_000).toISOString(),
}));

type Agg = Record<string, { count: number; success: number }>;
/** Complete aggregate: every template ran 12 times, 10 succeeded (alpha+beta = 14, above the floor of 10). */
const FULL_AGG: Agg = Object.fromEntries(TEMPLATES.map((_, i) => [`app:t${i}`, { count: 12, success: 10 }]));

interface Fixture {
  aggregate: "available" | "unavailable";
  agg?: Agg;
  /** Rows the trace list returns on EVERY page (offset ignored: a window that never exhausts). */
  listPage?: Array<Record<string, unknown>>;
  listDelayMs?: number;
  tuning?: Record<string, number>;
}

let calls: string[] = [];
let aggPosts: Array<Record<string, unknown>> = [];

/** A 30-day trace-list read: the readers' since_iso form (the 1h/24h reads use `since=`). */
const thirtyDayListCalls = () => calls.filter((u) => u.includes("/v2/activities/execution-traces") && u.includes("since_iso="));

function install(fx: Fixture): void {
  calls = [];
  aggPosts = [];
  __resetDiscoveryForTests();
  __setDiscoveryForTests({
    lookup: async (shape: string) =>
      shape === "traceAggregateReport" && fx.aggregate === "available"
        ? { ok: true, shape, cached: false, producers: [{ id: "activity-api-local", resolveEndpoint: AGG_URL, origin: "local" }] }
        : shape === "traceAggregateReport"
          ? { ok: false, shape, reason: "network", detail: "fixture: no discovery", cached: false }
          : { ok: true, shape, cached: false, producers: [] },
    describe: () => "fixture",
    failureBackoffMs: 2_000,
  } as never);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push(u);
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
    if (u === AGG_URL) {
      const pointer = (JSON.parse(String(init?.body ?? "{}")) as { impulse?: { pointer?: Record<string, unknown> } }).impulse?.pointer ?? {};
      aggPosts.push(pointer);
      const metric = String(pointer["metric"]);
      const agg = fx.agg ?? FULL_AGG;
      const rows = Object.entries(agg).map(([key, v]) => ({ key, value: metric === "success_count" ? v.success : v.count }));
      const report = { shape: "traceAggregateReport", metric, group_by: "activity_id", window_hours: pointer["window_hours"], rows, total_groups: rows.length, truncated: false, empty: rows.length === 0, measured: true, matched_total: rows.reduce((s, r) => s + r.value, 0), query_ms: 5 };
      return json({ success: true, content: JSON.stringify(report) });
    }
    const tuning = u.match(/\/v2\/tuning-params\/([^?]+)/);
    if (tuning) {
      const name = decodeURIComponent(tuning[1]!);
      const v = fx.tuning?.[name];
      return v === undefined ? json({ error: "not found" }, 404) : json({ name, value: v });
    }
    if (u.includes("/v2/activities/templates/auto-promote")) return json({ promoted: [], skipped: [] });
    if (u.includes("/v2/activities/templates")) {
      const offset = Number(new URL(u).searchParams.get("offset") ?? "0");
      return json({ templates: offset === 0 ? TEMPLATES : [], total: TEMPLATES.length });
    }
    if (u.includes("/v2/activities/execution-traces")) {
      if (!u.includes("since_iso=")) return json({ executions: [], traces: [] }); // the 1h / 24h reads
      // A slow page honours its abort signal, as a real fetch does.
      if (fx.listDelayMs) await new Promise<void>((res, rej) => {
        const t = setTimeout(res, fx.listDelayMs);
        init?.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); });
      });
      return json({ executions: fx.listPage ?? [] });
    }
    if (u.includes("/v2/activities/composition/graph")) return json({ edges: [] });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
}

/** 100 rows (the route's page) of confident successes over all ten templates: a full page, so never exhausted. */
const FULL_PAGE = Array.from({ length: 100 }, (_, j) => ({ activity_id: `app:t${j % N}`, success: true, status: "success", output_shapes: [`shape${j % N}`] }));

beforeEach(() => {
  __setSubstrateHealthTickDepsForTests({
    unitState: async () => ({ active: "active", enabled: "" }),
    registryIds: async () => [],
    lastRegisterFailure: async () => null,
    alarmTicks: async () => 3,
    writeGap: async () => ({}),
    heartbeatPath: () => join(tmpdir(), `pager-heartbeat-${process.pid}.json`),
    readGap: async () => null,
    editSiteFor: () => null,
    armRead: async () => 0,
  } as never);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  __setSubstrateHealthTickDepsForTests(null);
  __resetDiscoveryForTests();
});

const HEALTH = { type: "substrate_health_tick" as const, inventory_path: join(tmpdir(), "no-such-inventory.json") };

describe("(a) the aggregate path makes no 30-day trace-list call", () => {
  it("reachable-unlearned-report: 0 paged list calls, no limit=500 30-day read, counts from traceAggregateReport", async () => {
    install({ aggregate: "available", listPage: FULL_PAGE });
    await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    expect(thirtyDayListCalls()).toEqual([]);
    expect(aggPosts.length).toBeGreaterThan(0);
    expect(aggPosts.every((p) => p["type"] === "traceAggregateReport" && p["group_by"] === "activity_id" && p["window_hours"] === 720)).toBe(true);
  });

  it("substrate-health-tick: 0 paged list calls, counts from traceAggregateReport", async () => {
    install({ aggregate: "available", listPage: FULL_PAGE });
    await resolveSubstrateHealthTick(HEALTH);
    expect(thirtyDayListCalls()).toEqual([]);
    expect(aggPosts.map((p) => p["metric"]).sort()).toEqual(["count", "success_count"]);
  });
});

describe("(b) without the aggregate, the list fallback is capped by pages and by wall time", () => {
  it("stops at the page cap (tuning row) and reports insufficient data", async () => {
    install({ aggregate: "unavailable", listPage: FULL_PAGE, tuning: { "trace_counts.fallback_max_pages": 4, "trace_counts.fallback_wall_ms": 60_000 } });
    const res = await resolveSubstrateHealthTick(HEALTH);
    expect(thirtyDayListCalls().length).toBe(4);
    const tc = (res.body as { trace_counts?: { measured: boolean; reason?: string; pages: number } }).trace_counts;
    expect(tc?.measured).toBe(false);
    expect(tc?.reason).toContain("fallback_page_cap");
    expect(tc?.pages).toBe(4);
  });

  it("stops at the wall-time cap before the page cap", async () => {
    install({ aggregate: "unavailable", listPage: FULL_PAGE, listDelayMs: 120, tuning: { "trace_counts.fallback_max_pages": 50, "trace_counts.fallback_wall_ms": 300 } });
    const t0 = Date.now();
    const res = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const n = thirtyDayListCalls().length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(4);
    expect(Date.now() - t0).toBeLessThan(5_000);
    const ec = (res.body as { execution_counts?: { measured: boolean; reason?: string } }).execution_counts;
    expect(ec?.measured).toBe(false);
    expect(ec?.reason).toContain("fallback_wall_cap");
  });

  it("a window that ends inside both caps is complete, read from the list", async () => {
    // One short page (7 rows < 100): the window was exhausted, so the counts are measured.
    const short = FULL_PAGE.slice(0, 7);
    install({ aggregate: "unavailable", listPage: short });
    const res = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    expect(thirtyDayListCalls().length).toBe(1);
    const ec = (res.body as { execution_counts?: { measured: boolean; source: string } }).execution_counts;
    expect(ec?.measured).toBe(true);
    expect(ec?.source).toBe("list");
  });
});

describe("(c) missing data yields no synthetic pairs or counts", () => {
  it("health tick: a capped read builds no pairs at all (not the partial slice, not alpha=1/beta=1 padding)", async () => {
    install({ aggregate: "unavailable", listPage: FULL_PAGE, tuning: { "trace_counts.fallback_max_pages": 2 } });
    const res = await resolveSubstrateHealthTick(HEALTH);
    const pc = (res.body as { posterior_confidence: { total_pairs: number; pairs_above_floor: number } }).posterior_confidence;
    expect(pc.total_pairs).toBe(0);
    expect(pc.pairs_above_floor).toBe(0);
  });

  it("health tick: templates the aggregate does not name get no pair", async () => {
    // Only 3 of 10 templates ran in the window. 3 pairs, never 10 with seven invented {1,1} priors.
    const agg: Agg = { "app:t0": { count: 12, success: 10 }, "app:t1": { count: 12, success: 10 }, "app:t2": { count: 4, success: 1 } };
    install({ aggregate: "available", agg });
    const res = await resolveSubstrateHealthTick(HEALTH);
    const body = res.body as { posterior_confidence: { total_pairs: number; pairs_above_floor: number }; health_verdict: { confidence_passing: boolean | null } };
    expect(body.posterior_confidence.total_pairs).toBe(3);
    expect(body.posterior_confidence.pairs_above_floor).toBe(2);
    expect(body.health_verdict.confidence_passing).toBeNull(); // 3 < confidence_min_pairs (8): thin, not a pass
  });

  it("reachable report: a capped read reports the floor as unknown (null), never a count from the slice", async () => {
    const weak = Array.from({ length: 100 }, (_, j) => ({ activity_id: `app:t${j % N}`, success: true, output_shapes: [] }));
    install({ aggregate: "unavailable", listPage: weak, tuning: { "trace_counts.fallback_max_pages": 1 } });
    const res = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const body = res.body as { below_confidence_floor: unknown[]; below_confidence_floor_count: number | null; top_below_floor_runs_needed: number | null };
    expect(body.below_confidence_floor).toEqual([]);
    expect(body.below_confidence_floor_count).toBeNull();
    expect(body.top_below_floor_runs_needed).toBeNull();
  });
});

describe("(d) the health verdict on insufficient data abstains", () => {
  it("confidence, stability and overall are null (abstain), both dimensions listed unmeasured", async () => {
    install({ aggregate: "unavailable", listPage: FULL_PAGE, tuning: { "trace_counts.fallback_max_pages": 2 } });
    const res = await resolveSubstrateHealthTick(HEALTH);
    const v = (res.body as { health_verdict: { confidence_passing: boolean | null; stability_passing: boolean | null; overall_passing: boolean | null; unmeasured_dimensions: string[] } }).health_verdict;
    expect(v.confidence_passing).toBeNull();
    expect(v.stability_passing).toBeNull();
    expect(v.overall_passing).toBeNull();
    expect(v.unmeasured_dimensions).toContain("posterior_confidence");
    expect(v.unmeasured_dimensions).toContain("graph_stability");
  });
});

describe("control: with the aggregate complete, the numbers are the aggregate's", () => {
  it("health tick: one pair per aggregate row, alpha = success+1, beta = fail+1, and a measured verdict", async () => {
    const agg: Agg = { ...FULL_AGG, "app:t9": { count: 3, success: 1 } };
    install({ aggregate: "available", agg });
    const res = await resolveSubstrateHealthTick(HEALTH);
    const body = res.body as { posterior_confidence: { total_pairs: number; pairs_above_floor: number; median_alpha_plus_beta: number }; health_verdict: { confidence_passing: boolean | null; stability_passing: boolean | null }; trace_counts?: { measured: boolean; source: string; templates_counted: number } };
    expect(body.trace_counts?.measured).toBe(true);
    expect(body.trace_counts?.source).toBe("aggregate");
    expect(body.trace_counts?.templates_counted).toBe(N);
    expect(body.posterior_confidence.total_pairs).toBe(N);
    expect(body.posterior_confidence.pairs_above_floor).toBe(N - 1); // t9: (1+1)+(2+1) = 5 < 10
    expect(body.posterior_confidence.median_alpha_plus_beta).toBe(14); // 12 runs + 2
    expect(body.health_verdict.confidence_passing).toBe(true);
    expect(body.health_verdict.stability_passing).toBe(true);
  });

  it("reachable report: below_confidence_floor carries the aggregate's counts", async () => {
    const agg: Agg = { ...FULL_AGG, "app:t3": { count: 3, success: 3 }, "app:t5": { count: 6, success: 0 } };
    install({ aggregate: "available", agg });
    const res = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const body = res.body as { below_confidence_floor: Array<{ template_id: string; total_executions: number; runs_needed: number }>; below_confidence_floor_count: number | null; execution_counts?: { source: string } };
    expect(body.execution_counts?.source).toBe("aggregate");
    expect(body.below_confidence_floor).toEqual([
      { template_id: "activity:⟨app:t5⟩", total_executions: 6, runs_needed: 2 },
      { template_id: "activity:⟨app:t3⟩", total_executions: 3, runs_needed: 5 },
    ]);
    expect(body.below_confidence_floor_count).toBe(2);
  });
});
