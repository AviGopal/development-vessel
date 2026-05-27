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
