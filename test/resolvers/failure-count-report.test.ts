import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

describe("resolveFailureCountReport", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns shape failure_count_report with topTemplates array", async () => {
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const recentIso = new Date(nowMs - 3600 * 1000).toISOString(); // 1 hour ago

    const fakeTraces = [
      { activity_template_id: "tmpl:alpha", created_at: recentIso },
      { activity_template_id: "tmpl:alpha", created_at: recentIso },
      { activity_template_id: "tmpl:beta", created_at: recentIso },
      { activity_template_id: "tmpl:gamma", created_at: recentIso },
      { activity_template_id: "tmpl:gamma", created_at: recentIso },
      { activity_template_id: "tmpl:gamma", created_at: recentIso },
      { activity_template_id: "tmpl:delta", created_at: recentIso },
      { activity_template_id: "tmpl:epsilon", created_at: recentIso },
      { activity_template_id: "tmpl:zeta", created_at: recentIso },
      { activity_template_id: "tmpl:eta", created_at: recentIso },
      { activity_template_id: "tmpl:theta", created_at: recentIso },
    ];

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/v2/traces")) {
        return new Response(JSON.stringify({ traces: fakeTraces }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ templates: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const { resolveFailureCountReport } = await import(
      "../../src/resolvers/failure-count-report.js"
    );

    const result = await resolveFailureCountReport({ type: "failure_count_report" });

    expect(result.shape).toBe("failure_count_report");
    const body = result.body as {
      topTemplates: Array<{ templateId: string; failureCount: number }>;
      windowHours: number;
      generatedAt: string;
    };
    expect(Array.isArray(body.topTemplates)).toBe(true);
    expect(body.topTemplates.length).toBeLessThanOrEqual(8);
    expect(body.windowHours).toBe(24);
    // Top entry should be gamma (count=3)
    const top = body.topTemplates[0];
    if (top !== undefined) {
      expect(top.templateId).toBe("tmpl:gamma");
      expect(top.failureCount).toBe(3);
    }
  });

  it("falls back to templates metrics endpoint when traces returns empty", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/v2/traces")) {
        return new Response(JSON.stringify({ traces: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/v2/activities/templates")) {
        return new Response(
          JSON.stringify({
            templates: [
              { id: "tmpl:x", failure_count: 10 },
              { id: "tmpl:y", failure_count: 5 },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    const { resolveFailureCountReport } = await import(
      "../../src/resolvers/failure-count-report.js"
    );

    const result = await resolveFailureCountReport({ type: "failure_count_report" });
    expect(result.shape).toBe("failure_count_report");
    const body = result.body as {
      topTemplates: Array<{ templateId: string; failureCount: number }>;
    };
    expect(body.topTemplates.length).toBeGreaterThanOrEqual(1);
    const first = body.topTemplates[0];
    if (first !== undefined) {
      expect(first.templateId).toBe("tmpl:x");
      expect(first.failureCount).toBe(10);
    }
  });

  it("returns empty topTemplates when both endpoints return no usable data", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const { resolveFailureCountReport } = await import(
      "../../src/resolvers/failure-count-report.js"
    );

    const result = await resolveFailureCountReport({ type: "failure_count_report" });
    expect(result.shape).toBe("failure_count_report");
    const body = result.body as { topTemplates: unknown[] };
    expect(Array.isArray(body.topTemplates)).toBe(true);
    expect(body.topTemplates.length).toBe(0);
  });
});
