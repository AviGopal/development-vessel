import { test, expect } from "bun:test";
import * as mod from "../../src/resolvers/substrate-health-tick";

// Reproduces: execution-trace paging uses limit=200 while the route caps at 100,
// and breaks when rows.length < 200 — so only the first 100 (newest) traces are counted.
// With 8 active templates in the last 30 days, but only 7 appearing in the newest 100,
// confidence_passing becomes null (total_pairs 7 < confidence_min_pairs 8), whereas
// a correct 30-day read would be measurable. The assertion expects measurability
// and fails due to the defect.

test("substrate-health-tick pages 30 days of traces by offset (traceOffset) — newest-100 sample makes confidence unmeasured", async () => {
  const origFetch = globalThis.fetch;
  const resetDeps = () => mod.__setSubstrateHealthTickDepsForTests(null);

  // Eight active templates, all non-proposed.
  const templates = Array.from({ length: 8 }, (_, i) => ({ id: `activity:⟨app:t${i}⟩` }));

  // First page (newest) of 100 traces: only t0..t6 appear (7 templates), t7 absent.
  // Distribute counts so every present template easily clears the evidence floor.
  const executions: Array<{ activity_id: string; success: boolean }> = [];
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 14; j++) {
      executions.push({ activity_id: `app:t${i}`, success: (j % 2) === 0 });
    }
  }
  // Pad to exactly 100 with two more for t0.
  executions.push({ activity_id: "app:t0", success: true });
  executions.push({ activity_id: "app:t0", success: false });

  function okJson(obj: unknown): Response {
    return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // Stub fetch so:
  // - Templates enumeration is complete (corpus_complete = true).
  // - Execution traces always return the newest 100, regardless of requested limit=200,
  //   triggering the resolver's break on rows.length < 200 after the first page.
  // - Composition graph returns empty (non-gating).
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.includes("/v2/activities/templates")) {
      return okJson({ templates, total: templates.length });
    }
    if (url.includes("/v2/activities/execution-traces")) {
      // Route cap at 100 + resort → always return 100 rows; resolver requests 200 and breaks early.
      return okJson({ executions });
    }
    if (url.includes("/v2/activities/composition/graph")) {
      return okJson({ edges: [] });
    }
    return new Response("not-found", { status: 404 });
  }) as typeof fetch;

  // Stub side-effecting/system deps so the test is hermetic and fast.
  mod.__setSubstrateHealthTickDepsForTests({
    unitState: async () => ({ active: "active", enabled: "" }),
    registryIds: async () => [],
    lastRegisterFailure: async () => null,
    alarmTicks: async () => 3,
    writeGap: async () => ({}),
    heartbeatPath: () => "substrate-heartbeat.test.json",
    readGap: async () => null,
    editSiteFor: () => null,
    armRead: async () => 0,
  });

  try {
    const res = await mod.resolveSubstrateHealthTick({ type: "substrate_health_tick", lookback_window_seconds: 3600 });
    const body = res.body as any;

    // Due to the paging bug, only 7 templates are observed in traces, so
    // posterior_confidence.total_pairs === 7 and confidence_passing === null.
    // A correct 30-day read would include t7 as well (≥ 8 pairs), making
    // confidence measurable. We assert the intended behavior; it fails now.
    expect(body.registry_fetch.corpus_complete).toBe(true);
    expect(body.posterior_confidence.total_pairs).toBeGreaterThanOrEqual(8);
    // Or equivalently, we could assert measurability:
    // expect(body.health_verdict.confidence_passing).not.toBeNull();
  } finally {
    // Restore globals and deps.
    globalThis.fetch = origFetch;
    resetDeps();
  }
});
