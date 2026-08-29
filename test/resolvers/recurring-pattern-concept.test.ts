import { test, expect, afterEach } from "bun:test";
import { resolveRecurringPatternConcept } from "../../src/resolvers/recurring-pattern-concept.js";

// HERMETIC. Before the endpoint fix this suite could not reach the network at all — an empty
// METABOB_ENDPOINT made the URL invalid and the resolver threw ERR_INVALID_URL. With a valid
// URL it would otherwise hit the REAL activity-api, which makes it flaky the moment that
// vessel restarts. CLAUDE.md: "use scripted ProcessPort / fake fetch for HTTP-touching
// resolvers — no real network in tests."
const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function mockTraces(executions: Array<Record<string, unknown>>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v2/activities/execution-traces")) {
      return new Response(JSON.stringify({ executions }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;
}

test("resolveRecurringPatternConcept returns non-hollow report shape", async () => {
  mockTraces([
    { activity_id: "actA", status: "success" },
    { activity_id: "actA", status: "success" },
    { activity_id: "actB", status: "success" },
  ]);
  const result = await resolveRecurringPatternConcept({ type: "recurringPatternConcept", limit: 5 });
  expect(result.shape).toBe("recurringPatternConcept");
  const body = result.body as { name: string; description: string; activities: unknown[] };
  expect(typeof body.name).toBe("string");
  expect(typeof body.description).toBe("string");
  expect(Array.isArray(body.activities)).toBe(true);
});

// Degradation must be shaped, not thrown — the trace store being unreachable is an expected
// operating condition, not a crash.
test("returns the declared shape when the trace store is unreachable", async () => {
  globalThis.fetch = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  const result = await resolveRecurringPatternConcept({ type: "recurringPatternConcept", limit: 5 });
  expect(result.shape).toBe("recurringPatternConcept");
  expect(Array.isArray((result.body as { activities: unknown[] }).activities)).toBe(true);
});
