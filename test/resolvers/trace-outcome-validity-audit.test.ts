import { describe, it, expect, afterEach } from "bun:test";
import { resolveTraceOutcomeValidityAudit } from "../../src/resolvers/trace-outcome-validity-audit.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockRouter(handlers: Array<(url: string, init?: RequestInit) => Response | null>) {
  globalThis.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    for (const h of handlers) {
      const r = h(url, init);
      if (r) return r;
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("trace_outcome_validity_audit", () => {
  it("clusters structuredError-with-success and emits substrateGap", async () => {
    const now = new Date().toISOString();
    const executions = [
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `t${i}`, activity_id: "activity:⟨apply-proposal-as-patch⟩", status: "success",
        output_impulse_shapes: ["foo", "structuredError"], executed_at: now,
      })),
      { id: "tok", activity_id: "activity:⟨other⟩", status: "success", output_impulse_shapes: ["bar"], executed_at: now },
    ];
    const emitCalls: any[] = [];
    mockRouter([
      (url) => url.includes("/v2/activities/execution-traces") ? new Response(JSON.stringify({ executions }), { status: 200 }) : null,
      (url, init) => url.endsWith("/v2/impulses/resolve")
        ? (emitCalls.push(JSON.parse(init?.body as string)), new Response(JSON.stringify({ ok: true }), { status: 200 }))
        : null,
    ]);
    const r = await resolveTraceOutcomeValidityAudit({ type: "trace_outcome_validity_audit", min_inconsistencies: 3 });
    expect(r.shape).toBe("traceOutcomeValidityResult");
    const body = r.body as any;
    expect(body.traces_examined).toBe(4);
    expect(body.cluster_summaries.length).toBe(1);
    expect(body.cluster_summaries[0].signature).toBe("structuredError_recorded_as_success");
    expect(body.cluster_summaries[0].count).toBe(3);
    expect(body.gaps_emitted).toBe(1);
    expect(emitCalls.length).toBe(1);
    const gap = emitCalls[0].impulse.pointer.gap;
    expect(gap.category).toBe("trace_outcome_inconsistency");
    expect(gap.classification_metadata.signature).toBe("structuredError_recorded_as_success");
    expect(gap.classification_metadata.inconsistency_examples.length).toBe(3);
  });

  it("detects the UNDER-claim: meta-activity audited-NO recorded as FAILURE (goal-host attributed)", async () => {
    const now = new Date().toISOString();
    const executions = [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `sb${i}`, activity_id: "slot-binding", status: "failure",
        output_impulse_shapes: ["pool_precheck_result", "select_or_produce_result"], executed_at: now,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `sp${i}`, activity_id: "create-shape-provider-goal", status: "failure",
        output_impulse_shapes: ["activity_recommendations"], executed_at: now,
      })),
    ];
    const emitCalls: any[] = [];
    mockRouter([
      (url) => url.includes("/v2/activities/execution-traces") ? new Response(JSON.stringify({ executions }), { status: 200 }) : null,
      (url, init) => url.endsWith("/v2/impulses/resolve")
        ? (emitCalls.push(JSON.parse(init?.body as string)), new Response(JSON.stringify({ ok: true }), { status: 200 })) : null,
    ]);
    const r = await resolveTraceOutcomeValidityAudit({ type: "trace_outcome_validity_audit", min_inconsistencies: 3 });
    const body = r.body as any;
    const sigs = body.cluster_summaries.map((c: any) => c.signature).sort();
    expect(sigs).toEqual(["shapeProviderGoal_no_op_recorded_as_failure", "slotBinding_no_op_recorded_as_failure"]);
    expect(body.gaps_emitted).toBe(2);
    const gap = emitCalls.find((c) => c.impulse.pointer.gap.classification_metadata.signature === "slotBinding_no_op_recorded_as_failure").impulse.pointer.gap;
    expect(gap.classification_metadata.vessel_name).toBe("goal-host-vessel");
    expect(gap.classification_metadata.cited_evidence[0]).toContain("goal-host-vessel");
  });

  it("does not emit when below min_inconsistencies", async () => {
    const now = new Date().toISOString();
    const executions = [
      { id: "t0", activity_id: "actA", status: "success", output_impulse_shapes: ["structuredError"], executed_at: now },
      { id: "t1", activity_id: "actA", status: "success", output_impulse_shapes: ["structuredError"], executed_at: now },
    ];
    const emitCalls: any[] = [];
    mockRouter([
      (url) => url.includes("/v2/activities/execution-traces") ? new Response(JSON.stringify({ executions }), { status: 200 }) : null,
      (url, init) => url.endsWith("/v2/impulses/resolve")
        ? (emitCalls.push(JSON.parse(init?.body as string)), new Response("{}", { status: 200 })) : null,
    ]);
    const r = await resolveTraceOutcomeValidityAudit({ type: "trace_outcome_validity_audit", min_inconsistencies: 3 });
    const body = r.body as any;
    expect(body.cluster_summaries[0].count).toBe(2);
    expect(body.gaps_emitted).toBe(0);
    expect(emitCalls.length).toBe(0);
  });

  it("ignores traces with non-matching status (e.g. failure)", async () => {
    const now = new Date().toISOString();
    const executions = Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`, activity_id: "actA", status: "failure",
      output_impulse_shapes: ["structuredError"], executed_at: now,
    }));
    mockRouter([
      (url) => url.includes("/v2/activities/execution-traces") ? new Response(JSON.stringify({ executions }), { status: 200 }) : null,
    ]);
    const r = await resolveTraceOutcomeValidityAudit({ type: "trace_outcome_validity_audit", min_inconsistencies: 3 });
    const body = r.body as any;
    expect(body.cluster_summaries.length).toBe(0);
  });
});
