import { describe, it, expect, afterEach } from "bun:test";
import { resolveChainFetchFailureScan } from "../../src/resolvers/chain-fetch-failure-scan";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockEmit(sink: unknown[]) {
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    sink.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("chain_fetch_failure_scan", () => {
  it("emits an aggregated gap when degenerate concepts cross the threshold", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveChainFetchFailureScan({
      type: "chain_fetch_failure_scan",
      threshold: 2,
      _concepts: [
        { id: "concept_a", shape: "resolverOrphanRecord", content: "I cannot access the data: the endpoint returned a 401 authentication error." },
        { id: "concept_b", shape: "resolverOrphanRecord", content: "Please provide the list of resolver shapes and I will analyze it." },
        { id: "concept_c", shape: "goodConcept", content: "Orphaned shapes: vesselArrivalReport (0 invocations). Recorded." },
      ],
    });
    expect(res.shape).toBe("chainFetchFailureReport");
    const body = res.body as { degenerate_count: number; triggered: boolean };
    expect(body.degenerate_count).toBe(2);
    expect(body.triggered).toBe(true);
    expect(emits.length).toBe(1);
    const gap = (emits[0] as { impulse: { pointer: { gap: { id: string; classification_metadata: { gap_subtype: string; degenerate_count: number } } } } }).impulse.pointer;
    expect(gap.gap.classification_metadata.gap_subtype).toBe("chain_fetch_failure_degenerate_output");
    expect(gap.gap.classification_metadata.degenerate_count).toBe(2);
    // idempotent rolling id
    expect(gap.gap.id).toBe("chain-fetch-failure-degenerate-mints");
  });

  it("does NOT emit below threshold (one odd concept)", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveChainFetchFailureScan({
      type: "chain_fetch_failure_scan",
      threshold: 2,
      _concepts: [
        { id: "concept_a", shape: "x", content: "the endpoint returned a 401" },
        { id: "concept_b", shape: "x", content: "a perfectly normal substrate concept about orthogonality" },
      ],
    });
    const body = res.body as { degenerate_count: number; triggered: boolean };
    expect(body.degenerate_count).toBe(1);
    expect(body.triggered).toBe(false);
    expect(emits.length).toBe(0);
  });

  it("does NOT flag healthy concepts", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveChainFetchFailureScan({
      type: "chain_fetch_failure_scan",
      threshold: 1,
      _concepts: [
        { id: "c1", shape: "x", content: "Orphaned resolver shapes detected: foo, bar. Recorded as known catalogue cost." },
        { id: "c2", shape: "y", content: "A concept describing the dual-arm invariant manifold." },
      ],
    });
    expect((res.body as { degenerate_count: number }).degenerate_count).toBe(0);
    expect(emits.length).toBe(0);
  });

  it("dry_run reports without emitting", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveChainFetchFailureScan({
      type: "chain_fetch_failure_scan",
      dry_run: true,
      threshold: 1,
      _concepts: [{ id: "c1", shape: "x", content: "Invalid JSON body returned, cannot access data" }],
    });
    const body = res.body as { degenerate_count: number; triggered: boolean; dry_run: boolean };
    expect(body.degenerate_count).toBe(1);
    expect(body.triggered).toBe(true);
    expect(body.dry_run).toBe(true);
    expect(emits.length).toBe(0);
  });
});
