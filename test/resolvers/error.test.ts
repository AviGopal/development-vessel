import { resolveError } from "../../src/resolvers/error.js";
import { describe, expect, test, afterEach } from "bun:test";

// HERMETIC. These tests previously called resolveError() with no fetch stub, so they hit the
// live trace store over the network — which this vessel's CLAUDE.md explicitly forbids ("Use
// scripted ProcessPort / fake fetch for HTTP-touching resolvers — no real network in tests").
// Two consequences, both observed:
//   • the resolver reads ?limit=1000 and allows itself 30s, while bun's test timeout is 5s, so
//     under any real substrate load the tests failed as timeouts rather than on their assertions;
//   • the pair was mutually unsatisfiable against a non-empty store — "returns rows when traces
//     exist" only checked Array.isArray (satisfied by []), while "handles missing traces"
//     demanded rows.toEqual([]) from the SAME argument-less call. They both passed only while
//     the store happened to be empty, i.e. they asserted a property of live data, not of code.
// Stubbing fetch lets each branch be pinned deterministically, including the degrade paths that
// were previously unreachable from a test.

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const stub = (impl: () => Promise<Response> | Response): void => {
  globalThis.fetch = (async () => impl()) as unknown as typeof fetch;
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("resolveError", () => {
  test("aggregates failure modes into rows, most frequent first", async () => {
    stub(() => jsonResponse({
      executions: [
        { execution_id: "e1", failure_mode: { type: "timeout" } },
        { execution_id: "e2", failure_mode: { type: "anchor_not_found" } },
        { execution_id: "e3", failure_mode: { type: "timeout" } },
        { execution_id: "e4" }, // no failure_mode — must be ignored, not counted as a mode
      ],
    }));
    const res = await resolveError({ type: "error" });
    expect(res.shape).toBe("error");
    const rows = (res.body as { rows: Array<{ failure_mode: { type: string }; count: number; example_execution_id?: string }> }).rows;
    expect(rows.map((r) => [r.failure_mode.type, r.count])).toEqual([["timeout", 2], ["anchor_not_found", 1]]);
    // the example points at the FIRST execution seen for that mode
    expect(rows[0]?.example_execution_id).toBe("e1");
  });

  test("accepts the `traces` alias as well as `executions`", async () => {
    stub(() => jsonResponse({ traces: [{ execution_id: "t1", failure_mode: { type: "parse_failed" } }] }));
    const res = await resolveError({ type: "error" });
    const rows = (res.body as { rows: Array<{ count: number }> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(1);
  });

  test("an empty store yields no rows and is NOT reported as degraded", async () => {
    stub(() => jsonResponse({ executions: [] }));
    const res = await resolveError({ type: "error" });
    const body = res.body as { rows: unknown[]; degraded?: boolean };
    expect(body.rows).toEqual([]);
    // the distinction the resolver exists to preserve: "nothing recorded" is not "I broke"
    expect(body.degraded).toBeUndefined();
  });

  test("DEGRADES rather than throwing when the trace store is unreachable", async () => {
    stub(() => { throw new Error("ECONNREFUSED"); });
    const res = await resolveError({ type: "error" });
    const body = res.body as { rows: unknown[]; degraded?: boolean; reason?: string };
    expect(res.shape).toBe("error");
    expect(body.rows).toEqual([]);
    expect(body.degraded).toBe(true);
    expect(body.reason).toContain("unreachable");
  });

  test("DEGRADES on a non-ok response, naming the status", async () => {
    stub(() => new Response("nope", { status: 503 }));
    const res = await resolveError({ type: "error" });
    const body = res.body as { rows: unknown[]; degraded?: boolean; reason?: string };
    expect(body.rows).toEqual([]);
    expect(body.degraded).toBe(true);
    expect(body.reason).toContain("503");
  });
});
