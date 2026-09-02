import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveReachRateScan, REACH_RATE_SCAN_SHAPE } from "../../src/resolvers/reach-rate-scan";
import { classifyFalsifier } from "../../src/resolvers/substrate-gap";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockEmit(sink: unknown[]) {
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    sink.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

type Gap = {
  id: string;
  summary: string;
  classification_metadata: Record<string, unknown> & {
    evidence_resolve?: { shape?: string; input?: Record<string, unknown>; nonzero_field?: string; defect_field?: string };
  };
};
const gapOf = (emit: unknown): Gap =>
  (emit as { impulse: { pointer: { gap: Gap } } }).impulse.pointer.gap;

describe("reach_rate_scan", () => {
  it("emits a gap for a family below the reach floor", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveReachRateScan({
      type: "reach_rate_scan",
      _rows: [
        { activity_id: "walk:goal-host", count: 300, success_rate: 0.98, reached_count: 5, graded_count: 100, ungraded_count: 200, reach_rate: 0.05 },
      ],
    });
    expect(res.shape).toBe("reachRateReport");
    const body = res.body as { finding_count: number; findings: Array<{ activity_id: string }> };
    expect(body.finding_count).toBe(1);
    expect(body.findings[0]!.activity_id).toBe("walk:goal-host");
    expect(emits.length).toBe(1);
    expect(gapOf(emits[0]).classification_metadata["gap_subtype"]).toBe("reach_rate_shortfall");
  });

  it("emits NO gap for a family above the floor", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveReachRateScan({
      type: "reach_rate_scan",
      _rows: [
        { activity_id: "walk:goal-host", count: 100, success_rate: 0.5, reached_count: 92, graded_count: 100, ungraded_count: 0, reach_rate: 0.92 },
      ],
    });
    expect((res.body as { finding_count: number }).finding_count).toBe(0);
    expect(emits.length).toBe(0);
  });

  it("judges REACH, not SUCCESS — a cleanly-exiting family that never reaches is flagged", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    // success_rate 1.00, reach_rate 0.02. A detector reading success would see nothing.
    await resolveReachRateScan({
      type: "reach_rate_scan",
      _rows: [{ activity_id: "tick:hollow", count: 50, success_rate: 1.0, reached_count: 1, graded_count: 50, ungraded_count: 0, reach_rate: 0.02 }],
    });
    expect(emits.length).toBe(1);
    expect(gapOf(emits[0]).summary).toContain("success_rate=100.0%");
  });

  it("does NOT filter by activity name (the detect-gate-saturation blind spot)", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    // No gate-like substring anywhere in the id — the family that re-minted itself 79x.
    const res = await resolveReachRateScan({
      type: "reach_rate_scan",
      _rows: [{ activity_id: "composed-cap-a1b2c3", count: 79, success_rate: 1.0, reached_count: 0, graded_count: 79, ungraded_count: 0, reach_rate: 0 }],
    });
    expect((res.body as { finding_count: number }).finding_count).toBe(1);
  });

  describe("ungraded handling", () => {
    it("skips a family with high volume but too few GRADED runs", async () => {
      const emits: unknown[] = [];
      mockEmit(emits);
      const res = await resolveReachRateScan({
        type: "reach_rate_scan",
        _rows: [{ activity_id: "tick:busy", count: 500, success_rate: 1.0, reached_count: 0, graded_count: 2, ungraded_count: 498, reach_rate: 0 }],
      });
      const body = res.body as { finding_count: number; families_evaluated: number; families_skipped_insufficient_grading: number };
      expect(body.finding_count).toBe(0);
      expect(body.families_evaluated).toBe(0);
      expect(body.families_skipped_insufficient_grading).toBe(1);
      expect(emits.length).toBe(0);
    });

    it("skips a family with a NULL reach_rate (no verdict is not a failure to reach)", async () => {
      const emits: unknown[] = [];
      mockEmit(emits);
      const res = await resolveReachRateScan({
        type: "reach_rate_scan",
        _rows: [{ activity_id: "tick:ungraded", count: 400, success_rate: 1.0, reached_count: 0, graded_count: 0, ungraded_count: 400, reach_rate: null }],
      });
      expect((res.body as { finding_count: number }).finding_count).toBe(0);
      expect(emits.length).toBe(0);
    });

    it("reports fleet_reach_rate over the GRADED slice only", async () => {
      const res = await resolveReachRateScan({
        type: "reach_rate_scan",
        dry_run: true,
        _rows: [
          { activity_id: "a", count: 100, success_rate: 1, reached_count: 9, graded_count: 10, ungraded_count: 90, reach_rate: 0.9 },
          { activity_id: "b", count: 100, success_rate: 1, reached_count: 1, graded_count: 10, ungraded_count: 90, reach_rate: 0.1 },
        ],
      });
      const body = res.body as { fleet_reach_rate: number; fleet_graded_count: number };
      expect(body.fleet_graded_count).toBe(20);
      expect(body.fleet_reach_rate).toBe(0.5); // NOT 10/200
    });
  });

  describe("the emitted falsifier is usable by the gap sweep", () => {
    /** Read the fleet's advertised names off config.ts — never hardcode the list. */
    function advertisedShapes(): Set<string> {
      const shapes = new Set<string>();
      const configs = [
        join(import.meta.dir, "../../src/config.ts"),
        join(import.meta.dir, "../../../activity-api/src/config.ts"),
      ];
      for (const path of configs) {
        let src: string;
        try { src = readFileSync(path, "utf8"); } catch { continue; }
        const block = src.match(/shapes\s*:\s*\[([\s\S]*?)\n\s*\]/);
        if (!block) continue;
        for (const m of block[1]!.matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) shapes.add(m[1]!);
      }
      return shapes;
    }

    it("names a shape that is actually advertised in a vessel's config.ts", async () => {
      const emits: unknown[] = [];
      mockEmit(emits);
      await resolveReachRateScan({
        type: "reach_rate_scan",
        _rows: [{ activity_id: "walk:goal-host", count: 100, success_rate: 1, reached_count: 2, graded_count: 100, ungraded_count: 0, reach_rate: 0.02 }],
      });
      const meta = gapOf(emits[0]).classification_metadata;
      const er = meta.evidence_resolve!;
      const advertised = advertisedShapes();
      // Sanity: the reader works at all (a broken reader would make any name "fail").
      expect(advertised.has("groupedExecutionStats")).toBe(true);
      expect(er.shape).toBe(REACH_RATE_SCAN_SHAPE);
      expect(advertised.has(er.shape!)).toBe(true);
      // The input must identify the group, or the re-run measures the whole fleet.
      expect(er.input!["activity_id"]).toBe("walk:goal-host");
      // Nonzero when healthy: reach_rate, never a defect COUNT (which inverts).
      expect(er.nonzero_field).toBe("reach_rate");
      // And the re-run must not itself emit gaps.
      expect(er.input!["dry_run"]).toBe(true);
    });

    it("classifyFalsifier stamps it class2 (not none, not unresolvable)", async () => {
      const emits: unknown[] = [];
      mockEmit(emits);
      await resolveReachRateScan({
        type: "reach_rate_scan",
        _rows: [{ activity_id: "walk:goal-host", count: 100, success_rate: 1, reached_count: 2, graded_count: 100, ungraded_count: 0, reach_rate: 0.02 }],
      });
      const meta = gapOf(emits[0]).classification_metadata;
      // Pass the vocabulary explicitly: the fs-scan cache would otherwise decide
      // this, and a fail-open "cannot see" verdict also returns class2 — which
      // would make this assertion pass for the wrong reason.
      const vocab = { shapes: advertisedShapes(), configs_read: 2 } as unknown as Parameters<typeof classifyFalsifier>[1];
      const c = classifyFalsifier(meta, vocab);
      expect(c.falsifier).toBe("class2");
      expect(c.predicate_position).toBe("evidence_resolve.shape");
    });

    /**
     * VERIFY AT THE CONSUMING LAYER. The tests above call the resolver directly;
     * the sweep does not. It POSTs to dev-vessel's own /v2/impulses/resolve and
     * then reads `respBody['body']` and indexes nonzero_field/defect_field FLAT
     * off it. If that route wrapped the ResolverResult the way activity-api does
     * ({success, content:"<json string>"}), every flat read would be undefined and
     * this falsifier would be inert while every unit test above still passed.
     * Static assertion on the route's response construction — no live vessel.
     */
    it("the resolve route returns the resolver body at the top level the sweep reads", () => {
      const route = readFileSync(join(import.meta.dir, "../../src/routes/impulses.ts"), "utf8");
      expect(route).toContain("c.json({ success: true, shape: result.shape, body: result.body })");
      expect(route).not.toContain("content: JSON.stringify(result");
      // And the shape must be dispatchable there at all — resolvePointer throws
      // "Unknown pointer type" (500 -> !resp.ok -> 'unknown' forever) otherwise.
      expect(route).toContain(`case "${REACH_RATE_SCAN_SHAPE}":`);
    });
  });

  describe("single-family measurement mode (what the falsifier re-runs)", () => {
    const row = (reach: number | null, graded: number) => ({
      activity_id: "walk:goal-host", count: 100, success_rate: 1,
      reached_count: reach === null ? 0 : Math.round(reach * graded),
      graded_count: graded, ungraded_count: 100 - graded, reach_rate: reach,
    });

    it("projects reach_rate FLAT and carries the defect string while below the floor", async () => {
      const res = await resolveReachRateScan({ type: "reach_rate_scan", activity_id: "walk:goal-host", _rows: [row(0.02, 100)] });
      const body = res.body as Record<string, unknown>;
      // Read exactly as verifyGapConditionAsync reads: inner[field], no traversal.
      expect(body["reach_rate"]).toBe(0.02);
      expect(typeof body["reach_below_floor"]).toBe("string"); // defect_field => 'present'
    });

    it("drops the defect string once reach clears the floor, so the gap can close", async () => {
      const res = await resolveReachRateScan({ type: "reach_rate_scan", activity_id: "walk:goal-host", _rows: [row(0.93, 100)] });
      const body = res.body as Record<string, unknown>;
      expect(body["reach_below_floor"]).toBeUndefined();
      expect(body["reach_rate"]).toBe(0.93); // nonzero => 'absent' => closes
    });

    it("holds the gap open (reach_rate null) when the family is ungraded", async () => {
      const res = await resolveReachRateScan({ type: "reach_rate_scan", activity_id: "walk:goal-host", _rows: [row(null, 0)] });
      expect((res.body as Record<string, unknown>)["reach_rate"]).toBeNull();
    });

    it("never emits in single-family mode, even without dry_run", async () => {
      const emits: unknown[] = [];
      mockEmit(emits);
      await resolveReachRateScan({ type: "reach_rate_scan", activity_id: "walk:goal-host", dry_run: false, _rows: [row(0.0, 100)] });
      expect(emits.length).toBe(0);
    });
  });
});
