// A COMPOSED CAPABILITY DECLARES ONLY ITS EXTERNAL PRECONDITIONS (2026-10-17). author_composed_capability declared the
// template's input_shapes as the plain union of its tasks' inputs. Its own data->format wiring makes the format task
// consume the data task's output, so every two-task composite declared a shape it produces itself, and activity-api
// refuses that ("Invalid input_shapes: the composition declares a precondition it produces itself", routes/activities.ts:
// a declared input that ANY task of the composition outputs). Live on node1: the first NOVEL target the chooser answered
// (goal-host B2, dispatch b489e322) reached author_composed_capability and its mint was refused for exactly this.
// MUST-FAIL at the parent 9299ef08: composedTemplateInputs does not exist and the template uses the plain union.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as acc from "../../src/resolvers/author-composed-capability.js";

type T = { input_shapes?: string[]; output_shapes?: string[] };
const composedTemplateInputs = (acc as unknown as { composedTemplateInputs?: (t: T[]) => string[] }).composedTemplateInputs
  ?? ((t: T[]) => [...new Set(t.flatMap((x) => x.input_shapes ?? []))]); // the parent's plain union
/** activity-api's rule, as routes/activities.ts applies it at mint: a declared input no task of the composition outputs. */
const selfSatisfied = (declared: string[], tasks: T[]) => declared.filter((i) => tasks.some((t) => (t.output_shapes ?? []).includes(i)));

describe("a composed capability's declared inputs", () => {
  it("[MUST-FAIL] the canonical data -> format composite declares no shape its own tasks produce (activity-api accepts it)", () => {
    const tasks: T[] = [
      { input_shapes: [], output_shapes: ["tidepool_species_rows"] },
      { input_shapes: ["tidepool_species_rows"], output_shapes: ["tidepoolCensusCard"] }, // the wiring adds the upstream output
    ];
    const declared = composedTemplateInputs(tasks);
    expect(selfSatisfied(declared, tasks)).toEqual([]);
    expect(declared).toEqual([]);
  });

  it("[MUST-FAIL] a shape consumed early and produced later in the same composition is not an external precondition either", () => {
    const tasks: T[] = [{ input_shapes: ["b"], output_shapes: ["a"] }, { input_shapes: ["a"], output_shapes: ["b"] }];
    expect(selfSatisfied(composedTemplateInputs(tasks), tasks)).toEqual([]);
  });

  it("[CONTROL] a one-task composition keeps its external input (unchanged behaviour)", () => {
    expect(composedTemplateInputs([{ input_shapes: ["fileContent"], output_shapes: ["report"] }])).toEqual(["fileContent"]);
  });

  it("[MUST-FAIL] a genuinely external input is kept, once, beside an internal one that is dropped", () => {
    const tasks: T[] = [
      { input_shapes: ["fileContent"], output_shapes: ["rows"] },
      { input_shapes: ["rows", "fileContent"], output_shapes: ["report"] },
    ];
    expect(composedTemplateInputs(tasks)).toEqual(["fileContent"]);
  });

  it("[WIRING] the minted template's input_shapes and inputShapes both come from composedTemplateInputs", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "author-composed-capability.ts"), "utf8");
    expect(src).toContain("input_shapes: composedTemplateInputs(plan.tasks),");
    expect(src).toContain("inputShapes: composedTemplateInputs(plan.tasks),");
    expect(src).not.toContain("input_shapes: [...new Set(plan.tasks.flatMap((t) => t.input_shapes ?? []))],");
  });
});
