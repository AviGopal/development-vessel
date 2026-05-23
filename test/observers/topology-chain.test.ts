import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock resolveDispatch BEFORE importing the observer module so the module
// captures the mock on load (Bun hoists mock.module calls).
const dispatchCalls: Array<Record<string, unknown>> = [];
let snapshotOverride: Record<string, unknown> = {};
let unlearnedOverride: Record<string, unknown> = {};
let unknownOverride: Record<string, unknown> = {};

mock.module("../../src/routes/impulses.js", () => ({
  resolveDispatch: async (payload: Record<string, unknown>) => {
    dispatchCalls.push(payload);
    const t = payload["type"] as string;
    if (t === "learned_topology_snapshot") return { shape: "learnedTopologySnapshot", body: snapshotOverride };
    if (t === "reachable_unlearned_report") return { shape: "reachableButUnlearnedReport", body: unlearnedOverride };
    if (t === "unknown_shape_report") return { shape: "unknownShapeReport", body: unknownOverride };
    return { shape: t, body: {} };
  },
}));

// Import AFTER mock.module so the observer binds to the mock
const { runTopologyChain, resetAggregatorDebounce } = await import(
  "../../src/observers/registry-change-observer.js"
);

function dispatchTypes(): string[] {
  return dispatchCalls.map((c) => c["type"] as string);
}

describe("topology chain dispatch (§4.2)", () => {
  beforeEach(() => {
    dispatchCalls.length = 0;
    snapshotOverride = {};
    unlearnedOverride = {};
    unknownOverride = {};
    resetAggregatorDebounce();
  });

  it("always fires snapshot + unlearned-report + unknown-report as base chain", async () => {
    snapshotOverride = { untraversed_edges: [], cells: {} };
    unlearnedOverride = { total: 0, shapes: [] };
    unknownOverride = { total: 0, shapes: [] };
    await runTopologyChain();
    const types = dispatchTypes();
    expect(types).toContain("learned_topology_snapshot");
    expect(types).toContain("reachable_unlearned_report");
    expect(types).toContain("unknown_shape_report");
  });

  it("fires NO conditional probes when all totals are zero and no untraversed edges", async () => {
    snapshotOverride = { untraversed_edges: [], cells: {} };
    unlearnedOverride = { total: 0 };
    unknownOverride = { total: 0 };
    await runTopologyChain();
    const types = dispatchTypes();
    // Base: snapshot + unlearned + unknown + (aggregators once)
    // No extra reachable_unlearned_report probe, no extra learned_topology_snapshot probe, no extra unknown_shape_report probe
    const basePlusAggregators = new Set([
      "learned_topology_snapshot",
      "reachable_unlearned_report",
      "unknown_shape_report",
      "coverage_tick",
      "substrate_health_tick",
    ]);
    for (const t of types) {
      expect(basePlusAggregators.has(t)).toBe(true);
    }
  });

  it("fires reachable_unlearned_report probe when unlearned total > 0", async () => {
    snapshotOverride = { untraversed_edges: [] };
    unlearnedOverride = { total: 3 };
    unknownOverride = { total: 0 };
    await runTopologyChain();
    const types = dispatchTypes();
    // Should have reachable_unlearned_report called at least twice (base + probe)
    expect(types.filter((t) => t === "reachable_unlearned_report").length).toBeGreaterThanOrEqual(2);
  });

  it("fires learned_topology_snapshot probe when untraversed edges exist", async () => {
    snapshotOverride = { untraversed_edges: [{ from: "shapeA", to: "shapeB" }] };
    unlearnedOverride = { total: 0 };
    unknownOverride = { total: 0 };
    await runTopologyChain();
    const types = dispatchTypes();
    expect(types.filter((t) => t === "learned_topology_snapshot").length).toBeGreaterThanOrEqual(2);
  });

  it("fires unknown_shape_report probe when unknown total > 0", async () => {
    snapshotOverride = { untraversed_edges: [] };
    unlearnedOverride = { total: 0 };
    unknownOverride = { total: 5 };
    await runTopologyChain();
    const types = dispatchTypes();
    expect(types.filter((t) => t === "unknown_shape_report").length).toBeGreaterThanOrEqual(2);
  });

  it("fires aggregators on first chain invocation", async () => {
    snapshotOverride = { untraversed_edges: [] };
    unlearnedOverride = { total: 0 };
    unknownOverride = { total: 0 };
    await runTopologyChain();
    const types = dispatchTypes();
    expect(types).toContain("coverage_tick");
    expect(types).toContain("substrate_health_tick");
  });

  it("skips aggregators on rapid second invocation (debounce)", async () => {
    snapshotOverride = { untraversed_edges: [] };
    unlearnedOverride = { total: 0 };
    unknownOverride = { total: 0 };
    // First call fires aggregators
    await runTopologyChain();
    const afterFirst = dispatchTypes().filter((t) =>
      t === "coverage_tick" || t === "substrate_health_tick",
    ).length;
    expect(afterFirst).toBe(2);

    // Second call within debounce window should NOT fire aggregators again
    dispatchCalls.length = 0;
    await runTopologyChain();
    const afterSecond = dispatchTypes().filter((t) =>
      t === "coverage_tick" || t === "substrate_health_tick",
    ).length;
    expect(afterSecond).toBe(0);
  });

  it("fires all three probes when all conditions are met simultaneously", async () => {
    snapshotOverride = { untraversed_edges: [{ from: "a", to: "b" }] };
    unlearnedOverride = { total: 2 };
    unknownOverride = { total: 1 };
    await runTopologyChain();
    const types = dispatchTypes();
    expect(types.filter((t) => t === "reachable_unlearned_report").length).toBeGreaterThanOrEqual(2);
    expect(types.filter((t) => t === "learned_topology_snapshot").length).toBeGreaterThanOrEqual(2);
    expect(types.filter((t) => t === "unknown_shape_report").length).toBeGreaterThanOrEqual(2);
  });
});
