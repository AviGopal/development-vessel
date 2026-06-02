import { describe, it, expect, afterEach } from "bun:test";
import { resolveTemplateInvocationHistoryReport } from "../../src/resolvers/template-invocation-history-report.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function routedFetch(
  templatesData: unknown,
  tracesData: unknown,
  templatesFails = false,
  tracesFails = false,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/templates")) {
      if (templatesFails) throw new Error("templates down");
      return new Response(JSON.stringify(templatesData), { status: 200 });
    }
    if (url.includes("/execution-traces")) {
      if (tracesFails) throw new Error("traces down");
      return new Response(JSON.stringify(tracesData), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("template_invocation_history_report", () => {
  it("flags template with zero invocations as unfired", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    globalThis.fetch = routedFetch(
      {
        templates: [
          { id: "scaffold-new-vessel", registered_at: tenDaysAgo, tags: ["intent:scaffold"] },
          { id: "fired-template", registered_at: tenDaysAgo },
        ],
      },
      {
        executions: [
          { activity_id: "fired-template" },
          { activity_id: "fired-template" },
        ],
      },
    );
    const r = await resolveTemplateInvocationHistoryReport({
      type: "template_invocation_history_report",
      templatesUrl: "http://api/templates",
      tracesUrl: "http://api/execution-traces",
    });
    expect(r.shape).toBe("templateInvocationHistoryReport");
    const body = r.body as any;
    expect(body.total_templates).toBe(2);
    expect(body.fired_count).toBe(1);
    expect(body.unfired_count).toBe(1);
    const unfiredIds = body.unfired_capabilities.map((u: any) => u.template_id);
    expect(unfiredIds).toContain("scaffold-new-vessel");
    const sc = body.unfired_capabilities.find((u: any) => u.template_id === "scaffold-new-vessel");
    expect(sc.days_since_registered).toBeGreaterThanOrEqual(9);
    expect(sc.intended_trigger).toBe("intent:scaffold");
  });

  it("returns structuredError on templates fetch failure", async () => {
    globalThis.fetch = routedFetch({ templates: [] }, { executions: [] }, true, false);
    const r = await resolveTemplateInvocationHistoryReport({
      type: "template_invocation_history_report",
      templatesUrl: "http://api/templates",
      tracesUrl: "http://api/execution-traces",
    });
    expect(r.shape).toBe("structuredError");
  });

  it("returns HEALTHY when all templates fired", async () => {
    globalThis.fetch = routedFetch(
      { templates: [{ id: "t1" }, { id: "t2" }] },
      { executions: [{ activity_id: "t1" }, { activity_id: "t2" }] },
    );
    const r = await resolveTemplateInvocationHistoryReport({
      type: "template_invocation_history_report",
      templatesUrl: "http://api/templates",
      tracesUrl: "http://api/execution-traces",
    });
    const body = r.body as any;
    expect(body.health_verdict).toBe("HEALTHY");
    expect(body.unfired_count).toBe(0);
  });

  it("graceful when traces query fails", async () => {
    globalThis.fetch = routedFetch(
      { templates: [{ id: "t1" }] },
      { executions: [] },
      false,
      true,
    );
    const r = await resolveTemplateInvocationHistoryReport({
      type: "template_invocation_history_report",
      templatesUrl: "http://api/templates",
      tracesUrl: "http://api/execution-traces",
    });
    const body = r.body as any;
    // traces failed → no firings detected → unfired
    expect(body.unfired_count).toBe(1);
  });
});
