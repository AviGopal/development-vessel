import { describe, it, expect, afterEach } from "bun:test";
import { resolveShapeClosureDemand } from "../../src/resolvers/shape-closure-demand.js";

// HERMETIC. This called the resolver with no fetch stub, so it hit the live gap store and the
// composition graph and failed as a 5s timeout under substrate load. Its assertions were
// `typeof r.shape === "string"` and `has body`, satisfied by every possible return value — the
// ranking this resolver exists to compute was never checked at all.
//
// The ranking is the contract: priority_score = demand_count * recency * blocking, ordered
// descending, counting ONLY capability_gap-kind gaps that name a missing_shape.

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const serve = (gaps: unknown[], edges: unknown[] = []): void => {
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    if (init?.method === "POST") return json({ body: { gaps } });
    return json({ edges });
  }) as unknown as typeof fetch;
};

const recentIso = new Date().toISOString();

describe("shape_closure_demand resolver", () => {
  it("ranks capability gaps by demand, most-demanded first", async () => {
    serve([
      { id: "g1", detected_at: recentIso, classification_metadata: { kind: "capability_gap", missing_shape: "alpha" } },
      { id: "g2", detected_at: recentIso, classification_metadata: { kind: "capability_gap", missing_shape: "alpha" } },
      { id: "g3", detected_at: recentIso, classification_metadata: { kind: "capability_gap", missing_shape: "beta" } },
    ]);
    const r = await resolveShapeClosureDemand({ type: "shape_closure_demand" });
    expect(r.shape).toBe("shapeClosureDemand");
    const body = r.body as Record<string, any>;
    expect(body["ranked"].map((e: any) => e.shape)).toEqual(["alpha", "beta"]);
    expect(body["ranked"][0].demand_count).toBe(2);
    // two blocking gaps earn the 1.5x multiplier, so alpha outranks beta by more than 2:1
    expect(body["ranked"][0].priority_score).toBeGreaterThan(body["ranked"][1].priority_score * 2);
    expect(body["total_open_gaps"]).toBe(3);
  });

  it("ignores gaps that are not capability_gap kind or name no missing_shape", async () => {
    serve([
      { id: "g1", detected_at: recentIso, classification_metadata: { kind: "capability_gap", missing_shape: "alpha" } },
      { id: "g2", detected_at: recentIso, classification_metadata: { kind: "verification_integrity", missing_shape: "beta" } },
      { id: "g3", detected_at: recentIso, classification_metadata: { kind: "capability_gap" } },
    ]);
    const body = (await resolveShapeClosureDemand({ type: "shape_closure_demand" })).body as Record<string, any>;
    expect(body["ranked"].map((e: any) => e.shape)).toEqual(["alpha"]);
    // total_open_gaps counts what was FETCHED; capability_gaps_considered counts what ranked.
    // Keeping both distinct is what lets a reader see the filter did something.
    expect(body["total_open_gaps"]).toBe(3);
    expect(body["capability_gaps_considered"]).toBe(1);
  });

  it("an older gap ranks below an equally-demanded fresh one (recency decay)", async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    serve([
      { id: "g1", detected_at: recentIso, classification_metadata: { kind: "capability_gap", missing_shape: "fresh" } },
      { id: "g2", detected_at: old, classification_metadata: { kind: "capability_gap", missing_shape: "stale" } },
    ]);
    const body = (await resolveShapeClosureDemand({ type: "shape_closure_demand" })).body as Record<string, any>;
    expect(body["ranked"][0].shape).toBe("fresh");
  });

  it("fails soft to an empty ranking when both sources are unreachable", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await resolveShapeClosureDemand({ type: "shape_closure_demand" });
    expect(r.shape).toBe("shapeClosureDemand");
    const body = r.body as Record<string, any>;
    expect(body["ranked"]).toEqual([]);
    expect(body["total_open_gaps"]).toBe(0);
  });
});
