import { describe, it, expect, afterEach } from "bun:test";
import { resolveVectorSpaceOrthogonalityAudit } from "../../src/resolvers/vector-space-orthogonality-audit.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

describe("vector_space_orthogonality_audit", () => {
  it("flags an orthogonal cluster and emits one substrateGap", async () => {
    const failureTraces = [
      { id: "t1", activity_id: "actA", status: "failure", failure_mode: { type: "novel_fm" }, executed_at: new Date().toISOString(), tasks: [] },
      { id: "t2", activity_id: "actA", status: "failure", failure_mode: { type: "novel_fm" }, executed_at: new Date().toISOString(), tasks: [] },
      { id: "t3", activity_id: "actA", status: "failure", failure_mode: { type: "novel_fm" }, executed_at: new Date().toISOString(), tasks: [] },
      { id: "ok", activity_id: "actA", status: "success", executed_at: new Date().toISOString(), tasks: [] },
    ];
    const emitCalls: any[] = [];
    mockRouter([
      (url) => url.includes("/v2/activities/execution-traces")
        ? new Response(JSON.stringify({ executions: failureTraces }), { status: 200 })
        : null,
      (url) => url.includes("/concepts/search")
        ? new Response(JSON.stringify({ concepts: [{ id: "concept_p1", name: "some_principle", _dense_score: 0.10 }] }), { status: 200 })
        : null,
      (url, init) => {
        if (url.endsWith("/v2/impulses/resolve")) {
          emitCalls.push(JSON.parse(init?.body as string));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return null;
      },
    ]);

    const r = await resolveVectorSpaceOrthogonalityAudit({
      type: "vector_space_orthogonality_audit",
      similarity_threshold: 0.45,
      min_failure_traces: 3,
    });
    expect(r.shape).toBe("vectorSpaceOrthogonalityResult");
    const body = r.body as any;
    expect(body.traces_examined).toBe(3);
    expect(body.orthogonal_traces).toBe(3);
    expect(body.clusters.length).toBe(1);
    expect(body.clusters[0].trace_count).toBe(3);
    expect(body.clusters[0].closest_principle_id).toBe("concept_p1");
    expect(body.gaps_emitted).toBe(1);
    expect(emitCalls.length).toBe(1);
    expect(emitCalls[0].impulse.pointer.type).toBe("substrateGap_write");
    expect(emitCalls[0].impulse.pointer.gap.category).toBe("novel_failure_mode_detected");
  });

  it("does not emit when nearest principle is above threshold", async () => {
    const failureTraces = Array.from({ length: 4 }, (_, i) => ({
      id: `t${i}`, activity_id: "actB", status: "failure",
      failure_mode: { type: "known_fm" }, executed_at: new Date().toISOString(), tasks: [],
    }));
    const emitCalls: any[] = [];
    mockRouter([
      (url) => url.includes("/v2/activities/execution-traces")
        ? new Response(JSON.stringify({ executions: failureTraces }), { status: 200 })
        : null,
      (url) => url.includes("/concepts/search")
        ? new Response(JSON.stringify({ concepts: [{ id: "concept_p2", name: "covering_principle", _dense_score: 0.80 }] }), { status: 200 })
        : null,
      (url, init) => {
        if (url.endsWith("/v2/impulses/resolve")) {
          emitCalls.push(JSON.parse(init?.body as string));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return null;
      },
    ]);

    const r = await resolveVectorSpaceOrthogonalityAudit({
      type: "vector_space_orthogonality_audit",
      similarity_threshold: 0.45,
      min_failure_traces: 3,
    });
    const body = r.body as any;
    expect(body.orthogonal_traces).toBe(0);
    expect(body.clusters.length).toBe(0);
    expect(body.gaps_emitted).toBe(0);
    expect(emitCalls.length).toBe(0);
  });

  it("respects emit_gap=false (dry-run mode)", async () => {
    const failureTraces = Array.from({ length: 3 }, (_, i) => ({
      id: `t${i}`, activity_id: "actC", status: "failure",
      failure_mode: { type: "novel" }, executed_at: new Date().toISOString(), tasks: [],
    }));
    const emitCalls: any[] = [];
    mockRouter([
      (url) => url.includes("/v2/activities/execution-traces")
        ? new Response(JSON.stringify({ executions: failureTraces }), { status: 200 })
        : null,
      (url) => url.includes("/concepts/search")
        ? new Response(JSON.stringify({ concepts: [{ id: "p", name: "x", _dense_score: 0.05 }] }), { status: 200 })
        : null,
      (url, init) => {
        if (url.endsWith("/v2/impulses/resolve")) {
          emitCalls.push(init);
          return new Response("{}", { status: 200 });
        }
        return null;
      },
    ]);

    const r = await resolveVectorSpaceOrthogonalityAudit({
      type: "vector_space_orthogonality_audit",
      emit_gap: false,
      min_failure_traces: 3,
    });
    const body = r.body as any;
    expect(body.clusters.length).toBe(1);
    expect(body.gaps_emitted).toBe(0);
    expect(emitCalls.length).toBe(0);
  });
});
