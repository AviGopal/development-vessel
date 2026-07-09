import { describe, it, expect, afterEach } from "bun:test";
import { resolveTraceStoreHealthObserver } from "../../src/resolvers/trace-store-health-observer.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(opts: {
  metricsStatus?: number;
  traceStore?: unknown;
  emitStatus?: number;
  captureEmit?: (url: string, init: RequestInit) => void;
}) {
  const { metricsStatus = 200, traceStore, emitStatus = 200, captureEmit } = opts;
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/metrics/db")) {
      if (metricsStatus !== 200) return new Response("error", { status: metricsStatus });
      const body: Record<string, unknown> = {};
      if (traceStore !== undefined) body["traceStore"] = traceStore;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (u.includes("/v2/impulses/resolve")) {
      captureEmit?.(u, init as RequestInit);
      return new Response("{}", { status: emitStatus });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("trace_store_health_observer", () => {
  it("reports counters_available:false when /metrics/db is unreachable", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const result = await resolveTraceStoreHealthObserver({ type: "trace_store_health_observer" });
    const body = result.body as { available: boolean; counters_available: boolean };
    expect(body.available).toBe(false);
    expect(body.counters_available).toBe(false);
  });

  it("reports counters_available:false (but available:true) when the traceStore block is absent", async () => {
    globalThis.fetch = mockFetch({ traceStore: undefined });
    const result = await resolveTraceStoreHealthObserver({ type: "trace_store_health_observer" });
    const body = result.body as { available: boolean; counters_available: boolean; gap_emitted?: boolean };
    expect(body.available).toBe(true);
    expect(body.counters_available).toBe(false);
    expect(body.gap_emitted).toBeUndefined();
  });

  it("does NOT emit a gap when row_count is under cap", async () => {
    let emitCalled = false;
    globalThis.fetch = mockFetch({
      traceStore: { row_count: 100, cap: 50_000 },
      captureEmit: () => { emitCalled = true; },
    });
    const result = await resolveTraceStoreHealthObserver({ type: "trace_store_health_observer" });
    const body = result.body as { over_cap: boolean; gap_emitted: boolean; row_count: number; cap: number };
    expect(body.over_cap).toBe(false);
    expect(body.gap_emitted).toBe(false);
    expect(body.row_count).toBe(100);
    expect(body.cap).toBe(50_000);
    expect(emitCalled).toBe(false);
  });

  it("emits a substrateGap_write with category trace_store_reconciliation when over cap", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = mockFetch({
      traceStore: { row_count: 60_000, cap: 50_000 },
      captureEmit: (_url, init) => {
        capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      },
    });
    const result = await resolveTraceStoreHealthObserver({ type: "trace_store_health_observer" });
    const body = result.body as { over_cap: boolean; gap_emitted: boolean };
    expect(body.over_cap).toBe(true);
    expect(body.gap_emitted).toBe(true);
    expect(capturedBody).not.toBeNull();
    const gap = (capturedBody as unknown as { impulse: { pointer: { gap: Record<string, unknown> } } }).impulse.pointer.gap;
    expect(gap["category"]).toBe("trace_store_reconciliation");
    expect(String(gap["id"])).toMatch(/^trace-store-reconcile-\d{4}-\d{2}-\d{2}T\d{2}$/);
  });

  it("dry_run:true never emits even when over cap", async () => {
    let emitCalled = false;
    globalThis.fetch = mockFetch({
      traceStore: { row_count: 60_000, cap: 50_000 },
      captureEmit: () => { emitCalled = true; },
    });
    const result = await resolveTraceStoreHealthObserver({ type: "trace_store_health_observer", dry_run: true });
    const body = result.body as { over_cap: boolean; gap_emitted: boolean };
    expect(body.over_cap).toBe(true);
    expect(body.gap_emitted).toBe(false);
    expect(emitCalled).toBe(false);
  });
});
