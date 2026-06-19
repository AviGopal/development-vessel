import { describe, expect, it } from "bun:test";
import {
  resolveDetectorYieldRegistry,
  normKey,
  detectorFromGapId,
} from "../../src/resolvers/detector-yield-registry.js";

const now = new Date().toISOString();

// A scripted gap+snapshot fixture exercising every status. No network: the
// resolver reads pointer._gaps / pointer._snapshot test hooks and emit defaults
// to false, so emitRetirementGap is never reached.
function gaps() {
  return [
    // det_landed: emitted 2, one closed-and-not-churned (landed), one open → PRODUCTIVE
    { id: "g1", status: "closed", detected_at: now, classification_metadata: { detector: "det_landed" } },
    { id: "g2", status: "open", detected_at: now, classification_metadata: { detector: "det_landed" } },
    // det_churned: emitted 2, both closed with churn reason → 0 landed, churn-dominated → LOW_YIELD
    { id: "g3", status: "closed", detected_at: now, classification_metadata: { detector: "det_churned", closed_reason: "churned_unlandable" } },
    { id: "g4", status: "closed", detected_at: now, classification_metadata: { detector: "det_churned", closed_reason: "churned_unlandable" } },
    // provenance-absent gap whose id maps to a known family
    { id: "wasted-cycle-some_template", status: "open", detected_at: now, classification_metadata: {} },
  ];
}

describe("detector_yield_registry", () => {
  it("classifies a detector with landed gaps as PRODUCTIVE", async () => {
    const r = await resolveDetectorYieldRegistry({ type: "detector_yield_registry", _gaps: gaps(), _snapshot: { templates: [] } });
    expect(r.shape).toBe("detectorYieldReport");
    const rows = (r.body as any).detectors as Array<any>;
    const landed = rows.find((x) => x.detector_id === "det_landed");
    expect(landed).toBeDefined();
    expect(landed.status).toBe("PRODUCTIVE");
    expect(landed.gaps_landed).toBe(1);
    expect(landed.gaps_open).toBe(1);
    expect(landed.gaps_emitted).toBe(2);
  });

  it("classifies an emitted-but-all-churned detector as LOW_YIELD", async () => {
    const r = await resolveDetectorYieldRegistry({ type: "detector_yield_registry", _gaps: gaps(), _snapshot: { templates: [] } });
    const rows = (r.body as any).detectors as Array<any>;
    const churned = rows.find((x) => x.detector_id === "det_churned");
    expect(churned).toBeDefined();
    expect(churned.status).toBe("LOW_YIELD");
    expect(churned.gaps_landed).toBe(0);
    expect(churned.gaps_churned).toBe(2);
  });

  it("classifies a detector with picks < threshold as DORMANT", async () => {
    // det_dormant emitted nothing but the snapshot lists its detector-class tick
    // with picks=0 → DORMANT. Also a detector that DID emit but has picks=0 is dormant.
    const snapshot = {
      templates: [
        { template_id: "development-vessel:det-dormant-scan-tick", picks: 0, mean: 0, novel_fraction: null },
        { template_id: "development-vessel:det-emitted-but-unscheduled-scan", picks: 0, mean: 0.2, novel_fraction: 1 },
      ],
    };
    const g = [
      { id: "x1", status: "open", detected_at: now, classification_metadata: { detector: "det_emitted_but_unscheduled_scan" } },
    ];
    const r = await resolveDetectorYieldRegistry({ type: "detector_yield_registry", dormant_picks_threshold: 1, _gaps: g, _snapshot: snapshot });
    const rows = (r.body as any).detectors as Array<any>;
    const dormant = rows.find((x) => x.detector_id === "development-vessel:det-dormant-scan-tick");
    expect(dormant).toBeDefined();
    expect(dormant.status).toBe("DORMANT");
    // picks=0 overrides the open-gap signal → DORMANT (never scheduled)
    const unsched = rows.find((x) => x.detector_id === "det_emitted_but_unscheduled_scan");
    expect(unsched).toBeDefined();
    expect(unsched.status).toBe("DORMANT");
    expect(unsched.picks).toBe(0);
    expect((r.body as any).summary.dormant).toBeGreaterThanOrEqual(2);
  });

  it("handles an empty store gracefully", async () => {
    const r = await resolveDetectorYieldRegistry({ type: "detector_yield_registry", _gaps: [], _snapshot: { templates: [] } });
    expect(r.shape).toBe("detectorYieldReport");
    expect((r.body as any).detectors).toEqual([]);
    expect((r.body as any).summary.total).toBe(0);
    expect((r.body as any).retirement_gaps_emitted).toBe(null);
  });

  it("normKey aligns snake-case detector ids with kebab tick template ids", () => {
    expect(normKey("dead_end_decision_scan")).toBe("dead_end_decision_scan");
    expect(normKey("development-vessel:dead-end-decision-scan-tick")).toBe("dead_end_decision_scan");
    expect(normKey("development-vessel:detector-coverage-audit-tick")).toBe("detector_coverage");
  });

  it("detectorFromGapId recovers provenance from stable gap-id families", () => {
    expect(detectorFromGapId("detector-coverage-gap-foo")).toBe("detector_coverage_scan");
    expect(detectorFromGapId("wasted-cycle-bar")).toBe("cyclic_flow_scan");
    expect(detectorFromGapId("decision-without-action-x-y")).toBe("dead_end_decision_scan");
    expect(detectorFromGapId("totally-unknown-thing")).toBe("(unattributed)");
  });
});
