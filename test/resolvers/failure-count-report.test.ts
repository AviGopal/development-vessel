import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

describe("resolveFailureCountReport", () => {
  const originalFetch = globalThis.fetch;

  // The resolver builds `new URL("/v2/activities/execution-traces", endpoint)` from
  // `process.env.METABOB_ENDPOINT ?? "http://127.0.0.1:8080"`. `??` falls back only on
  // null/undefined — NOT on "" — and this container exports METABOB_ENDPOINT as an EMPTY
  // STRING, so the default never applied and the URL constructor threw
  // ERR_INVALID_URL ("/v2/activities/execution-traces" cannot be parsed as a URL) before
  // any assertion ran. Pin it so the suite does not depend on ambient env, and restore it
  // exactly — including the unset case — so this file never becomes a polluter itself.
  const ORIGINAL_ENDPOINT = process.env.METABOB_ENDPOINT;
  beforeEach(() => {
    process.env.METABOB_ENDPOINT = "http://127.0.0.1:8080";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (ORIGINAL_ENDPOINT === undefined) delete process.env.METABOB_ENDPOINT;
    else process.env.METABOB_ENDPOINT = ORIGINAL_ENDPOINT;
  });

  it("returns shape failure_count_report with templates array", async () => {
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

    // The resolver ALWAYS emits `failureCountReport` (failure-count-report.ts:69). The
    // snake_case `failure_count_report` used in the pointer above is an accepted INPUT
    // alias only (impulses.ts:935 alongside the camelCase case at :257) — an input alias
    // is not an output shape, and the emitted shape is what downstream binds against.
    expect(result.shape).toBe("failureCountReport");
    const body = result.body as {
      templates: Array<{ templateId: string; failureCount: number }>;
      windowHours: number;
      generatedAt: string;
    };
    // The resolver emits `body.templates` (failure-count-report.ts:70). Nothing anywhere
    // consumes a `topTemplates` field on this shape — that name was stale.
    expect(Array.isArray(body.templates)).toBe(true);
    expect(body.templates.length).toBeLessThanOrEqual(8);
    expect(body.windowHours).toBe(24);
    // Top entry should be gamma (count=3)
    const top = body.templates[0];
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
    // The resolver ALWAYS emits `failureCountReport` (failure-count-report.ts:69). The
    // snake_case `failure_count_report` used in the pointer above is an accepted INPUT
    // alias only (impulses.ts:935 alongside the camelCase case at :257) — an input alias
    // is not an output shape, and the emitted shape is what downstream binds against.
    expect(result.shape).toBe("failureCountReport");
    const body = result.body as {
      templates: Array<{ templateId: string; failureCount: number }>;
    };
    expect(body.templates.length).toBeGreaterThanOrEqual(1);
    const first = body.templates[0];
    if (first !== undefined) {
      expect(first.templateId).toBe("tmpl:x");
      expect(first.failureCount).toBe(10);
    }
  });

  it("returns empty templates when both endpoints return no usable data", async () => {
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
    // The resolver ALWAYS emits `failureCountReport` (failure-count-report.ts:69). The
    // snake_case `failure_count_report` used in the pointer above is an accepted INPUT
    // alias only (impulses.ts:935 alongside the camelCase case at :257) — an input alias
    // is not an output shape, and the emitted shape is what downstream binds against.
    expect(result.shape).toBe("failureCountReport");
    const body = result.body as { templates: unknown[] };
    expect(Array.isArray(body.templates)).toBe(true);
    expect(body.templates.length).toBe(0);
  });
});
