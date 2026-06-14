import { describe, it, expect, afterEach } from "bun:test";
import { resolveGateSaturationScan } from "../../src/resolvers/gate-saturation-scan";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockEmit(sink: unknown[]) {
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    sink.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("gate_saturation_scan", () => {
  it("flags a gate resolver saturated-failing over enough samples", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveGateSaturationScan({
      type: "gate_saturation_scan",
      _rows: [
        { resolver_id: "comprehensibility_check", output_shape: "comprehensibilityScore", count: 20, success_count: 0, success_rate: 0.0 },
      ],
    });
    expect(res.shape).toBe("gateSaturationReport");
    const body = res.body as { finding_count: number; findings: Array<{ resolver_id: string }> };
    expect(body.finding_count).toBe(1);
    expect(body.findings[0]!.resolver_id).toBe("comprehensibility_check");
    expect(emits.length).toBe(1);
    const gap = (emits[0] as { impulse: { pointer: { gap: { classification_metadata: { gap_subtype: string } } } } }).impulse.pointer;
    expect(gap.gap.classification_metadata.gap_subtype).toBe("gate_saturation");
  });

  it("does NOT flag a healthy gate (high pass rate)", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveGateSaturationScan({
      type: "gate_saturation_scan",
      _rows: [{ resolver_id: "comprehensibility_check", output_shape: "comprehensibilityScore", count: 20, success_count: 18, success_rate: 0.9 }],
    });
    expect((res.body as { finding_count: number }).finding_count).toBe(0);
    expect(emits.length).toBe(0);
  });

  it("does NOT flag a non-gate resolver even at 0% (only gate-like ids)", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveGateSaturationScan({
      type: "gate_saturation_scan",
      _rows: [{ resolver_id: "llm_completion_dispatch", output_shape: "patch_proposal", count: 50, success_count: 0, success_rate: 0.0 }],
    });
    expect((res.body as { finding_count: number; gate_cells_evaluated: number }).finding_count).toBe(0);
    expect((res.body as { gate_cells_evaluated: number }).gate_cells_evaluated).toBe(0);
    expect(emits.length).toBe(0);
  });

  it("does NOT flag below min_volume (noise floor)", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveGateSaturationScan({
      type: "gate_saturation_scan",
      _rows: [{ resolver_id: "validate_gate", output_shape: "x", count: 3, success_count: 0, success_rate: 0.0 }],
    });
    expect((res.body as { finding_count: number }).finding_count).toBe(0);
    expect(emits.length).toBe(0);
  });

  it("dry_run reports without emitting", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveGateSaturationScan({
      type: "gate_saturation_scan",
      dry_run: true,
      _rows: [{ resolver_id: "guard_check", output_shape: "verdict", count: 12, success_count: 0, success_rate: 0.0 }],
    });
    const body = res.body as { finding_count: number; dry_run: boolean };
    expect(body.finding_count).toBe(1);
    expect(body.dry_run).toBe(true);
    expect(emits.length).toBe(0);
  });
});
