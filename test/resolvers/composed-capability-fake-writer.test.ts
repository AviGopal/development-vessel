// A COMPOSITE DECLARES ONLY THE SHAPES ITS TASKS PRODUCE (finding agf_zs97ncomgubz). author_composed_capability forced the
// final task's declared output to the goal's target shape; for a write target that made an llm_completion_dispatch task
// "produce" a write it cannot perform, and the template was minted global and live as a producer of that write. The id
// was never the problem (USER, 10-28: the way the shape was expressed was); the composite now mints as what it is: the
// write is declared only when the final task's resolver performs it, otherwise the task keeps its real shapes and the
// composite's declared outputs are derived from them.
// MUST-FAIL on the parent (b4542da5): coercePlan is not exported and declares the write for an llm-ending plan.
// Fixture shapes from a 5-word draw (2026-10-28T09:28:37Z: hurried superior isotope july rut).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as acc from "../../src/resolvers/author-composed-capability.js";

type Plan = { tasks: Array<{ id: string; resolver: string; output_shapes?: string[] }>; outputShapes: string[] };
const coercePlan = (acc as unknown as { coercePlan?: (raw: unknown, catalogue: Set<string>, deliverable: string) => Plan | { error: string } }).coercePlan;
const CATALOGUE = new Set(["traceAggregateReport", "llm_completion_dispatch", "isotopeJuly_write", "resolve_impulse"]);
const plan = (raw: unknown, deliverable: string): Plan => {
  expect(typeof coercePlan).toBe("function");
  const r = coercePlan!(raw, CATALOGUE, deliverable);
  if ("error" in r) throw new Error(r.error);
  return r;
};
const DATA = { id: "data_task_1", resolver: "traceAggregateReport", output_shapes: ["traceAggregateReport"] };
const SRC = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "author-composed-capability.ts"), "utf8");

describe("a composed capability declares only the shapes its tasks produce", () => {
  it("[MUST-FAIL] an X_write goal whose plan ends in llm_completion_dispatch mints a composite that does not declare X_write", () => {
    const p = plan([DATA, { id: "format_task_1", resolver: "llm_completion_dispatch", output_shapes: ["isotopeJuly_write"], config: { prompt: "rut" } }], "isotopeJuly_write");
    expect(p.outputShapes).not.toContain("isotopeJuly_write");
    expect(p.tasks.flatMap((t) => t.output_shapes ?? [])).not.toContain("isotopeJuly_write");
    expect(p.outputShapes).toEqual(["llm_completion_result"]);
  });

  it("[MUST-FAIL] the minted template's declared outputs are the plan's derived outputs, and nothing refuses the mint", () => {
    expect(SRC).toContain("output_shapes: plan.outputShapes,");
    expect(SRC).not.toContain("fake_writer_refused");
    expect(SRC).toMatch(/const outputShapes = finalTask\?\.output_shapes\?\.length \? \[\.\.\.finalTask\.output_shapes\] : \[deliverable\];/);
  });

  it("[CONTROL] a plan ending in a real *_write resolver still declares X_write", () => {
    const p = plan([DATA, { id: "write_task_1", resolver: "isotopeJuly_write", config: { body: "{{impulse:data_task_1_out}}" } }], "isotopeJuly_write");
    expect(p.outputShapes).toEqual(["isotopeJuly_write"]);
  });

  it("[CONTROL] an impulse-resolve whose pointer type is X_write still declares it", () => {
    const p = plan([DATA, { id: "write_task_1", resolver: "resolve_impulse", config: { impulse: { type: "isotopeJuly_write" } } }], "isotopeJuly_write");
    expect(p.outputShapes).toEqual(["isotopeJuly_write"]);
    const other = plan([DATA, { id: "write_task_1", resolver: "resolve_impulse", config: { impulse: { type: "superiorRut_write" } } }], "isotopeJuly_write");
    expect(other.outputShapes).not.toContain("isotopeJuly_write");
  });

  it("[CONTROL] a non-write deliverable is still the llm task's declared output (unchanged)", () => {
    const p = plan([DATA, { id: "format_task_1", resolver: "llm_completion_dispatch", config: { prompt: "rut" } }], "hurriedRutReport");
    expect(p.outputShapes).toEqual(["hurriedRutReport"]);
  });
});
