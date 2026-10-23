import { test, expect } from "bun:test";
import * as mod from "../../src/resolvers/failure-count-report";

// This test reproduces the observed defect: the execution-traces list route
// returns rows with {activity_id,status} (and sometimes success), but the
// resolver keys by {templateId|activity_template_id|activityTemplateId} and
// outcome by {outcome|status|result}. With no templateId field present, all
// rows are skipped and the report silently degrades to an empty "nothing
// failed" answer even when failures exist.
//
// We stub the API:
// - /v2/activities/execution-traces => executions with only {activity_id,status:"failed"}
// - /v2/activities/templates        => empty, so the fallback contributes nothing
// The intended behavior is a non-empty templates list; today it returns [].

test("failure-count-report should surface failures from execution-traces rows (non-empty templates)", async () => {
  const originalEndpoint = process.env.METABOB_ENDPOINT;
  process.env.METABOB_ENDPOINT = "http://fake.local";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string"
      ? new URL(input)
      : input instanceof Request
        ? new URL(input.url)
        : new URL(String(input));

    if (url.pathname === "/v2/activities/execution-traces") {
      // Two failed executions with ONLY activity_id + status, no templateId fields.
      return new Response(
        JSON.stringify({
          executions: [
            { activity_id: "activities:node1:a", status: "failed" },
            { activity_id: "activities:node1:b", status: "failed" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/v2/activities/templates") {
      // Fallback provides nothing — so the defect yields an empty report.
      return new Response(
        JSON.stringify({ templates: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await mod.resolveFailureCountReport({ type: "failure_count_report" });
    expect(result.shape).toBe("failureCountReport");

    const body = result.body as { templates?: unknown };
    const templates = Array.isArray(body?.templates) ? body.templates : [];

    // EXPECTED: the two failed executions should yield a NON-EMPTY failure report.
    // ACTUAL (defect): [], because templateId is undefined on each row and they are skipped.
    expect(templates.length).toBeGreaterThan(0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEndpoint === undefined) delete process.env.METABOB_ENDPOINT;
    else process.env.METABOB_ENDPOINT = originalEndpoint;
  }
});
