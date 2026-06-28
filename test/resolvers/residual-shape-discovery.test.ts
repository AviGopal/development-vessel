import { describe, it, expect, afterEach } from "bun:test";
import { resolveResidualShapeDiscovery } from "../../src/resolvers/residual-shape-discovery.js";

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

interface FakeRow {
  output_impulse_shapes?: string[];
  input_impulse_shapes?: string[];
  activity_id?: string;
  executed_at?: string;
}

function wire(opts: { rows: FakeRow[]; namedShapes: string[]; onEmit: (b: any) => void }) {
  mockRouter([
    (url) => url.endsWith("/sql")
      ? new Response(JSON.stringify([{ status: "OK", result: opts.rows }]), { status: 200 })
      : null,
    (url) => url.includes("/registry/shapes")
      ? new Response(JSON.stringify({ shapes: opts.namedShapes }), { status: 200 })
      : null,
    (url, init) => url.endsWith("/v2/impulses/resolve")
      ? (opts.onEmit(JSON.parse(init?.body as string)), new Response("{}", { status: 200 }))
      : null,
  ]);
}

// A persistent carrier-cluster: {directoryListing, fileContent, json_extracted_value}
// recurs in 12 traces across 4 distinct hour-windows, produced by activity:probe,
// and one of its named shapes (problem_detection) is consumed downstream.
function persistentRows(): FakeRow[] {
  const rows: FakeRow[] = [];
  for (let i = 0; i < 12; i++) {
    const hour = String(i % 4).padStart(2, "0");
    rows.push({
      output_impulse_shapes: ["directoryListing", "fileContent", "json_extracted_value"],
      input_impulse_shapes: [],
      activity_id: "activity:probe-reachable",
      executed_at: `2026-06-27T${hour}:30:00.000Z`,
    });
  }
  // downstream consumer of one cluster shape (not strictly needed for these
  // shapes, but proves the consumer path doesn't error)
  rows.push({
    output_impulse_shapes: ["concept"],
    input_impulse_shapes: ["fileContent"],
    activity_id: "activity:consume",
    executed_at: "2026-06-27T05:00:00.000Z",
  });
  return rows;
}

describe("residual_shape_discovery", () => {
  it("proposes an unnamed axis for a persistent carrier-cluster (propose-only)", async () => {
    const emits: any[] = [];
    wire({ rows: persistentRows(), namedShapes: ["fileContent", "concept"], onEmit: (b) => emits.push(b) });
    const r = await resolveResidualShapeDiscovery({ type: "residual_shape_discovery", min_windows: 3, min_traces: 10 });
    const body = r.body as any;
    expect(r.shape).toBe("residualShapeDiscoveryReport");
    expect(body.propose_only).toBe(true);
    expect(body.proposals_passing_gates).toBeGreaterThanOrEqual(1);
    const p = body.proposals[0];
    expect(p.cluster_shapes).toContain("json_extracted_value");
    expect(p.generic_carriers.length).toBeGreaterThan(0);
    expect(p.candidate_producer).toBe("activity:probe-reachable");
    expect(p.persistence.windows).toBeGreaterThanOrEqual(3);
    expect(p.persistence.traces).toBeGreaterThanOrEqual(10);
    // It emitted as a propose-only substrateGap (residual_shape_proposal), not a mint.
    expect(emits.length).toBeGreaterThanOrEqual(1);
    expect(emits[0].impulse.pointer.type).toBe("substrateGap_write");
    expect(emits[0].impulse.pointer.gap.category).toBe("residual_shape_proposal");
    expect(emits[0].impulse.pointer.gap.classification_metadata.propose_only).toBe(true);
  });

  it("REJECTS a one-off / single-window cluster on the persistence gate (gate bites)", async () => {
    const emits: any[] = [];
    // Same cluster but only 4 traces, all in ONE hour-window → jitter.
    const rows: FakeRow[] = [];
    for (let i = 0; i < 4; i++) {
      rows.push({
        output_impulse_shapes: ["directoryListing", "fileContent", "json_extracted_value"],
        activity_id: "activity:probe",
        executed_at: "2026-06-27T09:30:00.000Z",
      });
    }
    wire({ rows, namedShapes: [], onEmit: (b) => emits.push(b) });
    const r = await resolveResidualShapeDiscovery({ type: "residual_shape_discovery", min_windows: 3, min_traces: 10 });
    const body = r.body as any;
    expect(body.proposals_passing_gates).toBe(0);
    expect(body.proposals_rejected).toBeGreaterThanOrEqual(1);
    expect(body.rejected_examples.some((e: any) => e.failed_gate === "persistence")).toBe(true);
    expect(emits.length).toBe(0); // nothing emitted, nothing minted
  });

  it("excludes the pure-internal goal-host scaffold cluster", async () => {
    const emits: any[] = [];
    const rows: FakeRow[] = [];
    for (let i = 0; i < 20; i++) {
      const hour = String(i % 5).padStart(2, "0");
      rows.push({
        output_impulse_shapes: ["goal", "pool_precheck_result", "select_or_produce_result", "shape_gap_resolution"],
        activity_id: "activity:goal-host",
        executed_at: `2026-06-27T${hour}:00:00.000Z`,
      });
    }
    wire({ rows, namedShapes: [], onEmit: (b) => emits.push(b) });
    const r = await resolveResidualShapeDiscovery({ type: "residual_shape_discovery" });
    const body = r.body as any;
    // scaffold-only cluster has no generic carrier AND is all-scaffold → no candidate
    expect(body.proposals_passing_gates).toBe(0);
  });

  it("degrades gracefully when SurrealDB is unreachable", async () => {
    mockRouter([(url) => url.endsWith("/sql") ? new Response("err", { status: 500 }) : null]);
    const r = await resolveResidualShapeDiscovery({ type: "residual_shape_discovery" });
    expect((r.body as any).degraded).toBe(true);
  });
});
