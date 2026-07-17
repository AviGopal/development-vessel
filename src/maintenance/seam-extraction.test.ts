/** Round-trip: propose (deterministic) → apply (mechanical) → verify-parity PASS. */
import { describe, expect, test } from "bun:test";
import { Project, ts } from "ts-morph";
import { captureBaseline, verifyParity } from "./parity-gate";
import { applySeamExtraction, proposeSeamExtraction } from "./seam-extraction";

const LOOSE_BAG = `import { readFileSync } from "node:fs";

export function handlerA(x: string): string {
  return helpA(x) + "!";
}

function helpA(x: string): string {
  return x.toUpperCase();
}

export function handlerB(n: number): number {
  return helpB(n) * 2;
}

function helpB(n: number): number {
  return n + 1;
}

export const CONFIG = { retries: 3 };
`;

function makeProject(): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true,
    },
  });
  project.createSourceFile("/src/routes/bag.ts", LOOSE_BAG);
  return project;
}

describe("seam extraction round-trip", () => {
  test("propose finds a closed cluster; apply + gate = PASS", async () => {
    const project = makeProject();
    const seam = proposeSeamExtraction(project, "/src/routes/bag.ts", { minLines: 4, maxShare: 0.6 });
    expect(seam).not.toBeNull();
    // cluster is private-dependency closed: a handler always drags its helper
    for (const s of seam!.symbols) {
      expect(["handlerA", "helpA", "handlerB", "helpB"]).toContain(s);
    }
    const baseline = captureBaseline(project, "/src/routes/bag.ts");
    applySeamExtraction(project, seam!);
    const v = await verifyParity(project, baseline, seam!.targetModule);
    expect(v.failReason).toBeUndefined();
    expect(v.verdict).toBeTrue();
  });

  test("apply refuses a non-sibling target (relative-import safety)", () => {
    const project = makeProject();
    expect(() =>
      applySeamExtraction(project, {
        file: "/src/routes/bag.ts",
        symbols: ["helpA"],
        targetModule: "/src/other/bag.helpers.ts",
        rationale: "x",
      }),
    ).toThrow(/SIBLING/);
  });

  test("explicit seam: moving an exported handler + its private helper PASSes", async () => {
    const project = makeProject();
    const baseline = captureBaseline(project, "/src/routes/bag.ts");
    applySeamExtraction(project, {
      file: "/src/routes/bag.ts",
      symbols: ["handlerB", "helpB"],
      targetModule: "/src/routes/bag.handler-b.ts",
      rationale: "cohesive pair",
    });
    const v = await verifyParity(project, baseline, "/src/routes/bag.handler-b.ts");
    expect(v.failReason).toBeUndefined();
    expect(v.verdict).toBeTrue();
  });
});
