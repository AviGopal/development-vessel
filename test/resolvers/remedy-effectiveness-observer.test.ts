import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveRemedyEffectivenessObserver } from "../../src/resolvers/remedy-effectiveness-observer.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function writeDrain(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "remedy-obs-"));
  const path = join(dir, "drain-log.jsonl");
  const now = Date.now();
  const body = lines
    .map((l, i) => JSON.stringify({ recorded_at: new Date(now - i * 1000).toISOString(), ...l }))
    .join("\n");
  writeFileSync(path, body + "\n", "utf8");
  return path;
}

// fetch mock: captures the emit body; optionally serves /metrics/db.
function mockFetch(opts: {
  emitStatus?: number;
  traceStore?: unknown;
  metricsStatus?: number;
  captureEmit?: (url: string, init: RequestInit) => void;
}) {
  const { emitStatus = 200, traceStore, metricsStatus = 200, captureEmit } = opts;
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/metrics/db")) {
      if (metricsStatus !== 200) return new Response("error", { status: metricsStatus });
      const b: Record<string, unknown> = {};
      if (traceStore !== undefined) b["traceStore"] = traceStore;
      return new Response(JSON.stringify(b), { status: 200 });
    }
    if (u.includes("/v2/impulses/resolve")) {
      captureEmit?.(u, init as RequestInit);
      return new Response("{}", { status: emitStatus });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("remedy_effectiveness_observer", () => {
  it("reports available:false when the drain log is missing", async () => {
    globalThis.fetch = mockFetch({});
    const result = await resolveRemedyEffectivenessObserver({
      type: "remedy_effectiveness_observer",
      drain_log_path: join(tmpdir(), "does-not-exist-" + Math.random() + ".jsonl"),
    });
    const body = result.body as { available: boolean };
    expect(body.available).toBe(false);
  });

  it("does NOT flag a gap dispatched fewer than min_dispatches times", async () => {
    let emitCalled = false;
    globalThis.fetch = mockFetch({ captureEmit: () => { emitCalled = true; } });
    const path = writeDrain([
      { action: "dispatched", gap_id: "g1", category: "systematic_failure", impulse_type: "foo_write", ok: false, http_status: 400 },
      { action: "dispatched", gap_id: "g1", category: "systematic_failure", impulse_type: "foo_write", ok: false, http_status: 400 },
    ]);
    const result = await resolveRemedyEffectivenessObserver({
      type: "remedy_effectiveness_observer",
      drain_log_path: path,
    });
    const body = result.body as { available: boolean; livelock_count: number };
    expect(body.available).toBe(true);
    expect(body.livelock_count).toBe(0);
    expect(emitCalled).toBe(false);
  });

  it("emits a remedy_livelock substrateGap when a generic gap is re-dispatched min_dispatches+ times", async () => {
    let captured: Record<string, unknown> | null = null;
    globalThis.fetch = mockFetch({
      captureEmit: (_u, init) => { captured = JSON.parse(String(init.body)) as Record<string, unknown>; },
    });
    const path = writeDrain([
      { action: "dispatched", gap_id: "g-loop", category: "systematic_failure", impulse_type: "foo_write", ok: false, http_status: 400 },
      { action: "dispatched", gap_id: "g-loop", category: "systematic_failure", impulse_type: "foo_write", ok: false, http_status: 400 },
      { action: "dispatched", gap_id: "g-loop", category: "systematic_failure", impulse_type: "foo_write", ok: false, http_status: 400 },
    ]);
    const result = await resolveRemedyEffectivenessObserver({
      type: "remedy_effectiveness_observer",
      drain_log_path: path,
    });
    const body = result.body as { livelock_count: number; livelocks: Array<{ gap_emitted: boolean; dispatch_count: number }> };
    expect(body.livelock_count).toBe(1);
    expect(body.livelocks[0]!.dispatch_count).toBe(3);
    expect(body.livelocks[0]!.gap_emitted).toBe(true);
    expect(captured).not.toBeNull();
    const gap = (captured as unknown as { impulse: { pointer: { gap: Record<string, unknown> } } }).impulse.pointer.gap;
    expect(gap["category"]).toBe("remedy_livelock");
    expect(gap["route"]).toBe("dispatchable");
    expect(String(gap["id"])).toMatch(/^remedy-livelock-g-loop-\d{4}-\d{2}-\d{2}$/);
  });

  it("dry_run:true never emits even with a livelock", async () => {
    let emitCalled = false;
    globalThis.fetch = mockFetch({ captureEmit: () => { emitCalled = true; } });
    const path = writeDrain([
      { action: "dispatched", gap_id: "g2", category: "systematic_failure", impulse_type: "bar_write", ok: false, http_status: 500 },
      { action: "dispatched", gap_id: "g2", category: "systematic_failure", impulse_type: "bar_write", ok: false, http_status: 500 },
      { action: "dispatched", gap_id: "g2", category: "systematic_failure", impulse_type: "bar_write", ok: false, http_status: 500 },
    ]);
    const result = await resolveRemedyEffectivenessObserver({
      type: "remedy_effectiveness_observer",
      drain_log_path: path,
      dry_run: true,
    });
    const body = result.body as { livelock_count: number; livelocks: Array<{ gap_emitted: boolean }> };
    expect(body.livelock_count).toBe(1);
    expect(body.livelocks[0]!.gap_emitted).toBe(false);
    expect(emitCalled).toBe(false);
  });

  it("skips a trace_store_reconciliation gap whose target metric provably moved (row_count under cap)", async () => {
    let emitCalled = false;
    globalThis.fetch = mockFetch({
      traceStore: { row_count: 100, cap: 50_000 },
      captureEmit: () => { emitCalled = true; },
    });
    const path = writeDrain([
      { action: "dispatched", gap_id: "tsr", category: "trace_store_reconciliation", remedy: "development-vessel:trace-store-reconcile", ok: true, http_status: 202 },
      { action: "dispatched", gap_id: "tsr", category: "trace_store_reconciliation", remedy: "development-vessel:trace-store-reconcile", ok: true, http_status: 202 },
      { action: "dispatched", gap_id: "tsr", category: "trace_store_reconciliation", remedy: "development-vessel:trace-store-reconcile", ok: true, http_status: 202 },
    ]);
    const result = await resolveRemedyEffectivenessObserver({
      type: "remedy_effectiveness_observer",
      drain_log_path: path,
    });
    const body = result.body as { livelock_count: number };
    expect(body.livelock_count).toBe(0);
    expect(emitCalled).toBe(false);
  });

  it("flags a trace_store_reconciliation livelock even when every dispatch ACK'd green (202) but row_count stayed over cap", async () => {
    let captured: Record<string, unknown> | null = null;
    globalThis.fetch = mockFetch({
      traceStore: { row_count: 60_000, cap: 50_000 },
      captureEmit: (_u, init) => { captured = JSON.parse(String(init.body)) as Record<string, unknown>; },
    });
    const path = writeDrain([
      { action: "dispatched", gap_id: "tsr2", category: "trace_store_reconciliation", remedy: "development-vessel:trace-store-reconcile", ok: true, http_status: 202 },
      { action: "dispatched", gap_id: "tsr2", category: "trace_store_reconciliation", remedy: "development-vessel:trace-store-reconcile", ok: true, http_status: 202 },
      { action: "dispatched", gap_id: "tsr2", category: "trace_store_reconciliation", remedy: "development-vessel:trace-store-reconcile", ok: true, http_status: 202 },
    ]);
    const result = await resolveRemedyEffectivenessObserver({
      type: "remedy_effectiveness_observer",
      drain_log_path: path,
    });
    const body = result.body as { livelock_count: number; livelocks: Array<{ metric_moved: boolean | null; abort_count: number }> };
    expect(body.livelock_count).toBe(1);
    expect(body.livelocks[0]!.metric_moved).toBe(false);
    expect(body.livelocks[0]!.abort_count).toBe(0);
    expect(captured).not.toBeNull();
    const gap = (captured as unknown as { impulse: { pointer: { gap: Record<string, unknown> } } }).impulse.pointer.gap;
    expect(gap["category"]).toBe("remedy_livelock");
  });
});
