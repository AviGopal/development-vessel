import { describe, it, expect } from "bun:test";
import { resolveDetectorMetaScan } from "../../src/resolvers/detector-meta-scan.js";

const snap = (templates: any[]) => resolveDetectorMetaScan({ type: "detector_meta_scan", dry_run: true, _snapshot: { templates } }) as Promise<{ body: any }>;

describe("detector_meta_scan resolver (nth-order)", () => {
  it("flags dormant detectors (picks=0) but not active ones", async () => {
    const r = await snap([
      { template_id: "development-vessel:cost-expectation-audit-tick", picks: 9, mean: 0.2 },
      { template_id: "development-vessel:self-alteration-funnel-tick", picks: 0, mean: 0 },   // dormant
      { template_id: "development-vessel:gap-lifecycle-tick", picks: 0, mean: 0 },            // dormant
      { template_id: "development-vessel:some-normal-activity", picks: 5, mean: 0.5 },        // not a detector
    ]);
    expect(r.body.detectors_known).toBe(3);
    expect(r.body.active).toBe(1);
    expect(r.body.dormant_count).toBe(2);
    expect(r.body.dormant).toContain("development-vessel:self-alteration-funnel-tick");
    expect(r.body.finding_count).toBe(1);
  });

  it("no finding when all detectors are exercised", async () => {
    const r = await snap([
      { template_id: "development-vessel:funnel-scan-tick", picks: 4, mean: 0 },
      { template_id: "development-vessel:detector-coverage-audit-tick", picks: 7, mean: 0.1 },
    ]);
    expect(r.body.dormant_count).toBe(0);
    expect(r.body.finding_count).toBe(0);
  });
});
