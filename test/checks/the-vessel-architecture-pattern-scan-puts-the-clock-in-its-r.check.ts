import { describe, expect, setSystemTime, test } from "bun:test";
import { resolveVesselArchitecturePatternScan as scan } from "../../src/resolvers/vessel-architecture-pattern-scan.js";
import type { VesselArchitecturePatternScanPointer } from "../../src/resolvers/vessel-architecture-pattern-scan.js";

const firstTime = 1700000000000;
const secondTime = 1700000001000;

async function findingsAt(timestamp: number) {
  const pointer: VesselArchitecturePatternScanPointer = {
    type: "vesselArchitecturePatternScan",
    traces: [{
      status: "success",
      duration_ms: 100,
      template_id: "activity:⟨mock-activity⟩",
      metadata: {
        dispatcher: "test-dispatcher",
        _created_at: timestamp,
      },
    }],
    advertisedShapes: new Set(["shape1"]),
    templates: [],
    dryRun: false,
  };

  // Control the resolver's clock as well as the trace timestamp. Never rely on
  // whether two real calls happen to fall within the same millisecond.
  setSystemTime(new Date(timestamp));
  try {
    const result = await scan(pointer);
    const body = typeof result.body === "string" ? JSON.parse(result.body) : result.body;
    return (body as { findings: { gap_id: string }[] }).findings;
  } finally {
    setSystemTime();
  }
}

 describe("vessel_architecture_pattern_scan row id stability", () => {
  test("two detections of the same condition at different times must produce one row id (MUST-FAIL)", async () => {
    const findings1 = await findingsAt(firstTime);
    const findings2 = await findingsAt(secondTime);

    expect(findings1).toBeArrayOfSize(1);
    expect(findings2).toBeArrayOfSize(1);
    expect(findings1[0]!.gap_id).toEqual(findings2[0]!.gap_id);
  });

  test("the same condition at the same fixed time produces the same row id (CONTROL)", async () => {
    const findings1 = await findingsAt(firstTime);
    const findings2 = await findingsAt(firstTime);

    expect(findings1).toBeArrayOfSize(1);
    expect(findings2).toBeArrayOfSize(1);
    expect(findings1[0]!.gap_id).toEqual(findings2[0]!.gap_id);
  });
});
