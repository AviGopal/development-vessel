// THE EXISTING DECOMPOSITION WRITER IS ADVERTISED, AND THE BUILDERS THAT KNOW THE GAP SAY SO STRUCTURED (CHANGE-35).
//
// A gap investigation wrote nothing onto its gap (RUN 0, 2026-10-16): decomposeGap was reachable only through the
// private gap_to_feature shape, and the builders sent free text. Now:
//   [MUST-FAIL] gapDecomposition is advertised and dispatched to the EXISTING decompose_gap_id branch of
//               resolveGapToFeature (no new writer), answering in its own shape.
//   [MUST-FAIL] both gap-to-feature builders (escalation, investigate-before-composing) send expected_output_shapes
//               ["gapDecomposition"] with variables.decompose_gap_id, and dispatch_goal passes expected_output_shapes.
//   [CONTROL]   a gapDecomposition pointer without the gap id is a shaped missing_input error, not a decomposition.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

describe("gapDecomposition: the existing writer, advertised", () => {
  it("[MUST-FAIL] advertised and dispatched to the existing decompose branch", () => {
    expect(read("config.ts")).toContain('"gapDecomposition", // CHANGE-35');
    const r = read("routes/impulses.ts");
    expect(r).toContain('case "gapDecomposition": {');
    expect(r).toContain('const r = await resolveGapToFeature({ type: "gap_to_feature", decompose_gap_id: gid }');
    expect(r).toContain('return { shape: "gapDecomposition", body: { ...body, created: before ? written.filter((c) => !priorChildren.has(c)) : [], prior_children: priorChildren.size } };');
  });

  it("[MUST-FAIL] the builders send the gap structured; dispatch_goal passes expected_output_shapes", async () => {
    const g = read("resolvers/gap-to-feature.ts");
    expect(g).toContain('expected_output_shapes: ["gapDecomposition"],\n        variables: { decompose_gap_id: parentId },');
    expect(g).toContain('expected_output_shapes: ["gapDecomposition"], variables: { decompose_gap_id: String(gap.id) } } as never);');
    const dg = read("resolvers/dispatch-goal.ts");
    expect(dg).toContain('if (Array.isArray(pointer.expected_output_shapes) && pointer.expected_output_shapes.length > 0) body["expected_output_shapes"] = pointer.expected_output_shapes;');
  });

  it("[CONTROL] no gap id: a shaped missing_input error", () => {
    expect(read("routes/impulses.ts")).toContain('failure_mode: "missing_input", detail: "gapDecomposition requires decompose_gap_id (the gap to decompose)"');
  });
});
