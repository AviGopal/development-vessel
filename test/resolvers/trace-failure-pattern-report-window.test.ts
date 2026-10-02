import { describe, it, expect, afterEach } from "bun:test";
import { resolveTraceFailurePatternReport } from "../../src/resolvers/trace-failure-pattern-report.js";

/**
 * CHECK-FIRST (slice Y, step Y2b): the class2 check the signature gaps already carry must
 * MEASURE A WINDOW, not the latest N list rows.
 *
 * Live gaps `seven-more-resolve-url-sites-still-concatenate-an-absolute-endpoint` and
 * `resolve-url-walk-path-sites-7457-15128` carry
 *   evidence_resolve {shape:"trace_failure_pattern_report", input:{reason_contains:"URL is invalid", limit:100}, zero_field:"matching_failures"}
 * Today `matching_failures` counts matches among the latest `limit` rows of the trace list
 * (~minutes of traffic at ~9,000 rows/day), so its zero is near-vacuous and it reports no
 * `measured` flag. With `window_hours`, the count comes from the server-side windowed
 * aggregate (activity-api traceAggregateReport, step Y1-read-b), and a failed read is
 * measured:false — the sweep reads that as 'unknown', never 'absent'.
 *
 * `excess_failures` is the verdict-class gaps' zero_field: max(0, matched - max_count).
 */

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

type Seen = { url: string; body: any };

function stubAggregate(answer: { matched_total: number | null; measured: boolean } | "http500", seen: Seen[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({ url, body });
    if (url.includes("/v2/impulses/resolve")) {
      if (answer === "http500") return new Response("boom", { status: 500 });
      const report = { shape: "traceAggregateReport", rows: [], total_groups: 0, empty: answer.matched_total === 0, ...answer };
      return new Response(JSON.stringify({ success: true, content: JSON.stringify(report) }), { status: 200 });
    }
    // legacy list path — no rows
    return new Response(JSON.stringify({ executions: [] }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("trace_failure_pattern_report — windowed signature count", () => {
  it("with window_hours, matching_failures comes from the windowed traceAggregateReport, not the latest-N list", async () => {
    const seen: Seen[] = [];
    stubAggregate({ matched_total: 6711, measured: true }, seen);
    const r = await resolveTraceFailurePatternReport({ type: "trace_failure_pattern_report", reason_contains: "URL is invalid", window_hours: 96, until_hours_ago: 96 } as any);
    const agg = seen.find((s) => s.url.includes("/v2/impulses/resolve"));
    expect(agg).toBeDefined();
    const p = agg!.body?.impulse?.pointer ?? agg!.body?.pointer;
    expect(p.type).toBe("traceAggregateReport");
    expect(p.reason_contains).toBe("URL is invalid");
    expect(p.window_hours).toBe(96);
    expect(p.until_hours_ago).toBe(96);
    expect((r.body as any).matching_failures).toBe(6711);
    expect((r.body as any).measured).toBe(true);
  });

  it("a failed aggregate read is measured:false and matching_failures null — never a zero", async () => {
    const seen: Seen[] = [];
    stubAggregate("http500", seen);
    const r = await resolveTraceFailurePatternReport({ type: "trace_failure_pattern_report", reason_contains: "URL is invalid", window_hours: 72 } as any);
    expect((r.body as any).measured).toBe(false);
    expect((r.body as any).matching_failures).toBeNull();
  });

  it("failure_class filters by class and excess_failures = max(0, matched - max_count)", async () => {
    const seen: Seen[] = [];
    stubAggregate({ matched_total: 40, measured: true }, seen);
    const r = await resolveTraceFailurePatternReport({ type: "trace_failure_pattern_report", failure_class: "deterministic:edit-intent-no-landed-edit", window_hours: 168, max_count: 5 } as any);
    const p = seen.find((s) => s.url.includes("/v2/impulses/resolve"))!.body.impulse.pointer;
    expect(p.failure_class).toBe("deterministic:edit-intent-no-landed-edit");
    expect((r.body as any).matching_failures).toBe(40);
    expect((r.body as any).excess_failures).toBe(35);
  });

  it("excess_failures is 0 at or under max_count (the class is back under its rate)", async () => {
    const seen: Seen[] = [];
    stubAggregate({ matched_total: 5, measured: true }, seen);
    const r = await resolveTraceFailurePatternReport({ type: "trace_failure_pattern_report", failure_class: "deterministic:edit-intent-no-landed-edit", window_hours: 168, max_count: 5 } as any);
    expect((r.body as any).excess_failures).toBe(0);
  });

  it("a check-mode call never emits gaps even if emit_gap is passed (a check must not write)", async () => {
    const seen: Seen[] = [];
    stubAggregate({ matched_total: 40, measured: true }, seen);
    const r = await resolveTraceFailurePatternReport({ type: "trace_failure_pattern_report", failure_class: "deterministic:x", window_hours: 168, max_count: 5, emit_gap: true } as any);
    expect((r.body as any).gaps_emitted).toBe(0);
    expect(seen.some((s) => JSON.stringify(s.body ?? {}).includes("substrateGap_write"))).toBe(false);
  });

  it("without window_hours the legacy latest-N behaviour is unchanged (no aggregate call)", async () => {
    const seen: Seen[] = [];
    stubAggregate({ matched_total: 999, measured: true }, seen);
    const r = await resolveTraceFailurePatternReport({ type: "trace_failure_pattern_report", reason_contains: "URL is invalid", limit: 100 });
    expect(seen.some((s) => s.url.includes("/v2/impulses/resolve"))).toBe(false);
    expect((r.body as any).matching_failures).toBe(0);
  });
});
