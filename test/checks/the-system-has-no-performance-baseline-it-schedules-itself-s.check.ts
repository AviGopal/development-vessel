import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test";
import * as mod from "../../src/resolvers/cyclic-flow-scan";
import type { CyclicFlowScanPointer } from "../../../src/resolvers/cyclic-flow-scan.js";

describe("resolveCyclicFlowScan: performance baseline observability", () => {
  const originalFetch = global.fetch;
  let fetchCalls: { url: string; options?: RequestInit }[] = [];

  beforeEach(() => {
    fetchCalls = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    mock.restore();
  });

  const setupMockFetch = (traces: any[]) => {
    global.fetch = mock(async (url: RequestInfo | URL, options?: RequestInit) => {
      const urlStr = url.toString();
      fetchCalls.push({ url: urlStr, options });

      if (urlStr.includes("/v2/activities/execution-traces")) {
        return new Response(JSON.stringify({ executions: traces }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      if (urlStr.includes("/v2/impulses/resolve")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    });
  };

  test("failing: a successful no-op trace should be counted as zero_work and emit a gap", async () => {
    const successfulNoOpTrace = {
      id: "trace-1",
      activity_id: "activity:test-template-v1",
      status: "completed",
      output_impulse_shapes: [],
      executed_at: new Date().toISOString(),
      metadata: null, // This trace looks successful, but did no useful work. This is the blind spot.
    };
    setupMockFetch([successfulNoOpTrace]);

    const pointer: CyclicFlowScanPointer = {
      type: "cyclic_flow_scan",
      metabobEndpoint: "http://mock-metabob",
      devVesselImpulsesUrl: "http://mock-dev-vessel/v2/impulses/resolve",
      min_dispatches: 1,
      cyclic_threshold: 0.5,
    };

    await mod.resolveCyclicFlowScan(pointer);

    const emitCall = fetchCalls.find(call => call.url === "http://mock-dev-vessel/v2/impulses/resolve");
    
    // The defect: `isZeroWork` incorrectly classifies this trace as productive.
    // As a result, `zero_work` is 0, `cyclic_fraction` is 0, and no gap is emitted.
    // The fix will make `isZeroWork` recognize this pattern as zero-work.
    expect(emitCall).toBeDefined();
  });
  
  test("control: a trace that explicitly failed should emit a wasted_cycle gap", async () => {
    const failedTrace = {
      id: "trace-2",
      activity_id: "activity:control-template-v1",
      status: "failed",
      output_impulse_shapes: [],
      executed_at: new Date().toISOString(),
      metadata: null,
    };
    setupMockFetch([failedTrace]);

    const pointer: CyclicFlowScanPointer = {
      type: "cyclic_flow_scan",
      metabobEndpoint: "http://mock-metabob",
      devVesselImpulsesUrl: "http://mock-dev-vessel/v2/impulses/resolve",
      min_dispatches: 1,
      cyclic_threshold: 0.5,
    };

    await mod.resolveCyclicFlowScan(pointer);

    const emitCall = fetchCalls.find(call => call.url === "http://mock-dev-vessel/v2/impulses/resolve");

    // This is correctly identified as zero-work and should continue to be.
    expect(emitCall).toBeDefined();
  });
});
