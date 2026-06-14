import { describe, it, expect, afterEach } from "bun:test";
import { resolveVesselWriteErrorScan } from "../../src/resolvers/vessel-write-error-scan";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockEmit(sink: unknown[]) {
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    sink.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("vessel_write_error_scan", () => {
  it("emits a gap for a unit whose error count crosses the threshold", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveVesselWriteErrorScan({
      type: "vessel_write_error_scan",
      threshold: 3,
      targets: [{ unit: "concept-db.service", pattern: "Found NULL" }],
      _countFn: async () => 7,
    });
    expect(res.shape).toBe("vesselWriteErrorReport");
    const body = res.body as { finding_count: number; findings: Array<{ unit: string; match_count: number }> };
    expect(body.finding_count).toBe(1);
    expect(body.findings[0]!.unit).toBe("concept-db.service");
    expect(body.findings[0]!.match_count).toBe(7);
    expect(emits.length).toBe(1);
    const gap = (emits[0] as { impulse: { pointer: { gap: { classification_metadata: { gap_subtype: string } } } } }).impulse.pointer;
    expect(gap.gap.classification_metadata.gap_subtype).toBe("vessel_write_error");
  });

  it("does NOT emit below threshold (transient noise floor)", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveVesselWriteErrorScan({
      type: "vessel_write_error_scan",
      threshold: 3,
      targets: [{ unit: "concept-db.service", pattern: "Found NULL" }],
      _countFn: async () => 1,
    });
    expect((res.body as { finding_count: number }).finding_count).toBe(0);
    expect(emits.length).toBe(0);
  });

  it("scans multiple targets and reports per_target counts", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveVesselWriteErrorScan({
      type: "vessel_write_error_scan",
      threshold: 5,
      targets: [
        { unit: "a.service", pattern: "x" },
        { unit: "b.service", pattern: "y" },
      ],
      _countFn: async (t) => (t.unit === "a.service" ? 10 : 2),
    });
    const body = res.body as { finding_count: number; per_target: Array<{ unit: string; match_count: number }> };
    expect(body.per_target.length).toBe(2);
    expect(body.finding_count).toBe(1); // only a.service crosses 5
    expect(emits.length).toBe(1);
  });

  it("dry_run reports without emitting", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveVesselWriteErrorScan({
      type: "vessel_write_error_scan",
      dry_run: true,
      threshold: 3,
      targets: [{ unit: "concept-db.service", pattern: "z" }],
      _countFn: async () => 9,
    });
    const body = res.body as { finding_count: number; dry_run: boolean };
    expect(body.finding_count).toBe(1);
    expect(body.dry_run).toBe(true);
    expect(emits.length).toBe(0);
  });
});
