import { describe, it, expect } from "bun:test";
import * as mod from "../../src/goal-target-inference";

describe("goal-target inference reappearance: outside-world network asks", () => {
  it("maps a 'scan network devices' ask to a world-acting tool; defect: routes to substrate self-report", async () => {
    const goal = "Scan network devices and list any servers on our local network.";
    // Include advertised substrate self-report shapes and shellResult to expose the misrouting.
    const knownShapes = [
      "shellResult",
      "vesselHealth",
      "vesselRegistry",
      "web_search",
      "env_gate_scan",
      "memoryNote_write",
      "concept_write",
      "substrateGap_write",
    ];

    const decision = await mod.inferGoalTargetShapes(goal, knownShapes);

    // Failing assertion: today the inference maps the outside-world ask onto substrate self-report shapes
    // (e.g. vesselHealth / vesselRegistry) or abstains. Parity floor requires selecting a world-acting tool.
    expect(Array.isArray(decision?.shapes) ? decision!.shapes : []).toContain("shellResult");
  });
});
