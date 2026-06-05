import { describe, it, expect, afterEach } from "bun:test";
import { resolveCapabilityGapAudit } from "../../src/resolvers/capability-gap-audit.js";

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

describe("capability_gap_audit", () => {
  it("aggregates 'unknown shape' failures into a single gap and emits substrateGap", async () => {
    const executions = [
      {
        id: "tr1",
        status: "failure",
        executed_at: new Date().toISOString(),
        tasks: [{ task_id: "t0", success: false, error: 'unknown shape: "git_status_with_dirty_files"' }],
      },
      {
        id: "tr2",
        status: "failure",
        executed_at: new Date().toISOString(),
        tasks: [{ task_id: "t0", success: false, error: 'unknown shape: git_status_with_dirty_files' }],
      },
    ];
    const emitCalls: any[] = [];
    mockRouter([
      (url) => url.includes("/v2/activities/execution-traces") ? new Response(JSON.stringify({ executions }), { status: 200 }) : null,
      (url) => url.includes("/shapes") ? new Response(JSON.stringify({ shapes: ["git_status", "git_diff"] }), { status: 200 }) : null,
      (url, init) => url.endsWith("/v2/impulses/resolve")
        ? (emitCalls.push(JSON.parse(init?.body as string)), new Response("{}", { status: 200 })) : null,
    ]);
    const r = await resolveCapabilityGapAudit({ type: "capability_gap_audit" });
    const body = r.body as any;
    expect(r.shape).toBe("capabilityGapReport");
    expect(body.gaps.length).toBe(1);
    expect(body.gaps[0].wanted_capability).toBe("git_status_with_dirty_files");
    expect(body.gaps[0].occurrence_count).toBe(2);
    expect(body.gaps[0].closest_existing_resolver).toBe("git_status");
    expect(body.gaps_emitted).toBe(1);
    expect(emitCalls[0].impulse.pointer.gap.category).toBe("missing_capability");
  });

  it("detects 'no resolver for type' pattern via failure_mode.reason", async () => {
    const executions = [
      {
        id: "tr3",
        status: "failure",
        executed_at: new Date().toISOString(),
        failure_mode: { type: "verifier_negative", reason: 'no resolver for type "discover_unused_concepts"' },
        tasks: [{ task_id: "t0", success: false }],
      },
    ];
    mockRouter([
      (url) => url.includes("/v2/activities/execution-traces") ? new Response(JSON.stringify({ executions }), { status: 200 }) : null,
      (url) => url.includes("/shapes") ? new Response(JSON.stringify({ shapes: [] }), { status: 200 }) : null,
      (url) => url.endsWith("/v2/impulses/resolve") ? new Response("{}", { status: 200 }) : null,
    ]);
    const r = await resolveCapabilityGapAudit({ type: "capability_gap_audit", emit_gap: false });
    const body = r.body as any;
    expect(body.gaps.length).toBe(1);
    expect(body.gaps[0].wanted_capability).toBe("discover_unused_concepts");
    expect(body.gaps[0].proposed_resolver_name).toBe("discover_unused_concepts");
  });

  it("returns empty gaps when no failures match capability patterns", async () => {
    const executions = [
      { id: "tr4", status: "failure", executed_at: new Date().toISOString(), tasks: [{ task_id: "t0", success: false, error: "timeout" }] },
      { id: "tr5", status: "success", executed_at: new Date().toISOString(), tasks: [{ task_id: "t0", success: true }] },
    ];
    mockRouter([
      (url) => url.includes("/v2/activities/execution-traces") ? new Response(JSON.stringify({ executions }), { status: 200 }) : null,
      (url) => url.includes("/shapes") ? new Response(JSON.stringify({ shapes: [] }), { status: 200 }) : null,
    ]);
    const r = await resolveCapabilityGapAudit({ type: "capability_gap_audit" });
    const body = r.body as any;
    expect(body.gaps.length).toBe(0);
    expect(body.failures_examined).toBe(1);
    expect(body.gaps_emitted).toBe(0);
  });

  it("respects window_hours filter (drops traces older than cutoff)", async () => {
    const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const recent = new Date().toISOString();
    const executions = [
      { id: "old1", status: "failure", executed_at: old, tasks: [{ task_id: "t0", success: false, error: 'unknown shape: legacy_thing' }] },
      { id: "new1", status: "failure", executed_at: recent, tasks: [{ task_id: "t0", success: false, error: 'unknown shape: fresh_thing' }] },
    ];
    mockRouter([
      (url) => url.includes("/v2/activities/execution-traces") ? new Response(JSON.stringify({ executions }), { status: 200 }) : null,
      (url) => url.includes("/shapes") ? new Response(JSON.stringify({ shapes: [] }), { status: 200 }) : null,
      (url) => url.endsWith("/v2/impulses/resolve") ? new Response("{}", { status: 200 }) : null,
    ]);
    const r = await resolveCapabilityGapAudit({ type: "capability_gap_audit", window_hours: 24, emit_gap: false });
    const body = r.body as any;
    expect(body.gaps.length).toBe(1);
    expect(body.gaps[0].wanted_capability).toBe("fresh_thing");
  });
});
