import { describe, it, expect, afterEach } from "bun:test";
import { resolveDispatchTargetDriftScan } from "../../src/resolvers/dispatch-target-drift-scan.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface Calls {
  list: number;
  emits: unknown[];
}

function makeFetch(rows: Array<Record<string, unknown>>, calls: Calls): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    if (url.includes("/execution-traces")) {
      calls.list += 1;
      return new Response(JSON.stringify({ executions: rows }), { status: 200 });
    }
    if (init && init.method === "POST") {
      const body = init.body ? JSON.parse(init.body as string) : {};
      calls.emits.push(body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("dispatch_target_drift_scan", () => {
  it("emits instrumentation gap when no trace records the field (top OR metadata)", async () => {
    const calls: Calls = { list: 0, emits: [] };
    globalThis.fetch = makeFetch(
      [
        { execution_id: "exec_a", activity_id: "act:1", metadata: { other: "x" } },
        { execution_id: "exec_b", variant_id: "act:2" },
      ],
      calls,
    );
    const result: any = await resolveDispatchTargetDriftScan({
      type: "dispatch_target_drift_scan",
      tracesUrl: "http://x/v2/activities/execution-traces",
      devVesselImpulsesUrl: "http://x/v2/impulses/resolve",
      dry_run: false,
    } as any);
    expect(result.shape).toBe("dispatchTargetDriftReport");
    expect(result.body.target_field_detected).toBeNull();
    expect(result.body.instrumentation_gap_posted).toBe(true);
    expect(calls.emits.length).toBe(1);
  });

  it("detects metadata.dispatch_target_template_id and emits a drift when target != selected", async () => {
    const calls: Calls = { list: 0, emits: [] };
    globalThis.fetch = makeFetch(
      [
        // Drift: requested X via metadata, selected Y
        {
          execution_id: "exec_drift",
          activity_id: "activity:Y",
          metadata: { dispatch_target_template_id: "activity:X" },
        },
        // No drift: requested = selected
        {
          execution_id: "exec_ok",
          activity_id: "activity:Z",
          metadata: { dispatch_target_template_id: "activity:Z" },
        },
      ],
      calls,
    );
    const result: any = await resolveDispatchTargetDriftScan({
      type: "dispatch_target_drift_scan",
      tracesUrl: "http://x/v2/activities/execution-traces",
      devVesselImpulsesUrl: "http://x/v2/impulses/resolve",
      dry_run: false,
    } as any);
    expect(result.shape).toBe("dispatchTargetDriftReport");
    expect(result.body.target_field_detected).toBe("dispatch_target_template_id");
    expect(result.body.drifts_detected).toBe(1);
    expect(result.body.drifts_posted).toBe(1);
    expect(calls.emits.length).toBe(1);
    const emitted: any = calls.emits[0];
    expect(emitted.impulse.pointer.gap.classification_metadata.requested_template_id).toBe("activity:X");
    expect(emitted.impulse.pointer.gap.classification_metadata.selected_template_id).toBe("activity:Y");
  });

  it("also reads top-level field placement (forward-compat with schema promotion)", async () => {
    const calls: Calls = { list: 0, emits: [] };
    globalThis.fetch = makeFetch(
      [
        {
          execution_id: "exec_top",
          activity_id: "activity:selected",
          dispatch_target_template_id: "activity:requested",
        },
      ],
      calls,
    );
    const result: any = await resolveDispatchTargetDriftScan({
      type: "dispatch_target_drift_scan",
      tracesUrl: "http://x/v2/activities/execution-traces",
      devVesselImpulsesUrl: "http://x/v2/impulses/resolve",
      dry_run: true,
    } as any);
    expect(result.body.target_field_detected).toBe("dispatch_target_template_id");
    expect(result.body.drifts_detected).toBe(1);
  });
});
